import 'virtual:buffer-polyfill';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import type { WalletAdapter } from '@solana/wallet-adapter-base';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes, Outlet, useLocation } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';
import '@solana/wallet-adapter-react-ui/styles.css';
import './index.css';
import App from './App';
import { HomePageIndicator } from './components/amm/HomePageIndicator';
import { StaleDataBanner } from './components/StaleDataBanner';
import { SpotlightBanner } from './components/SpotlightBanner';
import { ChainDataProvider } from './context/ChainDataProvider';
import { TxResultProvider } from './context/TxResultProvider';

// Route-level code splitting: each non-landing page (and its Solana-heavy
// hooks) loads on navigation instead of up front. Vendor libs are split by
// the build.rolldownOptions codeSplitting groups in vite.config.ts.
const Dash = lazy(() => import('./pages/Dash'));
const Records = lazy(() => import('./pages/Records'));
const Activity = lazy(() => import('./pages/Activity'));
const Litepaper = lazy(() => import('./pages/Litepaper'));
const Disclaimer = lazy(() => import('./pages/Disclaimer'));
const AmmPage = lazy(() => import('./pages/AmmPage'));
const Oracle = lazy(() => import('./pages/Oracle'));
const Locking = lazy(() => import('./pages/Locking'));
const Freeze = lazy(() => import('./pages/Freeze'));
const Authority = lazy(() => import('./pages/Authority'));
const BondDesk = lazy(() => import('./pages/BondDesk'));

const queryClient = new QueryClient({
    defaultOptions: {
        queries: { staleTime: 15000, retry: 2 },
    },
});

const wallets: WalletAdapter[] = [new SolflareWalletAdapter()];

// The fallback endpoint follows the SHIPPED deployment.json cluster
// (VITE_RPC_URL overrides; the launch chain rewrites deployment.json before
// web-dist zips it, so the mainnet bundle falls back to mainnet-beta).
const fallbackEndpoint = await fetch(`${import.meta.env.BASE_URL}deployment.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { cluster?: string }) =>
        d?.cluster === 'mainnet'
            ? 'https://api.mainnet-beta.solana.com'
            : 'https://api.devnet.solana.com',
    )
    .catch(() => 'https://api.devnet.solana.com');
const endpoint = import.meta.env.VITE_RPC_URL || fallbackEndpoint;

// web3.js retries HTTP 429s internally (5x, 500ms→8s) and console.errors
// "Server responded with 429 Too Many Requests. Retrying…" on every attempt.
// On rate-limited shared endpoints (Helius free-tier devnet) that turns a
// single 429 into a console-spam retry storm that multiplies the load.
// Disable it so TanStack Query is the single retry layer (backoff + jitter).
const connectionConfig = { disableRetryOnRateLimit: true };

function Shell() {
    const { pathname } = useLocation();
    // Hide the yellow "offers available" indicator on the offer desk itself
    // (it links there) and on the Records ledger (kept dry for marketing).
    const hideIndicator =
        pathname === '/offer-desk' ||
        pathname.startsWith('/offer-desk/') ||
        pathname === '/records' ||
        pathname.startsWith('/records/');
    // The spotlight bar rides every page EXCEPT the desk itself — the desk
    // renders its own lit state while the same window is open.
    const spotlight =
        pathname !== '/offer-desk' && !pathname.startsWith('/offer-desk/');
    return (
        <>
            <StaleDataBanner />
            {spotlight && <SpotlightBanner />}
            {!hideIndicator && <HomePageIndicator />}
            <Suspense
                fallback={
                    <div className="app-shell" style={{ padding: '2rem' }}>
                        Loading…
                    </div>
                }
            >
                <Outlet />
            </Suspense>
        </>
    );
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <HelmetProvider>
            <ConnectionProvider endpoint={endpoint} config={connectionConfig}>
                <WalletProvider wallets={wallets} autoConnect>
                    <WalletModalProvider>
                        <QueryClientProvider client={queryClient}>
                            <ChainDataProvider>
                                <TxResultProvider>
                                    <BrowserRouter>
                                        <Routes>
                                            <Route element={<Shell />}>
                                                <Route path="/" element={<App />} />
                                                <Route path="/dash" element={<Dash />} />
                                                <Route path="/records" element={<Records />} />
                                                <Route path="/activity" element={<Activity />} />
                                                <Route path="/litepaper" element={<Litepaper />} />
                                                <Route path="/disclaimer" element={<Disclaimer />} />
                                                <Route path="/offer-desk" element={<AmmPage />} />
                                                <Route path="/oracle" element={<Oracle />} />
                                                <Route path="/locking" element={<Locking />} />
                                                <Route path="/freeze" element={<Freeze />} />
                                                <Route path="/authority" element={<Authority />} />
                                                <Route path="/bond-desk" element={<BondDesk />} />
                                            </Route>
                                        </Routes>
                                    </BrowserRouter>
                                </TxResultProvider>
                            </ChainDataProvider>
                        </QueryClientProvider>
                    </WalletModalProvider>
                </WalletProvider>
            </ConnectionProvider>
        </HelmetProvider>
    </StrictMode>
);
