import { useQuery } from '@tanstack/react-query';

/**
 * Live USD tickers for the coins behind the "Built With" logos (RAY, SOL,
 * SWTCH). Sourced from CoinGecko's public simple/price endpoint — keyless and
 * CORS-enabled, so the fetch runs straight from the browser. CoinMarketCap
 * (the link target) has no unauthenticated price API, so prices come from
 * CoinGecko while the links point at CMC.
 */

export type CoinTickerId = 'raydium' | 'solana';

export interface CoinTickerQuote {
    priceUsd: number;
    change24hPct: number;
}

export type CoinTickerQuotes = Record<CoinTickerId, CoinTickerQuote>;

const COINGECKO_IDS = ['raydium', 'solana'] as const;

const PRICE_URL =
    'https://api.coingecko.com/api/v3/simple/price' +
    `?ids=${COINGECKO_IDS.join('%2C')}` +
    '&vs_currencies=usd&include_24hr_change=true';

interface CoinGeckoSimplePriceResponse {
    [id: string]: {
        usd?: number;
        usd_24h_change?: number | null;
    };
}

async function fetchCoinTickers(): Promise<CoinTickerQuotes> {
    const res = await fetch(PRICE_URL, { headers: { accept: 'application/json' } });
    if (!res.ok) {
        throw new Error(`CoinGecko price request failed: ${res.status}`);
    }
    const body = (await res.json()) as CoinGeckoSimplePriceResponse;

    const quotes = {} as CoinTickerQuotes;
    for (const id of COINGECKO_IDS) {
        const entry = body[id];
        if (typeof entry?.usd === 'number') {
            quotes[id] = {
                priceUsd: entry.usd,
                change24hPct:
                    typeof entry.usd_24h_change === 'number' ? entry.usd_24h_change : 0,
            };
        }
    }
    return quotes;
}

export function useCoinTickers() {
    return useQuery({
        queryKey: ['coin-tickers'],
        queryFn: fetchCoinTickers,
        // Prices drift slowly; one fresh read every couple of minutes is plenty
        // for a footer-style ticker and keeps well inside CoinGecko's free
        // rate limits.
        staleTime: 60_000,
        refetchInterval: 120_000,
        retry: 3,
    });
}
