import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    AMM_PROGRAM_ID,
    CRANK_PROGRAM_ID,
    computeLivePrice,
    decodeAmmState,
    decodeMarketStatus,
    decodeOfferList,
    decodePool,
    deriveAltOfferListPda,
    deriveAmmStatePda,
    deriveMarketStatusPda,
    deriveOfferListPda,
    derivePoolPda,
    derivePriceAccounts,
    fetchDeployment,
    isRateLimitError,
    pub,
    type AmmStateData,
    type LivePriceData,
} from './chainDataHelpers';
import { ChainDataContext, type ChainDataContextValue, type RefreshKey } from './ChainDataContext';

/* ── Environment tuning ── */

const POLL_MS = Number(import.meta.env.VITE_RPC_POLL_MS ?? 30000);
const DEPLOYMENT_STALE_MS = Number(import.meta.env.VITE_DEPLOYMENT_STALE_MS ?? 60000);

/* ── Visibility hook ── */

function usePageVisible() {
    const [visible, setVisible] = useState(!document.hidden);
    useEffect(() => {
        const onVis = () => setVisible(!document.hidden);
        document.addEventListener('visibilitychange', onVis);
        return () => document.removeEventListener('visibilitychange', onVis);
    }, []);
    return visible;
}

/* ── Shared retry config ── */

function rateLimitRetry(failureCount: number, error: Error): boolean {
    if (isRateLimitError(error)) return failureCount < 2;
    return failureCount < 1;
}

function retryDelay(attemptIndex: number): number {
    // Longer, jittered delays: hammering a shared rate-limited devnet endpoint
    // makes the 429 storm worse, and the next poll tick (≤~40s) recovers anyway.
    return Math.min(4000 * 2 ** attemptIndex, 30000) + Math.random() * 2000;
}

/* ── Account-change subscription helper ──
   All four watched accounts invalidate the ONE batched snapshot query, so the
   throttle is a shared module-level ref (not per-hook state): a flurry of
   account updates (or StrictMode double subscriptions) refetches the snapshot
   at most once per 5s.

   Subscriptions stay subscribed across visibility flips: tearing down ~10
   WebSocket subscriptions on hide and recreating them on show churned the
   socket layer on every tab switch (and lost liveness entirely whenever the
   socket died in the background). While the tab is hidden the callback just
   drops notifications — background tabs must not refetch — and the return to
   visibility refetches via the snapshot query's enabled-flip (it refetches
   when it re-enables with data older than staleTime). */

const WS_INVALIDATE_MIN_MS = 5000;
const wsLastInvalidateRef = { current: 0 };

function useAccountSubscription(
    account: PublicKey | null,
    queryKey: unknown[],
    enabled: boolean,
) {
    const { connection } = useConnection();
    const queryClient = useQueryClient();

    useEffect(() => {
        if (!account || !enabled || !connection) return;

        const id = connection.onAccountChange(
            account,
            () => {
                if (document.hidden) return; // background: drop, don't refetch
                const now = Date.now();
                if (now - wsLastInvalidateRef.current < WS_INVALIDATE_MIN_MS) return;
                wsLastInvalidateRef.current = now;
                void queryClient.invalidateQueries({ queryKey, refetchType: 'active' });
            },
            'confirmed',
        );

        return () => {
            void connection.removeAccountChangeListener(id);
        };
    }, [connection, account, enabled, queryKey, queryClient]);
}

// Variant for a variable-length list of derived accounts (the CPMM price
// set). Hooks can't be called in a loop over a changing array, so one effect
// subscribes to ALL accounts and re-subscribes only when the SET changes —
// keyed on the joined base58 list, not the array identity (the derivation
// produces fresh PublicKey instances each snapshot).
function useAccountsSubscription(
    accounts: PublicKey[],
    queryKey: unknown[],
    enabled: boolean,
) {
    const { connection } = useConnection();
    const queryClient = useQueryClient();
    const accountsKey = useMemo(() => accounts.map((a) => a.toBase58()).join(','), [accounts]);

    useEffect(() => {
        if (!enabled || !connection || accountsKey === '') return;
        const list = accountsKey.split(',').map((k) => new PublicKey(k));

        const onPriceAccountChange = () => {
            if (document.hidden) return; // background: drop, don't refetch
            const now = Date.now();
            if (now - wsLastInvalidateRef.current < WS_INVALIDATE_MIN_MS) return;
            wsLastInvalidateRef.current = now;
            void queryClient.invalidateQueries({ queryKey, refetchType: 'active' });
        };
        const ids = list.map((account) => connection.onAccountChange(account, onPriceAccountChange, 'confirmed'));

        return () => {
            for (const id of ids) void connection.removeAccountChangeListener(id);
        };
    }, [connection, accountsKey, enabled, queryKey, queryClient]);
}
/* ── Provider ── */

