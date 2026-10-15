import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { useChainData } from '../context/useChainData';
import { formatHeaderTickerPrice } from '../hooks/amm/offerMath';
import FlashNumber from './FlashNumber.tsx';
import './SiteNav.css';

/* Site nav — sits over the hero (and every page that includes it).
 * Full bar on wide screens; collapsible hamburger below the breakpoint.
 * Top level keeps only the actions (swap + socials); everything
 * informational lives under the Features dropdown: Litepaper, Bond Desk,
 * Locking Rewards, Freeze, Oracle Feed, Authority, Records. */

// TODO(mainnet): point these at the real accounts before launch.
export const SOCIAL_LINKS = {
    twitter: 'https://x.com/afhoio',
    telegram: 'https://t.me/afhoio',
};

type NavItem = {
    label: string;
    to: string;
};

/* Dropdown contents, in display order: Litepaper leads, then one link per
 * mechanic, Records (the ledger) and Activity (the personal tape) trail.
 * "Bond Desk" routes to the EXPLAINER (/bond-desk) — the live desk stays
 * at /offer-desk, reachable from the banner/indicator and the explainer's
 * CTA. */
const FEATURE_ITEMS: NavItem[] = [
    { label: 'Litepaper', to: '/litepaper' },
    { label: 'Bond Desk', to: '/bond-desk' },
    { label: 'Locking Rewards', to: '/locking' },
    { label: 'Freeze', to: '/freeze' },
    { label: 'Oracle Feed', to: '/oracle' },
    { label: 'Authority', to: '/authority' },
    { label: 'Records', to: '/records' },
    { label: 'Activity', to: '/activity' },
];

/* Deep link to Raydium's swap page with AFHO preselected as the output mint —
 * the mint in the URL is the disambiguator against same-named copycats. */
function raydiumSwapUrl(mint: PublicKey): string {
    return `https://raydium.io/swap/?inputMint=sol&outputMint=${mint.toBase58()}`;
}

function TwitterIcon() {
    return (
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
            <path
                fill="currentColor"
                d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
            />
        </svg>
    );
}

function TelegramIcon() {
    return (
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
            <path
                fill="currentColor"
                d="M21.944 3.112 2.72 10.558c-1.31.525-1.302 1.253-.24 1.578l4.928 1.537 1.862 5.704c.226.623.117.87.797.87.522 0 .754-.238 1.047-.524l2.514-2.444 5.228 3.862c.963.531 1.657.257 1.897-.894l3.44-16.223c.351-1.408-.538-2.045-1.459-1.63zM8.04 13.4l9.882-6.238c.513-.312.983-.144.598.198l-8.467 7.64-.331 3.538z"
            />
        </svg>
    );
}

interface SiteNavProps {
    /* Rendered in place of the brand text when provided (e.g. non-home
     * pages show a word-mark that links back). */
    brand?: ReactNode;
}

/* Live AFHO price from the pinned CPMM pool (floor units → USD), floating
 * left just to the right of the logo. Reads the shared chain-data snapshot,
 * so it refreshes with the same cadence as the rest of the app.
 *
 * The value is the SAME quantity offer_claim gates against: the pool's 10-minute
 * observation-ring TWAP, falling back to the instant vault ratio when the ring
 * is stale/sparse (no swap in ~10 min — the TWAP badge flips to "spot"). The
 * meta suffix shows which one is live and how many seconds since the snapshot
 * that produced it, so a rate-limited or dead-socket stretch is visible
 * instead of silently freezing the number. */
