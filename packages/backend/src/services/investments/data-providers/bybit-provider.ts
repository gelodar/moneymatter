import { ASSET_CLASS, SECURITY_PROVIDER, SecuritySearchResult } from '@bt/shared/types/investments';
import { logger } from '@js/utils';
import axios, { AxiosInstance } from 'axios';
import { subYears } from 'date-fns';

import {
  BaseSecurityDataProvider,
  BulkPriceData,
  HistoricalPriceOptions,
  PriceData,
  ProviderSymbol,
  SecurityPriceFetchInput,
  toProviderSymbol,
} from './base-provider';

const BYBIT_API_BASE_URL = 'https://api.bybit.com';
const DEFAULT_TIMEOUT_MS = 10_000;
/** Cap exact-symbol matches returned to the UI. */
const SEARCH_EXACT_LIMIT = 5;
/** Cap partial (substring) matches returned to the UI. */
const SEARCH_PARTIAL_LIMIT = 10;
/**
 * Bybit serves klines max 1000 per request; at `D` (daily) that is ~2.7
 * years, comfortably covering the crypto backfill window.
 */
const KLINES_LIMIT = 1000;
/**
 * All prices are quoted against USDT (1:1 USD-pegged). We store them as USD,
 * consistent with the CoinGecko/Binance paths, so the existing ref-currency
 * conversion pipeline handles the user's display currency.
 */
const QUOTE_ASSET = 'USDT';
const DEFAULT_HISTORY_YEARS = 2;
/** instruments-info changes rarely; cache the symbol list for an hour. */
const INSTRUMENTS_CACHE_TTL_MS = 60 * 60 * 1000;

interface BybitInstrument {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
  status: string;
}

interface BybitTicker {
  symbol: string;
  lastPrice: string;
}

// [startTime, open, high, low, close, volume, turnover] — returned newest-first
type BybitKline = [string, string, string, string, string, string, string];

export class BybitDataProvider extends BaseSecurityDataProvider {
  readonly providerName = SECURITY_PROVIDER.bybit;
  private client: AxiosInstance;
  private instrumentsCache: { instruments: BybitInstrument[]; fetchedAt: number } | null = null;

  constructor() {
    super();
    this.client = axios.create({ baseURL: BYBIT_API_BASE_URL, timeout: DEFAULT_TIMEOUT_MS });
  }

  /**
   * `/v5/market/instruments-info?category=spot` lists every spot instrument.
   * We keep only active USDT-quoted pairs (the deepest USD-stable liquidity)
   * and match the user's query against the base coin ("BTC") or the full
   * pair ("BTCUSDT").
   */
  public async searchSecurities(query: string): Promise<SecuritySearchResult[]> {
    if (!query.trim()) return [];

    try {
      const instruments = await this.getTradingUsdtInstruments();
      const upperQuery = query.trim().toUpperCase();

      const exact: BybitInstrument[] = [];
      const partial: BybitInstrument[] = [];
      for (const i of instruments) {
        if (i.baseCoin === upperQuery || i.symbol === upperQuery) {
          exact.push(i);
        } else if (i.baseCoin.includes(upperQuery)) {
          partial.push(i);
        }
      }

      const mapInstrument = (i: BybitInstrument, matchType: 'exact' | 'partial'): SecuritySearchResult => ({
        symbol: i.baseCoin,
        providerSymbol: i.symbol,
        name: i.baseCoin,
        assetClass: ASSET_CLASS.crypto,
        providerName: this.providerName,
        exchangeName: 'Bybit',
        exchangeAcronym: 'Bybit',
        exchangeMic: undefined,
        currencyCode: 'USD',
        cryptoCurrencyCode: i.baseCoin,
        logoUrl: null,
        matchType,
      });

      return [
        ...exact.slice(0, SEARCH_EXACT_LIMIT).map((i) => mapInstrument(i, 'exact')),
        ...partial.slice(0, SEARCH_PARTIAL_LIMIT).map((i) => mapInstrument(i, 'partial')),
      ];
    } catch (error) {
      logger.error({ message: `Bybit search failed for "${query}"`, error: error as Error });
      return [];
    }
  }