export function ChainDataProvider({ children }: { children: ReactNode }) {
    const { connection } = useConnection();
    const queryClient = useQueryClient();
    const visible = usePageVisible();

    /* Deployment — loaded once and cached. */
    const deploymentQuery = useQuery({
        queryKey: ['deployment'],
        queryFn: fetchDeployment,
        staleTime: DEPLOYMENT_STALE_MS,
        gcTime: DEPLOYMENT_STALE_MS * 2,
        refetchOnWindowFocus: false,
        retry: rateLimitRetry,
        retryDelay,
    });

    const deployment = deploymentQuery.data ?? null;

    const derived = useMemo(() => {
        if (!deployment) {
            return {
                marketStatusPda: deriveMarketStatusPda(CRANK_PROGRAM_ID),
                ammStatePda: null as PublicKey | null,
                offerListPda: null as PublicKey | null,
                altListPda: null as PublicKey | null,
                poolPda: null as PublicKey | null,
            };
        }
        const ammProgram = deployment.ammProgram
            ? new PublicKey(deployment.ammProgram)
            : AMM_PROGRAM_ID;
        const crankProgram = deployment.crankProgram
            ? new PublicKey(deployment.crankProgram)
            : CRANK_PROGRAM_ID;
        return {
            marketStatusPda: deployment.marketStatusKey ?? deriveMarketStatusPda(crankProgram),
            ammStatePda: deriveAmmStatePda(deployment.mintKey, ammProgram),
            offerListPda: deriveOfferListPda(deployment.mintKey, ammProgram),
            altListPda: deriveAltOfferListPda(deployment.mintKey, ammProgram),
            poolPda: derivePoolPda(deployment.mintKey),
        };
    }, [deployment]);

    const { marketStatusPda, ammStatePda, offerListPda, altListPda, poolPda } = derived;

    const enabled = !!connection && !!deployment && visible;
    // Subscriptions ride the chain data being known, not tab visibility:
    // they stay subscribed across visibility flips (callbacks no-op while
    // hidden) so the socket doesn't churn on every tab switch.
    const subscribe = !!connection && !!deployment;

    /* Single batched snapshot. One getMultipleAccountsInfo per tick replaces
       the five per-account queries (market status, staking pool, AMM state,
       offer list, live price) — ~5 HTTP requests per poll → 1 (plus one extra
       batched call on the very first tick to prime the price). */

    const mintKey = deployment?.mintKey?.toBase58() ?? '';
    const snapshotQueryKey = useMemo(
        () => [
            'chainSnapshot',
            marketStatusPda.toBase58(),
            poolPda?.toBase58() ?? '',
            ammStatePda?.toBase58() ?? '',
            offerListPda?.toBase58() ?? '',
            altListPda?.toBase58() ?? '',
            mintKey,
        ],
        [marketStatusPda, poolPda, ammStatePda, offerListPda, altListPda, mintKey],
    );

    // Price accounts are derived from the PREVIOUS snapshot's AMM state
    // (client-side PDA math), so they ride along in the same batch. A pool
    // re-pin shows up on the next tick.
    const lastAmmStateRef = useRef<AmmStateData | null>(null);

    const snapshotQuery = useQuery({
        queryKey: snapshotQueryKey,
        queryFn: async () => {
            if (!deployment?.mintKey) throw new Error('Deployment not loaded');
            const mint = deployment.mintKey;
            const previousAmmState = lastAmmStateRef.current;
            const priceAccounts = previousAmmState ? derivePriceAccounts(previousAmmState, mint) : [];
                const infos = await connection.getMultipleAccountsInfo(
                [
                    marketStatusPda,
                    poolPda ?? PublicKey.default,
                    ammStatePda ?? PublicKey.default,
                    offerListPda ?? PublicKey.default,
                    altListPda ?? PublicKey.default,
                    ...priceAccounts,
                ],
                'confirmed',
            );

            const [marketStatusInfo, poolInfo, ammStateInfo, offerListInfo, altListInfo, ...priceInfos] = infos;

            const ammState = ammStateInfo ? decodeAmmState(ammStateInfo.data) : null;

            // Quote mints for the TWAP orientation check: the AFHO mint is
            // the deployment mint; the quote is whatever this deployment's
            // AMM state pins as usdc_mint (read from the previous/fresh
            // decode — never a hardcoded mainnet-USDC assumption, devnet
            // uses its own 6-dp USDC mint).
            const quoteMint = previousAmmState
                ? pub(previousAmmState, 'usdcMint', 'usdc_mint')
                : ammState
                    ? pub(ammState, 'usdcMint', 'usdc_mint')
                    : null;
            // Cold start: no previous AMM state to derive price accounts from,
            // so fetch them now against the freshly decoded state — one extra
            // batched call on the first tick, never again.
            let livePrice: LivePriceData = previousAmmState
                ? computeLivePrice(priceInfos, mint, quoteMint ?? undefined)
                : { afhoUsdc: null, afhoPriceIsTwap: false, solUsdc: null, solPoolReserves: null };
            if (!previousAmmState && ammState) {
                const coldStartInfos = await connection.getMultipleAccountsInfo(
                    derivePriceAccounts(ammState, mint),
                    'confirmed',
                );
                livePrice = computeLivePrice(coldStartInfos, mint, quoteMint ?? undefined);
            }

            if (ammState) lastAmmStateRef.current = ammState;

            return {
                marketStatus: marketStatusInfo ? decodeMarketStatus(marketStatusInfo.data) : null,
                pool: poolInfo ? decodePool(poolInfo.data) : null,
                ammState,
                offerList: offerListInfo ? decodeOfferList(offerListInfo.data) : null,
                altList: altListInfo ? decodeOfferList(altListInfo.data) : null,
                livePrice,
            };
        },
        enabled,
        staleTime: POLL_MS,
        refetchInterval: visible ? POLL_MS : false,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
        // Keep the last known snapshot through a transient 429 — a single failed
        // poll tick must not blank the UI or drop the price to null.
        placeholderData: (previous) => previous,
        retry: rateLimitRetry,
        retryDelay,
    });

    // Any watched account changing refetches the one snapshot (throttled).
    useAccountSubscription(marketStatusPda, snapshotQueryKey, subscribe);
    useAccountSubscription(poolPda, snapshotQueryKey, subscribe && !!poolPda);
    useAccountSubscription(ammStatePda, snapshotQueryKey, subscribe && !!ammStatePda);
    useAccountSubscription(offerListPda, snapshotQueryKey, subscribe && !!offerListPda);
    useAccountSubscription(altListPda, snapshotQueryKey, subscribe && !!altListPda);

    /* Refresh — every domain key now lands on the single batched snapshot. */
    const refresh = useCallback(
        async (key: RefreshKey) => {
            void key;
            await queryClient.invalidateQueries({ queryKey: snapshotQueryKey, refetchType: 'active' });
        },
        [queryClient, snapshotQueryKey],
    );

    const snapshot = snapshotQuery.data ?? null;

    // Price accounts ride the same snapshot but are NOT covered by the
    // subscriptions above: the CPMM vaults + observation accounts are what
    // actually move between polls, and every swap changes them. Without
    // these subscriptions the displayed live price (and with it the desk's
    // floor-held/buy gate) can sit tens of seconds — minutes through a 429
    // stretch — behind the pool, which is exactly how a "buyable" quote
    // turns into an on-chain FloorHeldAtSpot revert. Derived from the
    // latest snapshot's AMM state (client-side PDA math), so a pool re-pin
    // re-subscribes on the next tick.
    const priceAccounts = useMemo(() => {
        const s = snapshot?.ammState;
        if (!s || !mintKey) return [];
        try {
            return derivePriceAccounts(s, new PublicKey(mintKey));
        } catch {
            return [];
        }
    }, [snapshot?.ammState, mintKey]);
    useAccountsSubscription(
        priceAccounts.filter((a) => !a.equals(PublicKey.default)),
        snapshotQueryKey,
        subscribe,
    );

    const value: ChainDataContextValue = {
        deployment,
        deploymentLoading: deploymentQuery.isLoading,
        marketStatus: snapshot?.marketStatus ?? null,
        marketStatusLoading: snapshotQuery.isLoading,
        pool: snapshot?.pool ?? null,
        poolLoading: snapshotQuery.isLoading,
        ammState: snapshot?.ammState ?? null,
        ammStateLoading: snapshotQuery.isLoading,
        offerList: snapshot?.offerList ?? null,
        offerListLoading: snapshotQuery.isLoading,
        altList: snapshot?.altList ?? null,
        livePrice: snapshot?.livePrice ?? { afhoUsdc: null, afhoPriceIsTwap: false, solUsdc: null, solPoolReserves: null },
        livePriceLoading: snapshotQuery.isLoading,
        livePriceUpdatedAt: snapshotQuery.dataUpdatedAt || null,
        snapshotFetching: snapshotQuery.isFetching,
        refresh,
    };

    return <ChainDataContext.Provider value={value}>{children}</ChainDataContext.Provider>;
}
