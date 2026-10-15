import { useCallback, useMemo } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { Connection, PublicKey } from '@solana/web3.js';
import { BorshAccountsCoder, type Idl } from '@coral-xyz/anchor';
import { useQuery } from '@tanstack/react-query';
import crankIdl from '../../../target/idl/crank_oracle.json';
import ammIdl from '../../../target/idl/amm.json';
import { useChainData } from '../context/useChainData';
import {
    AMM_PROGRAM_ID,
    CRANK_PROGRAM_ID,
    field,
    type AmmStateData,
    type LivePriceData,
    type MarketStatusData,
    type OfferListData,
    type StakePoolData,
} from '../context/chainDataHelpers';
import type { ResolvedDeployment } from '../config';

export type DashField = { label: string; value: string };

export type DashSection = {
    title: string;
    initialized: boolean;
    fields: DashField[];
    addresses: DashField[];
};

export type DashData = {
    sections: DashSection[];
    missing: string[];
    updatedAt: string;
};

const crankCoder = new BorshAccountsCoder(crankIdl as Idl);
const ammCoder = new BorshAccountsCoder(ammIdl as Idl);

function u64At(data: Uint8Array, offset: number): bigint {
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

function u32At(data: Uint8Array, offset: number): number {
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
}

function tokenAmount(data: Uint8Array): bigint {
    return u64At(data, 64);
}

function fmtToken(raw: unknown, decimals: number): string {
    const n = Number(String(raw ?? 0)) / 10 ** decimals;
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function fmtSol(raw: unknown): string {
    return (Number(String(raw ?? 0)) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 }) + ' SOL';
}

function fmtTs(unix: unknown): string {
    const n = Number(String(unix ?? 0));
    if (!n) return 'never';
    return new Date(n * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

/* Momentum score — TS port of programs/amm/src/instructions/helpers_make_offers.rs
 * ::calculate_momentum_score. Recency-weighted mean of the 20-day price_changes
 * ring (centi-percent, each sample clamped to ±10%/day, 0 = no sample) plus
 * half the recent-5 vs older trend delta, scaled around 5000 → 0-10000.
 * Cold start: fewer than 5 nonzero samples → score 0. */
const MOMENTUM_MIN_SAMPLES = 5;
const MOMENTUM_CP_FULL_SCALE = 500; // 5.00% in centi-percent pins the scale
const MOMENTUM_SAMPLE_CAP_CP = 1000; // ±10%/day effective per sample

function momentumScore(priceChanges: number[], sampleHead: number): { score: number; samples: number } {
    const n = priceChanges.length;
    if (n === 0) return { score: 0, samples: 0 };
    const head = ((sampleHead % n) + n) % n;
    let count = 0, wSum = 0, wTotal = 0, recentSum = 0, recentN = 0, olderSum = 0, olderN = 0;
    for (let age = 0; age < n; age++) {
        const raw = priceChanges[(head + age) % n];
        if (raw === 0) continue;
        const v = Math.max(-MOMENTUM_SAMPLE_CAP_CP, Math.min(MOMENTUM_SAMPLE_CAP_CP, raw));
        count += 1;
        const w = age + 1; // newer days weigh more
        wSum += v * w;
        wTotal += w;
        if (age >= n - 5) {
            recentSum += v;
            recentN += 1;
        } else {
            olderSum += v;
            olderN += 1;
        }
    }
    if (count < MOMENTUM_MIN_SAMPLES) return { score: 0, samples: count };
    const weightedAvg = Math.trunc(wSum / wTotal);
    const trend = recentN > 0 && olderN > 0 ? Math.trunc(recentSum / recentN) - Math.trunc(olderSum / olderN) : 0;
    const blended = weightedAvg + Math.trunc(trend / 2);
    const score = 5000 + Math.trunc((blended * 5000) / MOMENTUM_CP_FULL_SCALE);
    return { score: Math.min(10000, Math.max(0, score)), samples: count };
}

/* Daily close→close price-change ring in chronological order (sample_head =
 * next write = oldest slot), newest last, 0 entries (no sample) skipped. */
function priceChangeRing(priceChanges: number[], sampleHead: number, take = 10): string {
    const n = priceChanges.length;
    if (n === 0) return '—';
    const head = ((sampleHead % n) + n) % n;
    const chrono: number[] = [];
    for (let age = 0; age < n; age++) chrono.push(priceChanges[(head + age) % n]);
    const samples = chrono.filter((v) => v !== 0).slice(-take);
    if (samples.length === 0) return '—';
    return samples.map((v) => `${v > 0 ? '+' : ''}${(v / 100).toFixed(2)}%`).join(' → ');
}

function pk(value?: string): PublicKey | null {
    if (!value) return null;
    try {
        return new PublicKey(value);
    } catch {
        return null;
    }
}

interface RemainingAccounts {
    mintInfo: { data: Uint8Array; lamports: number } | null;
    acceptedOffers: { data: Uint8Array; lamports: number } | null;
    metrics: { data: Uint8Array; lamports: number } | null;
    ammAfhoVault: { data: Uint8Array; lamports: number } | null;
    ammUsdcVault: { data: Uint8Array; lamports: number } | null;
    usdcDip: { data: Uint8Array; lamports: number } | null;
    stakeVault: { data: Uint8Array; lamports: number } | null;
    rewardVault: { data: Uint8Array; lamports: number } | null;
    penaltyVault: { data: Uint8Array; lamports: number } | null;
    bountyConfig: { data: Uint8Array; lamports: number } | null;
    bountyVault: { data: Uint8Array; lamports: number } | null;
}

async function fetchRemainingAccounts(
    connection: Connection,
    deployment: ResolvedDeployment,
    ammProgram: PublicKey,
    crankProgram: PublicKey,
): Promise<RemainingAccounts> {
    const mint = deployment.mintKey;

    const [acceptedOffersPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('accepted_offers'), mint.toBuffer()],
        ammProgram,
    );
    const [metricsPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('metrics'), mint.toBuffer()],
        ammProgram,
    );
    const [bountyConfigPda] = PublicKey.findProgramAddressSync([Buffer.from('bounty_config')], crankProgram);
    const [bountyVaultPda] = PublicKey.findProgramAddressSync([Buffer.from('bounty_vault')], crankProgram);
    // 10% dip-reserve vaults (buy_the_dip spends from these). Same derivation
    // amm-init / initialize_amm use: a PDA token account (USDC) and a
    // space-0 system PDA (SOL).
    const [usdcDipPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('amm_usdc_dip'), mint.toBuffer()],
        ammProgram,
    );

    const keys = [
        mint,
        acceptedOffersPda,
        metricsPda,
        pk(deployment.ammAfhoVault),
        pk(deployment.ammUsdcVault),
        usdcDipPda,
        pk(deployment.vault),
        pk(deployment.rewardVault),
        pk(deployment.penaltyVault),
        bountyConfigPda,
        bountyVaultPda,
    ].filter((k): k is PublicKey => k !== null);

    const names = [
        'mint',
        'acceptedOffers',
        'metrics',
        'ammAfhoVault',
        'ammUsdcVault',
        'usdcDip',
        'stakeVault',
        'rewardVault',
        'penaltyVault',
        'bountyConfig',
        'bountyVault',
    ];

    const infos = await connection.getMultipleAccountsInfo(keys);
    const account = (name: string) => {
        const idx = names.indexOf(name);
        return infos[idx] ?? null;
    };

    return {
        mintInfo: account('mint'),
        acceptedOffers: account('acceptedOffers'),
        metrics: account('metrics'),
        ammAfhoVault: account('ammAfhoVault'),
        ammUsdcVault: account('ammUsdcVault'),
        usdcDip: account('usdcDip'),
        stakeVault: account('stakeVault'),
        rewardVault: account('rewardVault'),
        penaltyVault: account('penaltyVault'),
        bountyConfig: account('bountyConfig'),
        bountyVault: account('bountyVault'),
    };
}