  public async getLatestPrice(providerSymbol: ProviderSymbol): Promise<PriceData> {
    try {
      const { data } = await this.client.get<{ result?: { list?: BybitTicker[] } }>('/v5/market/tickers', {
        params: { category: 'spot', symbol: providerSymbol },
      });

      const ticker = data.result?.list?.[0];
      const priceClose = ticker ? Number.parseFloat(ticker.lastPrice) : Number.NaN;
      if (!ticker || !Number.isFinite(priceClose)) {
        throw new Error(`No price data returned for ${providerSymbol}`);
      }

      const priceAsOf = new Date();
      return {
        providerSymbol,
        date: priceAsOf,
        priceClose,
        priceAsOf,
        providerName: this.providerName,
      };
    } catch (error) {
      throw this.formatProviderError({ operation: `Failed to fetch Bybit price for ${providerSymbol}`, error });
    }
  }

  public async getHistoricalPrices(
    providerSymbol: ProviderSymbol,
    options?: HistoricalPriceOptions,
  ): Promise<PriceData[]> {
    try {
      const endDate = options?.endDate ?? new Date();
      const startDate = options?.startDate ?? subYears(endDate, DEFAULT_HISTORY_YEARS);
      if (startDate >= endDate) return [];

      const { data } = await this.client.get<{ result?: { list?: BybitKline[] } }>('/v5/market/kline', {
        params: {
          category: 'spot',
          symbol: providerSymbol,
          interval: 'D',
          start: startDate.getTime(),
          end: endDate.getTime(),
          limit: KLINES_LIMIT,
        },
      });

      // Bybit returns klines newest-first; reverse to chronological order.
      return (data.result?.list ?? [])
        .slice()
        .reverse()
        .filter((k) => Array.isArray(k) && k.length >= 5 && k[4] !== '')
        .map((k) => {
          const date = new Date(Number(k[0]));
          return {
            providerSymbol,
            date,
            priceClose: Number.parseFloat(k[4]),
            priceAsOf: date,
            providerName: this.providerName,
          };
        });
    } catch (error) {
      throw this.formatProviderError({
        operation: `Failed to fetch Bybit historical prices for ${providerSymbol}`,
        error,
      });
    }
  }

  /**
   * `/v5/market/tickers?category=spot` without a symbol returns every spot
   * ticker in one call, so the whole crypto batch is a single request. Each
   * returned row carries `securityId` echoed from the matching input.
   */
  public async fetchPricesForSecurities(
    securities: SecurityPriceFetchInput[],
    forDate: Date,
  ): Promise<Map<string, BulkPriceData[]>> {
    const result = new Map<string, BulkPriceData[]>();
    const cryptoOnly = securities.filter((s) => s.assetClass === ASSET_CLASS.crypto);
    if (cryptoOnly.length === 0) return result;

    const inputsByPair = new Map(cryptoOnly.map((s) => [s.providerSymbol.toUpperCase(), s]));

    try {
      const { data } = await this.client.get<{ result?: { list?: BybitTicker[] } }>('/v5/market/tickers', {
        params: { category: 'spot' },
      });
      const priceAsOf = new Date();

      for (const ticker of data.result?.list ?? []) {
        const input = inputsByPair.get(ticker.symbol.toUpperCase());
        if (!input) continue;
        const priceClose = Number.parseFloat(ticker.lastPrice);
        if (!Number.isFinite(priceClose)) {
          logger.warn(`Bybit returned no parseable price for ${ticker.symbol} in batch fetch`);
          continue;
        }
        result.set(input.securityId, [
          {
            providerSymbol: toProviderSymbol(ticker.symbol),
            date: forDate,
            priceClose,
            priceAsOf,
            providerName: this.providerName,
            securityId: input.securityId,
          },
        ]);
      }
    } catch (error) {
      logger.error({ message: 'Bybit batch fetch failed', error: error as Error });
    }

    logger.info(`Bybit fetch complete: ${result.size}/${cryptoOnly.length} prices fetched`);
    return result;
  }

  private async getTradingUsdtInstruments(): Promise<BybitInstrument[]> {
    if (this.instrumentsCache && Date.now() - this.instrumentsCache.fetchedAt < INSTRUMENTS_CACHE_TTL_MS) {
      return this.instrumentsCache.instruments;
    }

    const { data } = await this.client.get<{ result?: { list?: BybitInstrument[] } }>(
      '/v5/market/instruments-info',
      { params: { category: 'spot', limit: 1000 } },
    );
    const instruments = (data.result?.list ?? []).filter(
      (i) => i.status === 'Trading' && i.quoteCoin === QUOTE_ASSET,
    );
    this.instrumentsCache = { instruments, fetchedAt: Date.now() };
    return instruments;
  }
}