function HeaderTicker() {
    const { livePrice, livePriceUpdatedAt } = useChainData();
    const price = livePrice.afhoUsdc;
    const [nowMs, setNowMs] = useState(() => Date.now());
    useEffect(() => {
        // Age display tick — paused in background tabs.
        const id = window.setInterval(() => {
            if (!document.hidden) setNowMs(Date.now());
        }, 2000);
        return () => window.clearInterval(id);
    }, []);
    const ageSec = livePriceUpdatedAt ? Math.max(0, Math.round((nowMs - livePriceUpdatedAt) / 1000)) : null;
    const stale = price !== null && (ageSec === null || ageSec > 60);
    return (
        <span
            className={`site-nav-ticker${stale ? ' stale' : ''}`}
            title={
                'AFHO live price: the pinned pool\u2019s 10-minute TWAP (the quantity offer claims gate on), ' +
                'falling back to the instant pool ratio when the TWAP ring is stale or sparse'
            }
        >
            <span className="site-nav-ticker-symbol">AFHO</span>
            <span className="site-nav-ticker-price">
                <FlashNumber value={price !== null ? formatHeaderTickerPrice(price) : '—'} />
            </span>
            <span className="site-nav-ticker-meta" aria-hidden="true">
                {livePrice.afhoPriceIsTwap ? 'twap' : 'spot'} {ageSec === null ? '—' : `${ageSec}s`}
            </span>
        </span>
    );
}

export function SiteNav(_: SiteNavProps) {
    const [open, setOpen] = useState(false);
    const { pathname } = useLocation();
    const { deployment } = useChainData();
    const raydiumHref = deployment?.mintKey ? raydiumSwapUrl(deployment.mintKey) : null;

    // Close the drawer whenever the route changes.
    useEffect(() => {
        setOpen(false);
    }, [pathname]);

    const isActive = useMemo(
        () => (to: string) => pathname === to || pathname.startsWith(`${to}/`),
        [pathname],
    );

    // The dropdown toggle lights up when any page inside it is current.
    const featuresActive = FEATURE_ITEMS.some((item) => isActive(item.to));

    return (
        <nav className={`site-nav${open ? ' open' : ''}`} aria-label="Site">
            <div className="site-nav-bar">
                <div className="site-nav-brand-group">
                    <Link to="/" className="site-nav-brand neon-glitch" style={{ '--glitch-delay': '1.6s' } as React.CSSProperties}>
                        <img className="logo" src="/Logo/color-on-trans-logo.png" />
                    </Link>
                    <HeaderTicker />
                </div>

                <div className="site-nav-links" id="site-nav-links">
                    <div className={`site-nav-features${featuresActive ? ' active' : ''}`}>
                        <button
                            type="button"
                            className="site-nav-link site-nav-features-toggle"
                            aria-haspopup="true"
                        >
                            Features
                            <span className="site-nav-features-caret" aria-hidden="true">▾</span>
                        </button>
                        <div className="site-nav-features-menu">
                            {FEATURE_ITEMS.map((item) => (
                                <Link
                                    key={item.to}
                                    to={item.to}
                                    className={`site-nav-features-item${isActive(item.to) ? ' active' : ''}`}
                                    aria-current={isActive(item.to) ? 'page' : undefined}
                                >
                                    {item.label}
                                </Link>
                            ))}
                        </div>
                    </div>
                    {raydiumHref && (
                        <a
                            className="site-nav-icon raydium-swap-link"
                            href={raydiumHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="Buy AFHO on Raydium"
                            title="Buy AFHO on Raydium"
                        >
                            <img
                                className="raydium-swap-logo"
                                src="/raydium-r.png"
                                alt="Raydium logo"
                            />
                            Buy AFHO
                        </a>
                    )}
                    <a
                        className="site-nav-icon neon-glitch"
                        href={SOCIAL_LINKS.twitter}
                        target="_blank" style={{ '--glitch-delay': '1.9s' } as React.CSSProperties}
                        rel="noopener noreferrer"
                        aria-label="AFHO on X (Twitter)"
                    >
                        <TwitterIcon />
                    </a>
                    <a
                        className="site-nav-icon"
                        href={SOCIAL_LINKS.telegram}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label="AFHO on Telegram"
                    >
                        <TelegramIcon />
                    </a>
                </div>

                <button
                    type="button"
                    className="site-nav-toggle"
                    aria-expanded={open}
                    aria-controls="site-nav-links"
                    onClick={() => setOpen((v) => !v)}
                >
                    <span className="site-nav-toggle-box" aria-hidden="true">
                        <span className="site-nav-toggle-line" />
                        <span className="site-nav-toggle-line" />
                        <span className="site-nav-toggle-line" />
                    </span>
                    <span className="site-nav-toggle-label">Menu</span>
                </button>
            </div>
        </nav >
    );
}