/* ── Ratchet (buyback floor) history ──
 *
 * highest_buyback_basis only stores its CURRENT value, so "last % change"
 * comes from tx logs: calc_completed_offers logs every decay cut
 * ("floor decay locked day N: OLD -> NEW (live L, demand D%)"). Buyback/dip
 * fills can also ratchet the floor UP (to the fill's exec price, unlogged)
 * — the gap between the last decay's end value and the live floor exposes
 * those. Scanned from recent amm_state txs; devnet-grade RPC cost, so this
 * query refetches only on the dash's manual refresh.
 */
export interface RatchetDecayEvent {
    slot: number;
    time: number | null;
    day: number;
    from: bigint;
    to: bigint;
    live: bigint;
    demand: number;
}

export interface RatchetHistory {
    events: RatchetDecayEvent[]; // chronological, oldest first
    scanned: number; // txs scanned
}

const DECAY_LOG_RE = /floor decay locked day (\d+): (\d+) -> (\d+) \(live (\d+), demand (\d+)%/;

async function rpcRetry<T>(fn: () => Promise<T>): Promise<T> {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; ; i++) {
        try {
            return await fn();
        } catch (e) {
            if (!/429|Too Many|rate/i.test(String(e)) || i > 5) throw e;
            await sleep(1500 * (i + 1));
        }
    }
}

