/**
 * Pure helper functions for classifying symbols and determining
 * which data provider is best suited for different operations
 */
import { SECURITY_PROVIDER } from '@bt/shared/types';
import { ASSET_CLASS } from '@bt/shared/types/investments';

type ExchangeRegion = 'US' | 'EU' | 'GLOBAL';

/**
 * Determines if a symbol is likely a US-traded security
 * US symbols are typically 1-5 letters, no special characters
 */
function isUSSymbol(symbol: string): boolean {
  const cleanSymbol = symbol.trim().toUpperCase();

  // US symbols are typically 1-5 letters, no special chars
  // Examples: AAPL, MSFT, GOOGL, BRK.A (some have dots)
  return /^[A-Z]{1,5}(\.[A-Z])?$/.test(cleanSymbol);
}

/**
 * Determines if a symbol is likely European-traded
 * European symbols often have extensions like .L, .PA, .DE
 */
function isEuropeanSymbol(symbol: string): boolean {
  const cleanSymbol = symbol.trim().toUpperCase();

  // Common European exchange suffixes
  const europeanSuffixes = ['.L', '.PA', '.DE', '.MI', '.AS', '.ASM', '.SW', '.ST', '.HE', '.OL', '.IC'];

  return europeanSuffixes.some((suffix) => cleanSymbol.endsWith(suffix));
}

/**
 * Gets the likely exchange region for a symbol
 */
function getExchangeRegion(symbol: string): ExchangeRegion {
  if (isUSSymbol(symbol)) {
    return 'US';
  }

  if (isEuropeanSymbol(symbol)) {
    return 'EU';
  }

  return 'GLOBAL';
}

/**
 * Gets provider preference for search operations
 */
export function getSearchProviderPreference(): {
  primary: SECURITY_PROVIDER;
  fallbacks: SECURITY_PROVIDER[];
} {
  return {
    primary: SECURITY_PROVIDER.yahoo,
    fallbacks: [SECURITY_PROVIDER.fmp],
  };
}

/**
 * Crypto search routing. Keyless exchanges first (no API key needed), then
 * CoinGecko when configured — its coin metadata (logos, market-cap rank) is
 * richer, so its results are kept and de-duplicated by the composite.
 */
export function getCryptoSearchProviders(): SECURITY_PROVIDER[] {
  return [...CRYPTO_PROVIDER_CHAIN];
}

/**
 * Crypto price routing. Keyless spot exchanges (Binance, then Bybit) are the
 * default so self-hosters get crypto prices with no API key at all. CoinGecko
 * (when COINGECKO_API_KEY is set) is appended last: it covers coins that are
 * not listed on either exchange and provides the coin logos/market-cap ranks
 * the search UI shows, but its free tier is rate-limited, so it must not be
 * the primary price source.
 *
 * `assetClass: ASSET_CLASS.crypto` short-circuits here regardless of symbol
 * shape (exchange pairs like "BTCUSDT" and CoinGecko slugs like "bitcoin"
 * don't fit any region regex).
 */
const CRYPTO_PROVIDER_CHAIN: SECURITY_PROVIDER[] = [
  SECURITY_PROVIDER.binance,
  SECURITY_PROVIDER.bybit,
  SECURITY_PROVIDER.coingecko,
];

export function getHistoricalPriceProviderPreference(
  symbol: string,
  assetClass?: ASSET_CLASS,
  providerName?: SECURITY_PROVIDER,
): {
  primary: SECURITY_PROVIDER;
  fallbacks: SECURITY_PROVIDER[];
} {
  if (assetClass === ASSET_CLASS.crypto) {
    // A row created under a specific crypto provider keeps that provider as
    // primary: e.g. a CoinGecko row's providerSymbol is a slug ("bitcoin")
    // the keyless exchanges can't resolve. Unknown/unregistered names fall
    // back to the default chain (the composite skips unregistered providers).
    if (providerName && CRYPTO_PROVIDER_CHAIN.includes(providerName)) {
      const rest = CRYPTO_PROVIDER_CHAIN.filter((p) => p !== providerName);
      return { primary: providerName, fallbacks: rest };
    }
    return { primary: CRYPTO_PROVIDER_CHAIN[0]!, fallbacks: CRYPTO_PROVIDER_CHAIN.slice(1) };
  }

  const region = getExchangeRegion(symbol);

  if (region === 'US') {
    return {
      primary: SECURITY_PROVIDER.yahoo,
      fallbacks: [SECURITY_PROVIDER.polygon, SECURITY_PROVIDER.alphavantage],
    };
  }

  return {
    primary: SECURITY_PROVIDER.yahoo,
    fallbacks: [SECURITY_PROVIDER.alphavantage],
  };
}

/**
 * Gets provider preference for latest price operations.
 */
export function getLatestPriceProviderPreference(
  symbol: string,
  assetClass?: ASSET_CLASS,
  providerName?: SECURITY_PROVIDER,
): {
  primary: SECURITY_PROVIDER;
  fallbacks: SECURITY_PROVIDER[];
} {
  if (assetClass === ASSET_CLASS.crypto) {
    if (providerName && CRYPTO_PROVIDER_CHAIN.includes(providerName)) {
      const rest = CRYPTO_PROVIDER_CHAIN.filter((p) => p !== providerName);
      return { primary: providerName, fallbacks: rest };
    }
    return { primary: CRYPTO_PROVIDER_CHAIN[0]!, fallbacks: CRYPTO_PROVIDER_CHAIN.slice(1) };
  }

  const region = getExchangeRegion(symbol);

  if (region === 'US') {
    return {
      primary: SECURITY_PROVIDER.yahoo,
      fallbacks: [SECURITY_PROVIDER.polygon, SECURITY_PROVIDER.fmp, SECURITY_PROVIDER.alphavantage],
    };
  }

  return {
    primary: SECURITY_PROVIDER.yahoo,
    fallbacks: [SECURITY_PROVIDER.alphavantage, SECURITY_PROVIDER.fmp, SECURITY_PROVIDER.polygon],
  };
}
