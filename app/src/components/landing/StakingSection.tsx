import { useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useWallet } from '@solana/wallet-adapter-react';
import { Positions } from '../Positions';
import { usePositions } from '../../hooks/stake/usePositions';
import { PublicKey } from '@solana/web3.js';
import { GlitchText } from '../GlitchText';

interface StakingSectionProps {
    mint: PublicKey;
    marketStatusPda?: PublicKey;
}

export function StakingSection({ mint, marketStatusPda }: StakingSectionProps) {
    const [expanded, setExpanded] = useState(true);
    const { connected } = useWallet();
    const { positions } = usePositions(mint);

    const hasPositions = positions.length > 0;

    return (
        <section className="landing-section staking-section alt">
            <div className="landing-section-inner">
                <div className="staking-toolbar">
                    <h2><GlitchText text="Active Positions" variant="streetlight" step={0.05} /></h2>
                    <div className="staking-actions">
                        <button
                            className="staking-toggle neon-glitch glitch-shift"
                            onClick={() => setExpanded((v) => !v)}
                            aria-expanded={expanded}
                            style={{ '--glitch-delay': '0.6s' } as React.CSSProperties}
                        >
                            {expanded ? 'Collapse' : 'Expand'}
                        </button>
                    </div>
                </div>

                {!connected && (
                    <div className="no-positions neon-glitch glass-pane">
                        <p>Connect your wallet to view active staking positions.</p>
                        <div className="wallet-button-wrapper" style={{ marginTop: '1rem' }}>
                            <WalletMultiButton />
                        </div>
                    </div>
                )}

                {connected && expanded && (
                    <div className="staking-content">
                        <div
                            className="positions-shell neon-glitch neon-shadow shadow-split glitch-double glass-pane"
                            style={{ '--glitch-delay': '0.3s', '--shadow-delay': '0.8s' } as React.CSSProperties}
                        >
                            <Positions mint={mint} marketStatusPda={marketStatusPda} />
                        </div>
                    </div>
                )}

                {connected && !expanded && hasPositions && (
                    <div className="no-positions glass-pane">
                        {positions.length} position{positions.length !== 1 ? 's' : ''} hidden.
                    </div>
                )}
            </div>
        </section>
    );
}