async function fetchRatchetHistory(
    connection: Connection,
    ammStatePda: PublicKey,
): Promise<RatchetHistory> {
    const sigs = await rpcRetry(() =>
        connection.getSignaturesForAddress(ammStatePda, { limit: 30 }, 'confirmed')
    );
    const events: RatchetDecayEvent[] = [];
    let scanned = 0;
    for (const s of sigs.slice().reverse()) {
        // v1 claims (SIMD-0385) share this PDA's history with legacy/v0
        // keeper txs. Ask for v1 and skip signatures the 1.x SDK can't
        // decode — the scanner only reads logMessages (decay logs come from
        // the keeper's legacy/v0 txs), so skipping a v1 sig loses nothing.
        scanned += 1;
        let t: Awaited<ReturnType<Connection['getTransaction']>> = null;
        try {
            t = await rpcRetry(() =>
                connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 1 })
            );
        } catch {
            continue;
        }
        if (!t || t.meta?.err) continue;
        for (const line of t.meta?.logMessages ?? []) {
            const m = line.match(DECAY_LOG_RE);
            if (m) {
                events.push({
                    slot: t.slot,
                    time: t.blockTime ?? null,
                    day: Number(m[1]),
                    from: BigInt(m[2]),
                    to: BigInt(m[3]),
                    live: BigInt(m[4]),
                    demand: Number(m[5]),
                });
            }
        }
        await new Promise((r) => setTimeout(r, 900)); // devnet rate limits
    }
    return { events, scanned };
}

