import { ASSET_CLASS, SECURITY_PROVIDER } from '@bt/shared/types/investments';
import { describe, expect, it } from '@jest/globals';

import {
  getCryptoSearchProviders,
  getHistoricalPriceProviderPreference,
  getLatestPriceProviderPreference,
} from './symbol-classification';

describe('crypto provider routing (keyless exchanges first)', () => {
  it('routes crypto prices to Binance first, then Bybit, then CoinGecko', () => {
    const historical = getHistoricalPriceProviderPreference('BTCUSDT', ASSET_CLASS.crypto);
    expect(historical.primary).toBe(SECURITY_PROVIDER.binance);
    expect(historical.fallbacks).toEqual([SECURITY_PROVIDER.bybit, SECURITY_PROVIDER.coingecko]);

    const latest = getLatestPriceProviderPreference('BTCUSDT', ASSET_CLASS.crypto);
    expect(latest.primary).toBe(SECURITY_PROVIDER.binance);
    expect(latest.fallbacks).toEqual([SECURITY_PROVIDER.bybit, SECURITY_PROVIDER.coingecko]);
  });

  it('keeps the row-own provider as primary for existing crypto rows (slug symbols)', () => {
    // A CoinGecko-created row stores the slug ("bitcoin") as providerSymbol;
    // the keyless exchanges can't resolve slugs, so the row's provider wins.
    const preference = getHistoricalPriceProviderPreference('bitcoin', ASSET_CLASS.crypto, SECURITY_PROVIDER.coingecko);
    expect(preference.primary).toBe(SECURITY_PROVIDER.coingecko);
    expect(preference.fallbacks).toEqual([SECURITY_PROVIDER.binance, SECURITY_PROVIDER.bybit]);
  });

  it('falls back to the default chain for unknown provider names', () => {
    const preference = getHistoricalPriceProviderPreference('BTCUSDT', ASSET_CLASS.crypto, SECURITY_PROVIDER.yahoo);
    expect(preference.primary).toBe(SECURITY_PROVIDER.binance);
  });

  it('exposes the crypto search provider list keyless-first', () => {
    expect(getCryptoSearchProviders()).toEqual([
      SECURITY_PROVIDER.binance,
      SECURITY_PROVIDER.bybit,
      SECURITY_PROVIDER.coingecko,
    ]);
  });

  it('leaves stock routing untouched', () => {
    const us = getLatestPriceProviderPreference('AAPL', ASSET_CLASS.stocks);
    expect(us.primary).toBe(SECURITY_PROVIDER.yahoo);

    const eu = getHistoricalPriceProviderPreference('NESN.SW', ASSET_CLASS.stocks);
    expect(eu.primary).toBe(SECURITY_PROVIDER.yahoo);
  });
});
