import { ASSET_CLASS, SECURITY_PROVIDER } from '@bt/shared/types/investments';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { toProviderSymbol } from './base-provider';

// `mock`-prefixed so jest's hoisted `jest.mock` factory may reference it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGet = jest.fn<(url: string, config?: unknown) => Promise<any>>();

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => ({ get: mockGet })) },
  isAxiosError: jest.fn(() => false),
}));

// Imported after the mock so the provider's constructor picks up the stub.
import { BinanceDataProvider } from './binance-provider';

describe('BinanceDataProvider', () => {
  const provider = new BinanceDataProvider();

  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('searchSecurities', () => {
    it('returns exact base-asset matches before partial ones, USDT pairs only', async () => {
      mockGet.mockResolvedValue({
        data: {
          symbols: [
            { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING' },
            { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING' },
            { symbol: 'BTCBUSD', baseAsset: 'BTC', quoteAsset: 'BUSD', status: 'TRADING' },
            { symbol: 'BTCDOMUSDT', baseAsset: 'BTCDOM', quoteAsset: 'USDT', status: 'TRADING' },
            { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'BREAK' },
          ],
        },
      });

      const results = await provider.searchSecurities('btc');

      expect(mockGet).toHaveBeenCalledWith('/api/v3/exchangeInfo');
      expect(results[0]).toMatchObject({
        symbol: 'BTC',
        providerSymbol: 'BTCUSDT',
        assetClass: ASSET_CLASS.crypto,
        providerName: SECURITY_PROVIDER.binance,
        currencyCode: 'USD',
        cryptoCurrencyCode: 'BTC',
        matchType: 'exact',
      });
      // BTCDOM only matches partially and BUSD/BREAK rows are excluded.
      expect(results.map((r) => r.providerSymbol)).toEqual(['BTCUSDT', 'BTCDOMUSDT']);
      expect(results[1]?.matchType).toBe('partial');
    });

    it('returns an empty list for an empty query without calling the API', async () => {
      const results = await provider.searchSecurities('   ');
      expect(results).toEqual([]);
      expect(mockGet).not.toHaveBeenCalled();
    });
  });

  describe('getLatestPrice', () => {
    it('maps the ticker price to a USD PriceData row', async () => {
      mockGet.mockResolvedValue({ data: { symbol: 'BTCUSDT', price: '67123.45' } });

      const price = await provider.getLatestPrice(toProviderSymbol('BTCUSDT'));

      expect(mockGet).toHaveBeenCalledWith('/api/v3/ticker/price', { params: { symbol: 'BTCUSDT' } });
      expect(price.priceClose).toBeCloseTo(67123.45, 2);
      expect(price.providerName).toBe(SECURITY_PROVIDER.binance);
      expect(price.priceAsOf).toBeInstanceOf(Date);
    });

    it('throws a formatted provider error when the price is not parseable', async () => {
      mockGet.mockResolvedValue({ data: { symbol: 'FOOUSDT', price: '' } });

      await expect(provider.getLatestPrice(toProviderSymbol('FOOUSDT'))).rejects.toThrow(/Binance/);
    });
  });

  describe('getHistoricalPrices', () => {
    it('maps daily klines to chronological PriceData rows', async () => {
      mockGet.mockResolvedValue({
        data: [
          [1_700_000_000_000, '100', '110', '90', '105', '10', 1_700_086_399_999],
          [1_700_086_400_000, '105', '115', '100', '112', '12', 1_700_172_799_999],
        ],
      });

      const prices = await provider.getHistoricalPrices(toProviderSymbol('ETHUSDT'), {
        startDate: new Date('2023-11-14T00:00:00Z'),
        endDate: new Date('2023-11-17T00:00:00Z'),
      });

      expect(mockGet).toHaveBeenCalledWith('/api/v3/klines', {
        params: expect.objectContaining({ symbol: 'ETHUSDT', interval: '1d' }),
      });
      expect(prices).toHaveLength(2);
      expect(prices[0]?.priceClose).toBeCloseTo(105, 8);
      expect(prices[1]?.priceClose).toBeCloseTo(112, 8);
    });
  });

  describe('fetchPricesForSecurities', () => {
    it('echoes securityId from the matching input and ignores non-crypto securities', async () => {
      mockGet.mockResolvedValue({
        data: [
          { symbol: 'BTCUSDT', price: '67000' },
          { symbol: 'ETHUSDT', price: '3500' },
        ],
      });

      const forDate = new Date();
      const result = await provider.fetchPricesForSecurities(
        [
          {
            securityId: 'sec-btc',
            symbol: 'BTC',
            providerSymbol: toProviderSymbol('BTCUSDT'),
            assetClass: ASSET_CLASS.crypto,
          },
          {
            securityId: 'sec-stock',
            symbol: 'AAPL',
            providerSymbol: toProviderSymbol('AAPL'),
            assetClass: ASSET_CLASS.stocks,
          },
        ],
        forDate,
      );

      expect(mockGet).toHaveBeenCalledWith('/api/v3/ticker/price');
      expect(result.size).toBe(1);
      expect(result.get('sec-btc')?.[0]).toMatchObject({
        securityId: 'sec-btc',
        priceClose: 67000,
        providerName: SECURITY_PROVIDER.binance,
      });
    });
  });
});
