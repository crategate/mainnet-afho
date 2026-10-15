import { useWallet } from '@solana/wallet-adapter-react';
import { useRef } from 'react';
import { Helmet } from 'react-helmet-async';
import { useDeployment } from './hooks/useDeployment';
import { useMarketStatus } from './hooks/useMarketStatus';
import { useGlitchBurst } from './hooks/useGlitchBurst';
import { SiteNav } from './components/SiteNav';
import LandingPage from './pages/LandingPage';

function App() {
    const { connected } = useWallet();
    const { deployment, loading, error } = useDeployment();
    const { data: marketData } = useMarketStatus(deployment?.marketStatusKey);
    const shellRef = useRef<HTMLDivElement>(null);
    useGlitchBurst(shellRef);

    return (
        <>
            <Helmet>
                <title>After Hours | A token tuned to Wall St</title>
                <meta
                    name="description"
                    content="AFHO is a Solana token driven by NYSE market hours. While Wall St trades, the protocol buys back its token; after the bell, a nightly desk sells discounted vesting bonds into staking."
                />
            </Helmet>
            {loading ? (
                <div className="app-shell">Loading deployment…</div>
            ) : error || !deployment ? (
                <div className="app-shell">Deployment error: {error ?? 'missing deployment'}</div>
            ) : (
                <div
                    ref={shellRef}
                    className="app-shell"
                    data-connected={connected}
                    data-market-state={marketData?.state ?? 99}
                >
                    <SiteNav />
                    <LandingPage deployment={deployment} />
                </div>
            )}
        </>
    );
}

export default App;
