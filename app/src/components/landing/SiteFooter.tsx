import { Link } from 'react-router-dom';
import { PublicKey } from '@solana/web3.js';
import { CopyAddress } from '../CopyAddress';

// Social links — Telegram points at the CHANNEL's public username link
// (https://t.me/afhoio). Never use the t.me/c/… form (that's the private
// chat-link format with numeric ids — it does not resolve for public
// channels) or the discussion group: everything links the channel.
const SOCIALS = [
    {
        label: 'X (Twitter)',
        href: 'https://x.com/afhoio',
        icon: (
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path
                    fill="currentColor"
                    d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"
                />
            </svg>
        ),
    },
    {
        label: 'Telegram',
        href: 'https://t.me/afhoio',
        icon: (
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path
                    fill="currentColor"
                    d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"
                />
            </svg>
        ),
    },
];

export function SiteFooter({ mint }: { mint: PublicKey }) {
    return (
        <footer className="site-footer">
            <div className="social-links">
                {SOCIALS.map((s) => (
                    <a
                        key={s.label}
                        className="social-link"
                        href={s.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={s.label}
                    >
                        {s.icon}
                    </a>
                ))}
            </div>
            <img className="logo" src="/Logo/color-on-trans-logo.png" />

            {/* Ecosystem chip: swap the copy + href for a swap deep-link
                once the token is live (and verified) on Jupiter. */}
            <a
                className="footer-jupiter-chip"
                href="https://jup.ag"
                target="_blank"
                rel="noopener noreferrer"
            >
                <img src="/jupiter-logo.png" alt="" aria-hidden="true" loading="lazy" />
                <span>AFHO on Jupiter</span>
            </a>

            <div className="site-footer-address">
                <CopyAddress
                    value={mint.toBase58()}
                    className="footer-address"
                    title="Copy AFHO token address"
                />
            </div>

            <p className="site-footer-note">
                AFHO is experimental token protocol. Nothing here is financial advice.{' '}
                <Link to="/disclaimer" className="site-footer-disclaimer">Read the full disclaimer.</Link>
            </p>
        </footer>
    );
}