function buildDashData(
    deployment: ResolvedDeployment,
    marketStatus: MarketStatusData | null,
    pool: StakePoolData | null,
    ammState: AmmStateData | null,
    offerList: OfferListData | null,
    remaining: RemainingAccounts,
    ammProgram: PublicKey,
    crankProgram: PublicKey,
    livePrice: LivePriceData | null,
    ratchet: RatchetHistory | null,
): DashData {
    const missing: string[] = [];

    const mintInfo = remaining.mintInfo;
    let decimals = 9;
    let mintSupply = 0n;
    let mintAuthRenounced = false;
    if (mintInfo && mintInfo.data.length >= 82) {
        mintSupply = u64At(mintInfo.data, 36);
        decimals = mintInfo.data[44];
        mintAuthRenounced = u32At(mintInfo.data, 0) === 0;
    }
    if (!mintInfo) missing.push('mint');

    const token = (info: { data: Uint8Array } | null): bigint | null => {
        return info && info.data.length >= 72 ? tokenAmount(info.data) : null;
    };

    // ---- Offer sheet ----
    const offerFields: DashField[] = [];
    if (offerList) {
        for (const [label, key] of [
            ['Big', 'big'],
            ['Med', 'med'],
            ['Sml', 'sml'],
        ] as const) {
            const o = field<Record<string, unknown>>(offerList, `${key}Offer`, `${key}_offer`);
            if (o) {
                offerFields.push({
                    label: `${label} offer`,
                    value: `lot ${field(o, 'lotSize', 'lot_size')} · vest ${field(o, 'vestingDays', 'vesting_days')}d · disc ${field(o, 'discountBps', 'discount_bps')} · ${field(o, 'remaining')}/${field(o, 'totalOffered', 'total_offered')} left`,
                });
            }
        }
        offerFields.push({
            label: 'Total sold',
            value: `${field(offerList, 'totalComplete', 'total_complete')} AFHO`,
        });
    }

    const metricsInfo = remaining.metrics;
    const metrics = metricsInfo
        ? (ammCoder.decode('MarketMetrics', Buffer.from(metricsInfo.data)) as Record<string, unknown> | null)
        : null;
    if (metrics) {
        const trail = field<number[]>(metrics, 'trailingStakeHealth', 'trailing_stake_health') ?? [];
        offerFields.push(
            { label: 'Metrics day', value: `${field(metrics, 'dayIndex', 'day_index')}` },
            {
                label: '% of available supply',
                value: (() => {
                    const staked = Number(String(field(metrics, 'totalStaked', 'total_staked') ?? 0));
                    const supply = Number(String(field(metrics, 'totalSupply', 'total_supply') ?? 0));
                    const vault = token(remaining.ammAfhoVault);
                    const available = vault != null ? supply - Number(vault) : supply;
                    return available > 0 ? `${((staked / available) * 100).toFixed(2)}%` : '—';
                })(),
            },
            { label: 'Stake trend (5d)', value: trail.join(' → ') || '—' },
        );
        const changes = field<number[]>(metrics, 'priceChanges', 'price_changes') ?? [];
        const sampleHead = Number(field(metrics, 'sampleHead', 'sample_head') ?? 0);
        const mom = momentumScore(changes, sampleHead);
        offerFields.push(
            {
                label: 'Momentum (0-10000)',
                value: mom.samples < MOMENTUM_MIN_SAMPLES ? `— cold (${mom.samples}/${MOMENTUM_MIN_SAMPLES} samples)` : `${mom.score} / 10000 (5000 = flat)`,
            },
            { label: 'Price 24h change ring', value: priceChangeRing(changes, sampleHead) },
        );
    }

    const acceptedInfo = remaining.acceptedOffers;
    if (acceptedInfo) {
        const hasDay = acceptedInfo.data.length >= 31;
        const base = hasDay ? 16 : 8;
        const read5 = (off: number) => Array.from(acceptedInfo.data.slice(base + off, base + off + 5));
        offerFields.push(
            { label: 'Last recorded day', value: hasDay ? `${u64At(acceptedInfo.data, 8)}` : 'legacy acct' },
            { label: 'Big accepted (5d)', value: read5(0).join(' → ') },
            { label: 'Med accepted (5d)', value: read5(5).join(' → ') },
            { label: 'Sml accepted (5d)', value: read5(10).join(' → ') },
        );
    } else {
        missing.push('accepted_offers PDA');
    }
    if (!metrics) missing.push('metrics PDA');

    // ---- AMM ----
    const ammFields: DashField[] = [];
    if (ammState) {
        const floor = BigInt(field(ammState, 'highestBuybackBasis', 'highest_buyback_basis') ?? 0n);
        const untaken = Number(field(ammState, 'untakenDays', 'untaken_days') ?? 0);
        const spot = livePrice?.afhoUsdc ?? null;
        const solSpot = livePrice?.solUsdc ?? null;
        const pct = (a: bigint, b: bigint): string => `${((Number(a) - Number(b)) / Number(b) * 100).toFixed(2)}%`;
        const usd = (f: bigint): string => `$${(Number(f) / 1e9).toFixed(9)}`;
        ammFields.push(
            {
                label: 'USDC proceeds',
                value: `${fmtToken(field(ammState, 'totalUsdcProceeds', 'total_usdc_proceeds'), 6)} USDC`,
            },
            {
                label: 'Ratchet floor (USDC)',
                // Stored in floor units (price × 1e9 nano-USD per token):
                // 4505 = $0.000004505/AFHO.
                value: usd(floor),
            },
            {
                label: 'Ratchet floor (SOL)',
                // Same floor-unit convention on both legs → a plain ratio
                // gives the whole-token AFHO price in SOL.
                value: solSpot && solSpot > 0n ? `${(Number(floor) / Number(solSpot)).toFixed(12)} SOL` : '—',
            },
            {
                label: 'Floor vs spot',
                value: spot && spot > 0n
                    ? `${pct(floor, spot)} ${floor >= spot ? 'above — decay territory' : 'below — desk trades over the floor'}`
                    : '—',
            },
            { label: 'Untaken days', value: `${untaken} (decay starts on the 4th straight locked day)` },
        );
        const last = ratchet?.events[ratchet.events.length - 1] ?? null;
        if (last) {
            const decayPct = ((Number(last.to) - Number(last.from)) / Number(last.from) * 100).toFixed(2);
            const since = ((Number(floor) - Number(last.to)) / Number(last.to) * 100).toFixed(2);
            const ago = last.time
                ? `${Math.max(1, Math.round((Date.now() / 1000 - last.time) / 3600))}h ago`
                : '';
            ammFields.push(
                {
                    label: 'Last floor decay',
                    value: `${decayPct}% (${last.from} → ${last.to}) · day ${last.day} · demand ${last.demand}%${ago ? ` · ${ago}` : ''}`,
                },
                {
                    label: 'Floor Δ since last decay',
                    // Positive = buyback/dip fills ratcheted the floor back
                    // up after that cut; ~0% = it has only decayed since.
                    value: `${since.startsWith('-') || since === '0.00' ? '' : '+'}${since}%`,
                },
            );
        } else {
            ammFields.push({ label: 'Last floor decay', value: ratchet ? 'none in recent history' : '—' });
        }
    }
    const ammAfho = token(remaining.ammAfhoVault);
    const ammUsdc = token(remaining.ammUsdcVault);
    const usdcDip = token(remaining.usdcDip);
    if (ammAfho !== null) ammFields.push({ label: 'AFHO vault', value: fmtToken(ammAfho, decimals) });
    if (ammUsdc !== null) ammFields.push({ label: 'Buyback USDC vault', value: fmtToken(ammUsdc, 6) });
    if (usdcDip !== null) ammFields.push({ label: 'Dip USDC vault', value: fmtToken(usdcDip, 6) });
    if (!ammState) missing.push('amm_state');

    // ---- Staking ----
    const stakeFields: DashField[] = [];
    if (pool) {
        stakeFields.push(
            { label: 'Total staked', value: fmtToken(field(pool, 'totalStaked', 'total_staked'), decimals) },
            {
                label: 'Weighted stake',
                value: fmtToken(field(pool, 'totalWeightedStake', 'total_weighted_stake'), decimals),
            },
        );
    }
    for (const [label, key] of [
        ['Stake vault', 'stakeVault'],
        ['Reward vault', 'rewardVault'],
        ['Penalty vault', 'penaltyVault'],
    ] as const) {
        const amount = token(remaining[key as keyof RemainingAccounts] as { data: Uint8Array } | null);
        if (amount !== null) stakeFields.push({ label, value: fmtToken(amount, decimals) });
    }
    if (!pool) missing.push('stake pool');

    // ---- Crank & bounty ----
    const status = marketStatus;
    const bountyCfgInfo = remaining.bountyConfig;
    const bountyCfg = bountyCfgInfo
        ? (crankCoder.decode('BountyConfig', Buffer.from(bountyCfgInfo.data)) as Record<string, unknown> | null)
        : null;
    const bountyVaultInfo = remaining.bountyVault;
    const crankFields: DashField[] = [];
    if (status) {
        crankFields.push(
            { label: 'Market state (raw)', value: `${status.state}` },
            { label: 'Trading day', value: `${status.tradingDay}` },
            { label: 'Last update', value: fmtTs(status.timestamp) },
        );
    }
    if (bountyCfg) {
        crankFields.push({
            label: 'Bounty / crank',
            value: fmtSol(field(bountyCfg, 'bountyAmount', 'bounty_amount')),
        });
    }
    if (bountyVaultInfo) {
        crankFields.push({ label: 'Bounty vault', value: fmtSol(bountyVaultInfo.lamports) });
    }
    if (!status) missing.push('market_status');

    const [acceptedOffersPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('accepted_offers'), deployment.mintKey.toBuffer()],
        ammProgram,
    );
    const [metricsPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('metrics'), deployment.mintKey.toBuffer()],
        ammProgram,
    );
    const [bountyConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('bounty_config')],
        crankProgram,
    );
    const [bountyVaultPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('bounty_vault')],
        crankProgram,
    );

    const addr = (label: string, value?: string): DashField => ({
        label,
        value: value ?? 'not configured',
    });

    const [usdcDipPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('amm_usdc_dip'), deployment.mintKey.toBuffer()],
        ammProgram,
    );

    const sections: DashSection[] = [
        {
            title: 'Offer Sheet',
            initialized: !!offerList,
            fields: offerFields,
            addresses: [
                addr('OfferList', deployment.ammOfferList),
                addr('AcceptedOffers', acceptedOffersPda.toBase58()),
                addr('Metrics', metricsPda.toBase58()),
            ],
        },
        {
            title: 'After-Hours AMM',
            initialized: !!ammState,
            fields: ammFields,
            addresses: [
                addr('AmmState', deployment.ammState),
                addr('AFHO vault', deployment.ammAfhoVault),
                addr('Buyback USDC vault', deployment.ammUsdcVault),
                addr('Dip USDC vault', usdcDipPda.toBase58()),
            ],
        },
        {
            title: 'Staking Pool',
            initialized: !!pool,
            fields: stakeFields,
            addresses: [
                addr('Pool', deployment.pool),
                addr('Stake vault', deployment.vault),
                addr('Reward vault', deployment.rewardVault),
                addr('Penalty vault', deployment.penaltyVault),
            ],
        },
        {
            title: 'Crank Oracle & Bounty',
            initialized: !!status && status.state !== 99,
            fields: crankFields,
            addresses: [
                addr('MarketStatus', deployment.marketStatus),
                addr('BountyConfig', bountyConfigPda.toBase58()),
                addr('BountyVault', bountyVaultPda.toBase58()),
            ],
        },
        {
            title: 'Mint & Launch',
            initialized: !!mintInfo,
            fields: [
                { label: 'Supply', value: fmtToken(mintSupply, decimals) },
                { label: 'Decimals', value: `${decimals}` },
                { label: 'Mint authority', value: mintAuthRenounced ? 'renounced' : 'active' },
            ],
            addresses: [
                { label: 'Mint', value: deployment.mint ?? 'not configured' },
                { label: 'Coin program', value: deployment.coinMintProgram ?? 'not configured' },
            ],
        },
    ];

    return { sections, missing, updatedAt: new Date().toISOString() };
}

