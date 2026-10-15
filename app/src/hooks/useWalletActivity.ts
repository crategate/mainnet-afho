import { useCallback, useEffect, useRef, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import stakingIdl from '../../../target/idl/staking.json';
import ammIdl from '../../../target/idl/amm.json';
import { STAKING_PROGRAM_ID, CRANK_PROGRAM_ID, AMM_PROGRAM_ID } from '../anchor/setup';
import type { ResolvedDeployment } from '../config';
import {
    classifyTx,
    makeCoder,
    type ActivityContext,
    type ActivityEvent,
    type TxJson,
} from '../lib/activityDecode';

/* Wallet activity feed for /activity: merges the wallet's own signature
   history with its AFHO ATA history (incoming transfers never touch the
   wallet pubkey, only the token account), then resolves transactions in
   small batches so a free-tier RPC never sees a burst. */

const TX_BATCH = 25;
const SIG_PAGE = 1000;

type SigRow = { signature: string; blockTime: number | null; slot: number; err: unknown };

interface SourceCursor {
    before: string | undefined;
    done: boolean;
}

export interface WalletActivityState {
    events: ActivityEvent[];
    status: 'idle' | 'loading' | 'ready' | 'error';
    error: string | null;
    /* Progress of the in-flight batch (k transactions read of n queued). */
    progress: { done: number; of: number } | null;
    hasMore: boolean;
    loadMore: () => void;
}

export function useWalletActivity(
    publicKey: PublicKey | null,
    deployment: ResolvedDeployment | null,
): WalletActivityState {
    const { connection } = useConnection();
    const [events, setEvents] = useState<ActivityEvent[]>([]);
    const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [error, setError] = useState<string | null>(null);
    const [progress, setProgress] = useState<{ done: number; of: number } | null>(null);
    const [hasMore, setHasMore] = useState(true);

    const sigsRef = useRef<SigRow[]>([]);
    const cursorRef = useRef(0);
    const sourcesRef = useRef<{ wallet: SourceCursor; ata: SourceCursor }>({
        wallet: { before: undefined, done: false },
        ata: { before: undefined, done: false },
    });
    const eventsRef = useRef<ActivityEvent[]>([]);
    const busyRef = useRef(false);
    /* Bumped on every wallet/deployment change so in-flight loops abort
       instead of writing a previous wallet's rows into the new one. */
    const runRef = useRef(0);
    /* The effect rebuilds its loader per context; the page gets a stable
       callback through this ref. */
    const loaderRef = useRef<() => void>(() => {});

    useEffect(() => {
        runRef.current += 1;
        const run = runRef.current;
        sigsRef.current = [];
        cursorRef.current = 0;
        eventsRef.current = [];
        sourcesRef.current = {
            wallet: { before: undefined, done: false },
            ata: { before: undefined, done: false },
        };
        busyRef.current = false;
        setEvents([]);
        setStatus('idle');
        setError(null);
        setProgress(null);
        setHasMore(true);

        if (!publicKey || !deployment) return;

        let ctx: ActivityContext;
        try {
            ctx = {
                wallet: publicKey.toBase58(),
                ata: getAssociatedTokenAddressSync(
                    deployment.mintKey,
                    publicKey,
                    false,
                    TOKEN_2022_PROGRAM_ID,
                ).toBase58(),
                mint: deployment.mintKey.toBase58(),
                programs: {
                    staking: deployment.stakingProgram ?? STAKING_PROGRAM_ID.toBase58(),
                    amm: deployment.ammProgram ?? AMM_PROGRAM_ID.toBase58(),
                    crank: deployment.crankProgram ?? CRANK_PROGRAM_ID.toBase58(),
                    coinMint: deployment.coinMintProgram ?? deployment.mint ?? deployment.mintKey.toBase58(),
                    raydium: deployment.raydiumProgram ?? undefined,
                },
                coderStaking: makeCoder(stakingIdl),
                coderAmm: makeCoder(ammIdl),
            };
        } catch {
            setStatus('error');
            setError('Could not derive the wallet context from the deployment.');
            return;
        }

        /* ── signature collection: keep at least one full batch queued ── */
        const collectSignatures = async () => {
            const sources = sourcesRef.current;
            while (
                sigsRef.current.length - cursorRef.current < TX_BATCH &&
                !(sources.wallet.done && sources.ata.done)
            ) {
                for (const key of ['wallet', 'ata'] as const) {
                    const source = sources[key];
                    if (source.done) continue;
                    const address = key === 'wallet' ? ctx.wallet : ctx.ata;
                    const page = (await connection.getSignaturesForAddress(
                        new PublicKey(address),
                        { before: source.before, limit: SIG_PAGE },
                    )) as SigRow[];
                    if (runRef.current !== run) return;
                    if (page.length) source.before = page[page.length - 1].signature;
                    source.done = page.length < SIG_PAGE;
                    const seen = new Set(sigsRef.current.map((s) => s.signature));
                    for (const row of page) {
                        // Failed attempts never print — drop them at the source.
                        if (row.err) continue;
                        if (!seen.has(row.signature)) {
                            seen.add(row.signature);
                            sigsRef.current.push({
                                signature: row.signature,
                                blockTime: row.blockTime ?? null,
                                slot: row.slot,
                                err: null,
                            });
                        }
                    }
                }
                sigsRef.current.sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0) || b.slot - a.slot);
            }
        };

        /* ── batch resolution: transactions read sequentially, rows stream ── */
        const loadMore = async () => {
            if (busyRef.current) return;
            busyRef.current = true;
            setStatus('loading');
            setProgress({ done: 0, of: 0 });
            try {
                await collectSignatures();
                if (runRef.current !== run) return;
                const batch = sigsRef.current.slice(cursorRef.current, cursorRef.current + TX_BATCH);
                cursorRef.current += batch.length;
                setProgress({ done: 0, of: batch.length });
                let read = 0;
                for (const sig of batch) {
                    // Default json encoding: web3.js v1.98 chokes validating
                    // Helius's jsonParsed account keys, and json carries
                    // everything the decoder reads.
                    const tx = (await connection.getTransaction(sig.signature, {
                        maxSupportedTransactionVersion: 0,
                    })) as unknown as TxJson | null;
                    if (runRef.current !== run) return;
                    if (tx) {
                        const event = classifyTx(tx, ctx);
                        if (event) {
                            event.signature = sig.signature;
                            event.blockTime = sig.blockTime ?? event.blockTime;
                            eventsRef.current.push(event);
                        }
                    }
                    read += 1;
                    setProgress({ done: read, of: batch.length });
                }
                eventsRef.current.sort((a, b) => (b.blockTime ?? 0) - (a.blockTime ?? 0) || b.slot - a.slot);
                setEvents([...eventsRef.current]);
                setStatus('ready');
                const sources = sourcesRef.current;
                setHasMore(
                    cursorRef.current < sigsRef.current.length ||
                        !(sources.wallet.done && sources.ata.done),
                );
            } catch (e) {
                if (runRef.current !== run) return;
                setStatus('error');
                setError(e instanceof Error ? e.message : String(e));
            } finally {
                busyRef.current = false;
            }
        };

        loaderRef.current = () => void loadMore();
        void loadMore();
    }, [publicKey, deployment, connection]);

    const loadMore = useCallback(() => loaderRef.current(), []);

    return { events, status, error, progress, hasMore, loadMore };
}
