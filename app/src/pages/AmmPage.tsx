import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { Helmet } from 'react-helmet-async';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import OfferLists from '../components/amm/OfferLists.tsx';
import { useAmmData } from '../hooks/amm/useAmmData.ts';
import { useGlitchBurst } from '../hooks/useGlitchBurst.ts';
import { GlitchText } from '../components/GlitchText.tsx';
import FlashNumber from '../components/FlashNumber.tsx';
import './AmmPage.css';

const MARKET_LABELS = ['Market open', 'After-hours', 'Market closed', 'Market halted'];

export default function AmmPage() {
    const { marketState, offersLive, deskOpen, altActive, updatedAt } = useAmmData();
    const { connected } = useWallet();
    const shellRef = useRef<HTMLDivElement>(null);
    useGlitchBurst(shellRef);

    // Desk excitement: open = alive & rhythmic, waiting = dim, sold out =
    // faded, lit = the rare alt window (state 3 + fixed-terms sheet live),
    // everything else (desk closed / market open) = nearly dead.
    const night = marketState === 1 || marketState === 2;
    const deskState = altActive
        ? 'lit'
        : deskOpen
            ? 'open'
            : night
                ? (offersLive ? 'waiting' : 'soldout')
                : 'dead';

    return (
        <div
            ref={shellRef}
            className="amm-page-shell"
            data-connected={connected}
            data-market-state={marketState ?? 99}
            data-desk={deskState}
        >
            <Helmet>
                <title>Bond Offer Desk | AFHO</title>
                <meta
                    name="description"
                    content="Buy discounted, vesting AFHO bonds after the market closes. Lot sizes, discounts and vesting are set on-chain from staking health and price momentum."
                />
            </Helmet>
            <div className="fx-backdrop" aria-hidden="true">
                <div className="fx-blob fx-blob--2" />
                <div className="fx-blob fx-blob--3" />
                <div className="fx-blob fx-blob--4" />
            </div>
            <header className="amm-topbar">
                <Link to="/" aria-label="After Hours home">
                    <img src="/Logo/color-on-trans-logo.png" className="logo" />
                </Link>
                <div className="amm-title">
                    <h1><GlitchText text="Bond Desk" variant="bluepink" step={0.14} /></h1>
                    <span className={`market-badge ${deskOpen || altActive ? 'open' : ''}`}>
                        {marketState !== null ? MARKET_LABELS[marketState] ?? 'Unknown' : 'Market status unknown'}
                        {altActive ? ' · special sheet live' : ''}
                        {!altActive && deskOpen ? ' · desk open' : ''}
                        {!altActive && !deskOpen && marketState !== null && !offersLive ? ' · no live offers' : ''}
                    </span>
                </div>
                <div className="amm-controls">
                    {updatedAt && (
                        <span className="amm-updated">updated <FlashNumber value={new Date(updatedAt).toLocaleTimeString()} /></span>
                    )}
                    <div className="wallet-button-wrapper">
                        <WalletMultiButton />
                    </div>
                </div>
            </header>

            <OfferLists />
        </div>
    );
}
