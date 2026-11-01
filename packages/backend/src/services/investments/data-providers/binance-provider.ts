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

const BINANCE_API_BASE_URL = 'https://api.binance.com';
const DEFAULT_TIMEOUT_MS = 10_000;
/** Cap exact-symbol matches returned to the UI. */
const SEARCH_EXACT_LIMIT = 5;
/** Cap partial (substring) matches returned to the UI. */
const SEARCH_PARTIAL_LIMIT = 10;
/**
 * Binance serves klines max 1000 per request; at `1d` that is ~2.7 years,
 * comfortably covering the crypto backfill window.
 */
const KLINES_LIMIT = 1000;
/**
 * All prices are quoted against USDT (1:1 USD-pegged). We store them as USD,
 * consistent with the CoinGecko path, so the existing ref-currency conversion
 * pipeline handles the user's display currency.
 */
const QUOTE_ASSET = 'USDT';
const DEFAULT_HISTORY_YEARS = 2;
/** exchangeInfo changes rarely; cache the symbol list for an hour. */
const EXCHANGE_INFO_CACHE_TTL_MS = 60 * 60 * 1000;

interface BinanceExchangeSymbol {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
}

interface BinanceTickerPrice {
  symbol: string;
  price: string;
}

// [openTime, open, high, low, close, volume, closeTime, ...]
type BinanceKline = [number, string, string, string, string, string, number, ...unknown[]];

export class BinanceDataProvider extends BaseSecurityDataProvider {
  readonly providerName = SECURITY_PROVIDER.binance;
  private client: AxiosInstance;
  private exchangeInfoCache: { symbols: BinanceExchangeSymbol[]; fetchedAt: number } | null = null;

  constructor() {
    super();
    this.client = axios.create({ baseURL: BINANCE_API_BASE_URL, timeout: DEFAULT_TIMEOUT_MS });
  }

  /**
   * `/exchangeInfo` lists every spot pair. We keep only active USDT-quoted
   * pairs (the deepest USD-stable liquidity) and match the user's query
   * against the base asset ("BTC") or the full pair ("BTCUSDT").
   */
  public async searchSecurities(query: string): Promise<SecuritySearchResult[]> {
    if (!query.trim()) return [];

    try {
      const symbols = await this.getTradingUsdtSymbols();
      const upperQuery = query.trim().toUpperCase();

      const exact: BinanceExchangeSymbol[] = [];
      const partial: BinanceExchangeSymbol[] = [];
      for (const s of symbols) {
        if (s.baseAsset === upperQuery || s.symbol === upperQuery) {
          exact.push(s);
        } else if (s.baseAsset.includes(upperQuery)) {
          partial.push(s);
        }
      }

      const mapPair = (s: BinanceExchangeSymbol, matchType: 'exact' | 'partial'): SecuritySearchResult => ({
        symbol: s.baseAsset,
        providerSymbol: s.symbol,
        name: s.baseAsset,
        assetClass: ASSET_CLASS.crypto,
        providerName: this.providerName,
        exchangeName: 'Binance',
        exchangeAcronym: 'Binance',
        exchangeMic: undefined,
        currencyCode: 'USD',
        cryptoCurrencyCode: s.baseAsset,
        logoUrl: null,
        matchType,
      });

      return [
        ...exact.slice(0, SEARCH_EXACT_LIMIT).map((s) => mapPair(s, 'exact')),
        ...partial.slice(0, SEARCH_PARTIAL_LIMIT).map((s) => mapPair(s, 'partial')),
      ];
    } catch (error) {
      logger.error({ message: `Binance search failed for "${query}"`, error: error as Error });
      return [];
    }
  }

  public async getLatestPrice(providerSymbol: ProviderSymbol): Promise<PriceData> {
    try {
      const { data } = await this.client.get<BinanceTickerPrice>('/api/v3/ticker/price', {
        params: { symbol: providerSymbol },
      });

      const priceClose = Number.parseFloat(data.price);
      if (!Number.isFinite(priceClose)) {
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
      throw this.formatProviderError({ operation: `Failed to fetch Binance price for ${providerSymbol}`, error });
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

      const { data } = await this.client.get<BinanceKline[]>('/api/v3/klines', {
        params: {
          symbol: providerSymbol,
          interval: '1d',
          startTime: startDate.getTime(),
          endTime: endDate.getTime(),
          limit: KLINES_LIMIT,
        },
      });

      return (data ?? [])
        .filter((k) => Array.isArray(k) && k.length >= 5 && k[4] != null)
        .map((k) => {
          const date = new Date(Number(k[0]));
          return {
            providerSymbol,
            date,
            priceClose: Number.parseFloat(String(k[4])),
            priceAsOf: date,
            providerName: this.providerName,
          };
        });
    } catch (error) {
      throw this.formatProviderError({
        operation: `Failed to fetch Binance historical prices for ${providerSymbol}`,
        error,
      });
    }
  }

  /**
   * `/api/v3/ticker/price` without a symbol returns every spot ticker in one
   * call, so the whole crypto batch is a single request. Each returned row
   * carries `securityId` echoed from the matching input.
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
      const { data } = await this.client.get<BinanceTickerPrice[]>('/api/v3/ticker/price');
      const priceAsOf = new Date();

      for (const ticker of data ?? []) {
        const input = inputsByPair.get(ticker.symbol.toUpperCase());
        if (!input) continue;
        const priceClose = Number.parseFloat(ticker.price);
        if (!Number.isFinite(priceClose)) {
          logger.warn(`Binance returned no parseable price for ${ticker.symbol} in batch fetch`);
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
      logger.error({ message: 'Binance batch fetch failed', error: error as Error });
    }

    logger.info(`Binance fetch complete: ${result.size}/${cryptoOnly.length} prices fetched`);
    return result;
  }

  private async getTradingUsdtSymbols(): Promise<BinanceExchangeSymbol[]> {
    if (this.exchangeInfoCache && Date.now() - this.exchangeInfoCache.fetchedAt < EXCHANGE_INFO_CACHE_TTL_MS) {
      return this.exchangeInfoCache.symbols;
    }

    const { data } = await this.client.get<{ symbols?: BinanceExchangeSymbol[] }>('/api/v3/exchangeInfo');
    const symbols = (data.symbols ?? []).filter((s) => s.status === 'TRADING' && s.quoteAsset === QUOTE_ASSET);
    this.exchangeInfoCache = { symbols, fetchedAt: Date.now() };
    return symbols;
  }
}
