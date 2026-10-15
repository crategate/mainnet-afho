import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { Link } from 'react-router-dom';
import { GlitchText } from './GlitchText';
import { AfhoWalletButton } from './AfhoWalletButton';

export function WalletDashboard() {
    const { connected, connecting } = useWallet();

    if (!connected) {
        return (
            <div className="wallet-dashboard connect-prompt glass-pane">
                <span className="glitch-border" aria-hidden="true" />
                <h2><GlitchText text="Connect Wallet" variant="light" /></h2>
                <p>
                    <GlitchText
                        text="Connect your wallet to stake AFHO and enter the bond offer desk."
                        variant="light"
                        split="word"
                        step={0.22}
                    />
                </p>
                <div className="wallet-button-wrapper">
                    <WalletMultiButton />
                </div>
                {connecting && <p className="connecting-text">Connecting…</p>}
            </div>
        );
    }

    return (
        <div className="wallet-dashboard">
            <div className="dashboard-header neon-glitch glass-pane neon-shadow shadow-corner-tr">
                {/* Recent Activity page — the wallet's protocol tape. */}
                <Link to="/activity" className="recent-activity-link" title="Your protocol activity">
                    Recent Activity
                </Link>
                <div className="dashboard-wallet-group">
                    <span className="wallet-label">Connected</span>
                    <div className="wallet-button-wrapper">
                        <AfhoWalletButton />
                    </div>
                </div>
            </div>
        </div>
    );
};
