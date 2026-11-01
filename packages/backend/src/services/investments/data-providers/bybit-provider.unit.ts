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
import { BybitDataProvider } from './bybit-provider';

describe('BybitDataProvider', () => {
  const provider = new BybitDataProvider();

  beforeEach(() => {
    mockGet.mockReset();
  });

  describe('searchSecurities', () => {
    it('returns exact base-coin matches before partial ones, USDT pairs only', async () => {
      mockGet.mockResolvedValue({
        data: {
          result: {
            list: [
              { symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', status: 'Trading' },
              { symbol: 'ETHUSDT', baseCoin: 'ETH', quoteCoin: 'USDT', status: 'Trading' },
              { symbol: 'BTCUSD', baseCoin: 'BTC', quoteCoin: 'USD', status: 'Trading' },
              { symbol: 'BTCDOMUSDT', baseCoin: 'BTCDOM', quoteCoin: 'USDT', status: 'Trading' },
            ],
          },
        },
      });

      const results = await provider.searchSecurities('btc');

      expect(mockGet).toHaveBeenCalledWith('/v5/market/instruments-info', {
        params: { category: 'spot', limit: 1000 },
      });
      expect(results[0]).toMatchObject({
        symbol: 'BTC',
        providerSymbol: 'BTCUSDT',
        assetClass: ASSET_CLASS.crypto,
        providerName: SECURITY_PROVIDER.bybit,
        currencyCode: 'USD',
        cryptoCurrencyCode: 'BTC',
        matchType: 'exact',
      });
      expect(results.map((r) => r.providerSymbol)).toEqual(['BTCUSDT', 'BTCDOMUSDT']);
      expect(results[1]?.matchType).toBe('partial');
    });
  });

  describe('getLatestPrice', () => {
    it('maps the spot ticker lastPrice to a USD PriceData row', async () => {
      mockGet.mockResolvedValue({ data: { result: { list: [{ symbol: 'BTCUSDT', lastPrice: '67123.45' }] } } });

      const price = await provider.getLatestPrice(toProviderSymbol('BTCUSDT'));

      expect(mockGet).toHaveBeenCalledWith('/v5/market/tickers', {
        params: { category: 'spot', symbol: 'BTCUSDT' },
      });
      expect(price.priceClose).toBeCloseTo(67123.45, 2);
      expect(price.providerName).toBe(SECURITY_PROVIDER.bybit);
    });

    it('throws a formatted provider error when no ticker row is returned', async () => {
      mockGet.mockResolvedValue({ data: { result: { list: [] } } });

      await expect(provider.getLatestPrice(toProviderSymbol('FOOUSDT'))).rejects.toThrow(/Bybit/);
    });
  });

  describe('getHistoricalPrices', () => {
    it('reverses newest-first klines into chronological PriceData rows', async () => {
      mockGet.mockResolvedValue({
        data: {
          result: {
            // Bybit returns newest first.
            list: [
              ['1700086400000', '105', '115', '100', '112', '12', '1344000'],
              ['1700000000000', '100', '110', '90', '105', '10', '1050000'],
            ],
          },
        },
      });

      const prices = await provider.getHistoricalPrices(toProviderSymbol('ETHUSDT'), {
        startDate: new Date('2023-11-14T00:00:00Z'),
        endDate: new Date('2023-11-17T00:00:00Z'),
      });

      expect(mockGet).toHaveBeenCalledWith('/v5/market/kline', {
        params: expect.objectContaining({ category: 'spot', symbol: 'ETHUSDT', interval: 'D' }),
      });
      expect(prices).toHaveLength(2);
      expect(prices[0]?.priceClose).toBeCloseTo(105, 8);
      expect(prices[1]?.priceClose).toBeCloseTo(112, 8);
    });
  });

  describe('fetchPricesForSecurities', () => {
    it('echoes securityId from the matching input', async () => {
      mockGet.mockResolvedValue({
        data: {
          result: {
            list: [
              { symbol: 'BTCUSDT', lastPrice: '67000' },
              { symbol: 'ETHUSDT', lastPrice: '3500' },
            ],
          },
        },
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
        ],
        forDate,
      );

      expect(mockGet).toHaveBeenCalledWith('/v5/market/tickers', { params: { category: 'spot' } });
      expect(result.get('sec-btc')?.[0]).toMatchObject({
        securityId: 'sec-btc',
        priceClose: 67000,
        providerName: SECURITY_PROVIDER.bybit,
      });
    });
  });
});