export function useDashData() {
    const { connection } = useConnection();
    const { deployment, marketStatus, pool, ammState, offerList, livePrice, refresh } = useChainData();

    const programs = useMemo(() => {
        return {
            ammProgram: deployment?.ammProgram
                ? new PublicKey(deployment.ammProgram)
                : AMM_PROGRAM_ID,
            crankProgram: deployment?.crankProgram
                ? new PublicKey(deployment.crankProgram)
                : CRANK_PROGRAM_ID,
        };
    }, [deployment]);
    const { ammProgram, crankProgram } = programs;

    const remainingQuery = useQuery({
        queryKey: ['dashRemaining', deployment?.mintKey.toBase58() ?? ''],
        queryFn: async () => {
            if (!deployment) throw new Error('Deployment not loaded');
            return fetchRemainingAccounts(connection, deployment, ammProgram, crankProgram);
        },
        enabled: !!deployment,
        staleTime: 15000,
        refetchInterval: typeof document !== 'undefined' && !document.hidden ? 15000 : false,
        refetchIntervalInBackground: false,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
            const msg = error instanceof Error ? error.message : String(error);
            return /429|rate/i.test(msg) ? failureCount < 3 : failureCount < 1;
        },
        retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
    });

    // Floor-change history: tx-log scan (~30 RPC calls, ~27s with the
    // rate-limit sleeps), so manual-refresh only. refetchOnWindowFocus is
    // explicitly disabled: with react-query's default (true) every return to
    // the tab after 60s of staleness re-ran the whole scan, monopolizing the
    // rate-limited devnet endpoint for ~half a minute and starving the shared
    // snapshot + remaining queries into 429 backoff — the dash then sat on
    // stale data while every other request fought the scan.
    const ratchetQuery = useQuery({
        queryKey: ['dashRatchet', deployment?.ammState ?? ''],
        queryFn: async () => {
            if (!deployment?.ammState) throw new Error('Deployment not loaded');
            return fetchRatchetHistory(connection, new PublicKey(deployment.ammState));
        },
        enabled: !!deployment?.ammState,
        staleTime: 60_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
            const msg = error instanceof Error ? error.message : String(error);
            return /429|rate/i.test(msg) ? failureCount < 2 : failureCount < 1;
        },
        retryDelay: (attemptIndex) => Math.min(2000 * 2 ** attemptIndex, 30000),
    });

    const doRefresh = useCallback(() => {
        void refresh('amm');
        void refresh('marketStatus');
        void refresh('pool');
        void ratchetQuery.refetch();
    }, [refresh, ratchetQuery]);

    const data = useMemo(() => {
        if (!deployment || !remainingQuery.data) return null;
        return buildDashData(
            deployment,
            marketStatus,
            pool,
            ammState,
            offerList,
            remainingQuery.data,
            ammProgram,
            crankProgram,
            livePrice ?? null,
            ratchetQuery.data ?? null,
        );
    }, [deployment, marketStatus, pool, ammState, offerList, remainingQuery.data, ammProgram, crankProgram, livePrice, ratchetQuery.data]);

    const error = remainingQuery.error instanceof Error ? remainingQuery.error.message : null;

    return { data, error, refresh: doRefresh };
}
