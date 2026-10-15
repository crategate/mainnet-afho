import { useWallet } from '@solana/wallet-adapter-react';
import { MarketStatus } from '../MarketStatus';
import { WalletDashboard } from '../WalletDashboard';
import { StakeForm } from '../StakeForm';
import { usePositions } from '../../hooks/stake/usePositions';
import type { ResolvedDeployment } from '../../config';

interface HeroSectionProps {
    deployment: ResolvedDeployment;
}

export function HeroSection({ deployment }: HeroSectionProps) {
    const { connected } = useWallet();
    const { refresh: refreshPositions } = usePositions(deployment.mintKey);

    return (
        <section className="hero-section">
            <div className="hero-brand">
                <h1><span>After</span><span>_</span><span>Hours</span></h1>
                <div className="tagline">A to<span>k</span>en <span>t</span>uned to W<span>all </span> <span> S</span>t</div>
            </div>

            <div className="hero-content">
                {connected ? (
                    /* Connected: Lock & Earn stays top, split-width with the
                     * market status tile (stacking full-width below tablet);
                     * the wallet dashboard drops underneath both. */
                    <>
                        <div className="hero-row">
                            <StakeForm
                                mint={deployment.mintKey}
                                onStakeSuccess={refreshPositions}
                                marketStatusPda={deployment.marketStatusKey}
                            />
                            <div
                                className="neon-glitch neon-shadow shadow-wander-b market-tile-frame"
                                style={{ '--glitch-delay': '0.8s', '--shadow-delay': '0.2s' } as React.CSSProperties}
                            >
                                <MarketStatus marketStatusPda={deployment.marketStatusKey} variant="hero" />
                            </div>
                        </div>
                        <WalletDashboard />
                    </>
                ) : (
                    <div className="hero-row hero-row--disconnected">
                        <WalletDashboard />
                        <div
                            className="neon-glitch neon-shadow shadow-wander-b market-tile-frame"
                            style={{ '--glitch-delay': '0.8s', '--shadow-delay': '0.2s' } as React.CSSProperties}
                        >
                            <MarketStatus marketStatusPda={deployment.marketStatusKey} variant="hero" />
                        </div>
                    </div>
                )}
            </div>
        </section >
    );
}
