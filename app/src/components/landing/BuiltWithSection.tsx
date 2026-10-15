import { GlitchText } from '../GlitchText';
import { useCoinTickers } from '../../hooks/useCoinTickers';
import type { CoinTickerQuote } from '../../hooks/useCoinTickers';

const LOGOS = [
    {
        name: 'Raydium',
        symbol: 'RAY',
        src: '/raydium-logo-and-letters.svg',
        link: 'https://docs.raydium.io/',
        cmc: 'https://coinmarketcap.com/currencies/raydium/',
        coinGeckoId: 'raydium',
    },
    {
        name: 'Solana',
        symbol: 'SOL',
        src: '/solana-logo-and-letters.png',
        link: 'https://solana.com/docs',
        cmc: 'https://coinmarketcap.com/currencies/solana/',
        coinGeckoId: 'solana',
        // The chain tile doubles as the framework credit: Solana lockup
        // big, Anchor's badge riding under it with its own docs link.
        sub: { text: 'with Anchor', src: '/anchor-logo.png', link: 'https://www.anchor-lang.com/docs' },
    },
    {
        name: 'Squads',
        src: '/Logo White.svg',
        link: 'https://docs.squads.so/',
    },
    {
        name: 'Helius',
        src: '/helius-logo.png',
        link: 'https://docs.helius.dev/',
        // No public lockup asset exists (brand pages are parked stubs), so
        // the mark rides with a set-in-type nameplate instead.
        nameplate: true,
    },
] as const;

type Logo = (typeof LOGOS)[number];
type TickeredLogo = Extract<Logo, { coinGeckoId: string }>;

function formatTickerPrice(priceUsd: number): string {
    // Match precision to the coin's magnitude: sub-cent coins need
    // several decimals, whole dollars look cleaner with two.
    const decimals = priceUsd >= 1 ? 2 : priceUsd >= 0.01 ? 4 : priceUsd >= 0.0001 ? 6 : 8;
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    }).format(priceUsd);
}

function formatTickerChange(change24hPct: number): string {
    const sign = change24hPct > 0 ? '+' : '';
    return `${sign}${change24hPct.toFixed(2)}%`;
}

function CoinTicker({ logo, quote }: { logo: TickeredLogo; quote?: CoinTickerQuote }) {
    const direction = quote ? (quote.change24hPct >= 0 ? 'up' : 'down') : null;
    const directionLabel = direction === 'up' ? 'up' : direction === 'down' ? 'down' : '';

    return (
        <a
            href={logo.cmc}
            target="_blank"
            rel="noopener noreferrer"
            className={`built-with-ticker${direction ? ` built-with-ticker--${direction}` : ''}`}
            aria-label={
                quote
                    ? `${logo.name} (${logo.symbol}) ${formatTickerPrice(quote.priceUsd)}, ${directionLabel} ${formatTickerChange(quote.change24hPct)} in 24h on CoinMarketCap`
                    : `${logo.name} (${logo.symbol}) price on CoinMarketCap`
            }
        >
            <span className="built-with-ticker-symbol">{logo.symbol}</span>
            <span className="built-with-ticker-price">
                {quote ? formatTickerPrice(quote.priceUsd) : '—'}
            </span>
            <span className="built-with-ticker-arrow" aria-hidden="true">
                {direction === 'up' ? '▲' : direction === 'down' ? '▼' : ''}
            </span>
            <span className="built-with-ticker-pct">
                {quote ? formatTickerChange(quote.change24hPct) : '—'}
            </span>
        </a>
    );
}

export function BuiltWithSection() {
    const { data: quotes } = useCoinTickers();

    return (
        <section className="landing-section">
            <div className="landing-section-inner">
                <h2 className="section-title"><GlitchText text="Built With" variant="ghost" /></h2>
                <div className="built-with-grid">
                    {/* Two fixed pairs — the responsive flips are pure flex
                        direction changes (see components.css), never wrap. */}
                    {[LOGOS.slice(0, 2), LOGOS.slice(2, 4)].map((pair, pairIndex) => (
                        <div className="built-with-pair" key={pairIndex}>
                            {pair.map((logo, index) => {
                                const i = pairIndex * 2 + index;
                                return (
                                    <div
                                        key={logo.name}
                                        className={`built-with-tile neon-glitch neon-shadow glass-pane ${['glitch-streetlight', 'glitch-shift', 'glitch-rose', 'glitch-streetlight'][i]} ${['shadow-under', 'shadow-corner-tl', 'shadow-corner-br', 'shadow-corner-tl'][i]}`}
                                        style={{
                                            '--glitch-delay': `${(i * 0.9).toFixed(2)}s`,
                                            '--shadow-delay': `${(i * 1.1 + 0.2).toFixed(2)}s`,
                                        } as React.CSSProperties}
                                    >
                                        {/* Stretched docs link: the whole tile links to the
                                            docs, while the ticker anchor stacks above it so
                                            the numbers keep their own CoinMarketCap link. */}
                                        <a
                                            href={logo.link}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="built-with-docs-link"
                                            aria-label={`${logo.name} documentation`}
                                        />
                                        {'nameplate' in logo && logo.nameplate ? (
                                            <span className="built-with-nameplate">
                                                <img
                                                    src={logo.src}
                                                    alt={`${logo.name} logo`}
                                                    className="built-with-logo built-with-logo--mark"
                                                    loading="lazy"
                                                />
                                                <span className="built-with-name">{logo.name}</span>
                                            </span>
                                        ) : (
                                            <img
                                                src={logo.src}
                                                alt={`${logo.name} logo`}
                                                className="built-with-logo"
                                                loading="lazy"
                                            />
                                        )}
                                        {'sub' in logo && logo.sub && (
                                            <a
                                                className="built-with-sub"
                                                href={logo.sub.link}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                aria-label="Anchor documentation"
                                            >
                                                <img
                                                    src={logo.sub.src}
                                                    alt=""
                                                    className="built-with-sub-logo"
                                                    loading="lazy"
                                                />
                                                {logo.sub.text}
                                            </a>
                                        )}
                                        {'coinGeckoId' in logo ? (
                                            <CoinTicker logo={logo} quote={quotes?.[logo.coinGeckoId]} />
                                        ) : null}
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
