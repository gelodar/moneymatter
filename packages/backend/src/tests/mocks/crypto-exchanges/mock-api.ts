import { HttpResponse, http } from 'msw';

const BINANCE_API = 'https://api.binance.com';
const BYBIT_API = 'https://api.bybit.com';

const BTC_PRICE = '67000.50';
const ETH_PRICE = '3500.25';

/**
 * Keyless spot-exchange mocks for e2e tests. The composite provider fans out
 * to Binance/Bybit on every crypto search and bulk price sync, so without
 * these handlers tests would hit the live APIs (msw is configured with
 * `onUnhandledRequest: 'bypass'`).
 */
export const cryptoExchangeHandlers = [
  // --- Binance ---
  http.get(`${BINANCE_API}/api/v3/exchangeInfo`, () =>
    HttpResponse.json({
      symbols: [
        { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING' },
        { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING' },
        { symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT', status: 'TRADING' },
        { symbol: 'BTCBUSD', baseAsset: 'BTC', quoteAsset: 'BUSD', status: 'TRADING' },
      ],
    }),
  ),
  http.get(`${BINANCE_API}/api/v3/ticker/price`, ({ request }) => {
    const url = new URL(request.url);
    const symbol = url.searchParams.get('symbol');
    if (symbol) {
      if (symbol === 'BTCUSDT') return HttpResponse.json({ symbol, price: BTC_PRICE });
      if (symbol === 'ETHUSDT') return HttpResponse.json({ symbol, price: ETH_PRICE });
      return HttpResponse.json({ code: -1121, msg: `Invalid symbol ${symbol}` }, { status: 400 });
    }
    return HttpResponse.json([
      { symbol: 'BTCUSDT', price: BTC_PRICE },
      { symbol: 'ETHUSDT', price: ETH_PRICE },
      { symbol: 'SOLUSDT', price: '150.10' },
    ]);
  }),
  http.get(`${BINANCE_API}/api/v3/klines`, ({ request }) => {
    const url = new URL(request.url);
    const symbol = url.searchParams.get('symbol');
    if (symbol !== 'BTCUSDT' && symbol !== 'ETHUSDT') {
      return HttpResponse.json({ code: -1121, msg: `Invalid symbol ${symbol}` }, { status: 400 });
    }
    const start = Number(url.searchParams.get('startTime'));
    const end = Number(url.searchParams.get('endTime'));
    const dayMs = 24 * 60 * 60 * 1000;
    const klines: unknown[] = [];
    for (let t = Math.floor(start / dayMs) * dayMs; t <= end && klines.length < 1000; t += dayMs) {
      klines.push([t, '100', '110', '90', '105', '10', t + dayMs - 1]);
    }
    return HttpResponse.json(klines);
  }),

  // --- Bybit ---
  http.get(`${BYBIT_API}/v5/market/instruments-info`, () =>
    HttpResponse.json({
      retCode: 0,
      result: {
        list: [
          { symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', status: 'Trading' },
          { symbol: 'ETHUSDT', baseCoin: 'ETH', quoteCoin: 'USDT', status: 'Trading' },
          { symbol: 'SOLUSDT', baseCoin: 'SOL', quoteCoin: 'USDT', status: 'Trading' },
        ],
      },
    }),
  ),
  http.get(`${BYBIT_API}/v5/market/tickers`, ({ request }) => {
    const url = new URL(request.url);
    const symbol = url.searchParams.get('symbol');
    const list =
      symbol === 'BTCUSDT'
        ? [{ symbol: 'BTCUSDT', lastPrice: BTC_PRICE }]
        : symbol === 'ETHUSDT'
          ? [{ symbol: 'ETHUSDT', lastPrice: ETH_PRICE }]
          : symbol
            ? []
            : [
                { symbol: 'BTCUSDT', lastPrice: BTC_PRICE },
                { symbol: 'ETHUSDT', lastPrice: ETH_PRICE },
                { symbol: 'SOLUSDT', lastPrice: '150.10' },
              ];
    return HttpResponse.json({ retCode: 0, result: { list } });
  }),
  http.get(`${BYBIT_API}/v5/market/kline`, ({ request }) => {
    const url = new URL(request.url);
    const symbol = url.searchParams.get('symbol');
    if (symbol !== 'BTCUSDT' && symbol !== 'ETHUSDT') {
      return HttpResponse.json({ retCode: 10003, retMsg: `symbol not found ${symbol}` }, { status: 400 });
    }
    const start = Number(url.searchParams.get('start'));
    const end = Number(url.searchParams.get('end'));
    const dayMs = 24 * 60 * 60 * 1000;
    // Bybit returns klines newest-first.
    const list: unknown[] = [];
    for (let t = Math.floor(end / dayMs) * dayMs; t >= start && list.length < 1000; t -= dayMs) {
      list.push([String(t), '100', '110', '90', '105', '10', '1050000']);
    }
    return HttpResponse.json({ retCode: 0, result: { list } });
  }),
];
