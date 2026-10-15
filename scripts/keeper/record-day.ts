import * as anchor from "@coral-xyz/anchor";
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import * as fs from "fs";
import * as path from "path";
import { Connection, PublicKey } from "@solana/web3.js";
import { renderLinesPdf } from "../lib/pdf";

// =============================================================================
// DAILY RECORDS LEDGER — DEVNET OPS TOOL
// =============================================================================
// Snapshots the day-start on-chain state (one row per trading day) for the
// /records page (Trading Day Metric Ledger). Fired by the keeper on a
// day-start transition (1→0 or 2→0)
// market transition and runnable by hand: `anchor run record` (--dry-run to
// print without writing).
//
// Storage model (no database):
//   app/public/records.json                 — the newest LATEST_DAYS trading
//                                             days (live ledger the page renders)
//   app/public/records/archive-<a>-<b>.json — raw rows for days older than that,
//                                             grouped into 60-trading-day blocks
//                                             (a..b = trading-day-index range)
//   app/public/records/archive-<a>-<b>.pdf  — human-readable archive for the
//                                             block, regenerated whenever the
//                                             block changes
//   app/public/records/archives.json        — manifest the page lists as
//                                             downloadable PDFs
//
// Rows are keyed by trading_day_index and UPSERTED — re-running for a day
// replaces that day's row (before it has been archived).
//
// Decoding mirrors app/src/hooks/useDashData.ts: raw BorshAccountsCoder over
// target/idl/*.json, snake_case field names, token amounts read as u64 LE at
// offset 64.
// =============================================================================

const LEDGER_PATH = path.join(process.cwd(), "app", "public", "records.json");
const ARCHIVE_DIR = path.join(process.cwd(), "app", "public", "records");
const DEPLOYMENT_PATH = path.join(process.cwd(), "app", "public", "deployment.json");
const LATEST_DAYS = 100; // live ledger size; overflow archives to PDF
const ARCHIVE_BLOCK_DAYS = 60; // trading days per archive block (one PDF per block)

// lot_sizer ladder — programs/amm/src/state/offers_state.rs (tiers 0-22,
// whole AFHO tokens per lot). Offer.lot_size stores the TIER index.
const LOT_LADDER: readonly number[] = [
    0, 10, 25, 50, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000, 15000,
    20000, 50000, 100000, 250000, 500000, 1000000, 2500000, 5000000, 10000000,
];

const MARKET_LABELS = ["open", "after-hours", "closed", "halted"];

export type RecordTier = {
    lotTier: number;
    lotTokens: number;
    vestingDays: number;
    discountBps: number; // tenths of a percent (115 = 11.5%)
    remaining: number;
    totalOffered: number;
} | null;

export type RecordRow = {
    dayIndex: number;
    recordedAt: number; // unix seconds of the snapshot
    date: string; // YYYY-MM-DD (server-local calendar date)
    marketState: number;
    offerDesk: {
        big: RecordTier;
        med: RecordTier;
        sml: RecordTier;
        totalComplete: number | null; // whole AFHO sold, all-time
        sheetDayIndex: number | null;
    };
    fills: { big: number[]; med: number[]; sml: number[] } | null; // 5-day rings
    market: {
        afhoPrice: string | null; // floor units (nano-USD per whole token)
        spotMin: string | null;
        spotMax: string | null;
        spotSamples: number;
        priceChanges: number[]; // centi-percent i16 ring, on-chain order
        sampleHead: number;
        momentum: number; // 0-10000 (5000 = flat), 0 = cold
        momentumSamples: number;
        highestBuybackBasis: string | null; // floor units
        afhoVault: string | null; // raw AFHO
        usdcVault: string | null; // raw USDC (6 dp)
        usdcDip: string | null; // raw USDC (6 dp)
    };
    staking: {
        totalStaked: string | null; // raw AFHO
        totalWeightedStake: string | null;
        totalSupply: string | null; // raw AFHO (from metrics)
        stakedPct: number | null; // percent of supply, 2 dp
        trailingStakeHealth: number[]; // 0-100 ring
        stakeVault: string | null; // raw AFHO
        rewardVault: string | null;
        penaltyVault: string | null;
        posrVault: string | null;
        frozenAmount: string | null; // raw AFHO under an active/uncleared freeze (freeze feature)
    };
};

type Ledger = { version: number; rows: RecordRow[] };
type Archive = { version: number; firstDay: number; lastDay: number; rows: RecordRow[] };
type ArchiveManifest = {
    version: number;
    archives: { firstDay: number; lastDay: number; days: number; pdf: string; updatedAt: number }[];
};

function u64At(data: Uint8Array, offset: number): bigint {
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
}

function tokenAmount(data: Uint8Array): bigint | null {
    return data.length >= 72 ? u64At(data, 64) : null;
}

function s(v: unknown): string | null {
    return v === undefined || v === null ? null : String(v);
}

function n_(v: unknown): number | null {
    return v === undefined || v === null ? null : Number(v);
}

/* Momentum score — TS port of helpers_make_offers.rs::calculate_momentum_score
 * (same port the /dash tile uses). */
const MOMENTUM_MIN_SAMPLES = 5;
const MOMENTUM_CP_FULL_SCALE = 500;
const MOMENTUM_SAMPLE_CAP_CP = 1000;

export function momentumScore(priceChanges: number[], sampleHead: number): { score: number; samples: number } {
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

/* Newest nonzero entry of the daily close→close change ring (centi-percent). */
function latestChangeCp(priceChanges: number[], sampleHead: number): number | null {
    const n = priceChanges.length;
    if (n === 0) return null;
    const head = ((sampleHead % n) + n) % n;
    for (let age = n - 1; age >= 0; age--) {
        const v = priceChanges[(head + age) % n];
        if (v !== 0) return v;
    }
    return null;
}

function localIsoDate(d: Date): string {
    const p = (x: number) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function tierFromOffer(o: Record<string, unknown> | null): RecordTier {
    if (!o) return null;
    const lotTier = Number(o.lot_size ?? o.lotSize ?? 0);
    return {
        lotTier,
        lotTokens: LOT_LADDER[lotTier] ?? 0,
        vestingDays: Number(o.vesting_days ?? o.vestingDays ?? 0),
        discountBps: Number(o.discount_bps ?? o.discountBps ?? 0),
        remaining: Number(o.remaining ?? 0),
        totalOffered: Number(o.total_offered ?? o.totalOffered ?? 0),
    };
}

/** Collects one day-start snapshot row from chain state. Throws when the
 * deployment or core accounts are missing — callers decide how to handle. */
export async function recordDaySnapshot(connection: Connection): Promise<RecordRow> {
    const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf-8"));
    if (!deployment.mint) throw new Error("deployment.json has no mint — run 'anchor run mint' first");

    const ammIdl = JSON.parse(fs.readFileSync(path.join(process.cwd(), "target", "idl", "amm.json"), "utf-8"));
    const stakingIdl = JSON.parse(fs.readFileSync(path.join(process.cwd(), "target", "idl", "staking.json"), "utf-8"));
    const ammCoder = new BorshAccountsCoder(ammIdl as Idl);
    const stakingCoder = new BorshAccountsCoder(stakingIdl as Idl);
    const ammProgram = new PublicKey(ammIdl.address ?? ammIdl.metadata?.address);

    const mint = new PublicKey(deployment.mint);
    const ammPda = (seed: string) =>
        PublicKey.findProgramAddressSync([Buffer.from(seed), mint.toBuffer()], ammProgram)[0];
    const ammStatePda = ammPda("amm_state");
    const offerListPda = ammPda("offer_list");
    const metricsPda = ammPda("metrics");
    const acceptedOffersPda = ammPda("accepted_offers");
    const usdcDipPda = ammPda("amm_usdc_dip");

    const optionalKey = (addr?: string) => (addr ? new PublicKey(addr) : null);
    const keys = [
        ammStatePda,
        offerListPda,
        metricsPda,
        acceptedOffersPda,
        optionalKey(deployment.ammAfhoVault),
        optionalKey(deployment.ammUsdcVault),
        usdcDipPda,
        optionalKey(deployment.marketStatus),
        optionalKey(deployment.pool),
        optionalKey(deployment.vault),
        optionalKey(deployment.rewardVault),
        optionalKey(deployment.penaltyVault),
        optionalKey(deployment.posrVault),
    ].filter((k): k is PublicKey => k !== null);
    const infos = await connection.getMultipleAccountsInfo(keys);
    // Key by base58 STRING, not the PublicKey instance: JavaScript Maps hash
    // objects by identity, and PublicKey does not override Map hashing —
    // lookups with freshly-built PublicKey instances (every deployment-
    // derived account below) silently missed, nulling afhoVault/usdcVault/
    // the whole staking block in every records row since the ledger existed.
    const byKey = new Map<string, (typeof infos)[number]>();
    infos.forEach((info, i) => byKey.set(keys[i].toBase58(), info));
    const acc = (k: PublicKey | null) => (k ? (byKey.get(k.toBase58()) ?? null) : null);

    const decodeAmm = <T,>(name: string, k: PublicKey | null): T | null => {
        const info = acc(k);
        if (!info) return null;
        try {
            return ammCoder.decode(name, Buffer.from(info.data)) as T;
        } catch {
            return null;
        }
    };

    // ── market status (raw layout: state u8 @8, ts i64 @9, day u64 @17) ──
    // Never fall back to the 99 sentinel silently: a missing read used to
    // default to state 99 / day 0 and write phantom rows. If the batch read
    // came back null (RPC pressure), retry the account directly, then fail
    // with a clear message instead of fabricating a day.
    const marketStatusKey = optionalKey(deployment.marketStatus);
    let statusInfo = acc(marketStatusKey);
    if (!statusInfo && marketStatusKey) {
        statusInfo = await connection.getAccountInfo(marketStatusKey, "confirmed");
    }
    if (!statusInfo || statusInfo.data.length < 25) {
        throw new Error(
            "market status account missing/unreadable — is deployment.marketStatus current? " +
                "(refusing to record a phantom state-99 row)",
        );
    }
    const marketState = statusInfo.data[8];
    const dayIndex = Number(u64At(statusInfo.data, 17));

    // ── metrics ──
    const metrics = decodeAmm<Record<string, unknown>>("MarketMetrics", metricsPda);
    const priceChanges = (metrics?.price_changes ?? []) as number[];
    const sampleHead = Number(metrics?.sample_head ?? 0);
    const mom = momentumScore(priceChanges, sampleHead);

    // Spot ring: chronological (head = next write = oldest slot), floor units.
    const spotRaw = (metrics?.spot_prices ?? []) as unknown[];
    const spotHead = Number(metrics?.spot_head ?? 0);
    let afhoPrice: string | null = null;
    let spotMin: string | null = null;
    let spotMax: string | null = null;
    let spotSamples = 0;
    if (spotRaw.length > 0) {
        const chrono: string[] = [];
        for (let age = 0; age < spotRaw.length; age++) chrono.push(String(spotRaw[(spotHead + age) % spotRaw.length]));
        const live = chrono.filter((v) => v !== "0");
        spotSamples = live.length;
        if (live.length > 0) {
            afhoPrice = live[live.length - 1];
            const nums = live.map(Number);
            spotMin = String(Math.min(...nums));
            spotMax = String(Math.max(...nums));
        }
    }

    // ── offer sheet ──
    const offerList = decodeAmm<Record<string, unknown>>("OfferList", offerListPda);
    const tier = (key: string) => tierFromOffer((offerList?.[key] ?? null) as Record<string, unknown> | null);

    // ── accepted-offer fill rings (raw: day u64 @8, 3×5 u8 at base 16) ──
    const acceptedInfo = acc(acceptedOffersPda);
    let fills: RecordRow["fills"] = null;
    if (acceptedInfo && acceptedInfo.data.length >= 31) {
        const read5 = (off: number) => Array.from(acceptedInfo.data.slice(16 + off, 16 + off + 5));
        fills = { big: read5(0), med: read5(5), sml: read5(10) };
    }

    // ── amm state + vaults ──
    const ammState = decodeAmm<Record<string, unknown>>("AmmState", ammStatePda);
    const afhoVaultInfo = acc(optionalKey(deployment.ammAfhoVault));
    const usdcVaultInfo = acc(optionalKey(deployment.ammUsdcVault));
    const usdcDipInfo = acc(usdcDipPda);

    // ── staking ──
    let pool: Record<string, unknown> | null = null;
    const poolInfo = acc(optionalKey(deployment.pool));
    if (poolInfo) {
        try {
            pool = stakingCoder.decode("StakePool", Buffer.from(poolInfo.data)) as Record<string, unknown>;
        } catch {
            pool = null;
        }
    }
    const tokenOf = (info: { data: Uint8Array } | null) => {
        const amt = info ? tokenAmount(info.data) : null;
        return amt === null ? null : String(amt);
    };

    const totalStaked = s(pool?.total_staked);
    const totalSupply = s(metrics?.total_supply);
    const stakedPct =
        totalStaked !== null && totalSupply !== null && Number(totalSupply) > 0
            ? Math.round((Number(totalStaked) / Number(totalSupply)) * 10000) / 100
            : null;

    const trail = (metrics?.trailing_stake_health ?? []) as number[];

    return {
        dayIndex,
        recordedAt: Math.floor(Date.now() / 1000),
        date: localIsoDate(new Date()),
        marketState,
        offerDesk: {
            big: tier("big_offer"),
            med: tier("med_offer"),
            sml: tier("sml_offer"),
            totalComplete: n_(offerList?.total_complete),
            sheetDayIndex: n_(offerList?.day_index),
        },
        fills,
        market: {
            afhoPrice,
            spotMin,
            spotMax,
            spotSamples,
            priceChanges,
            sampleHead,
            momentum: mom.score,
            momentumSamples: mom.samples,
            highestBuybackBasis: s(ammState?.highest_buyback_basis),
            afhoVault: tokenOf(afhoVaultInfo),
            usdcVault: tokenOf(usdcVaultInfo),
            usdcDip: tokenOf(usdcDipInfo),
        },
        staking: {
            totalStaked,
            totalWeightedStake: s(pool?.total_weighted_stake),
            totalSupply,
            stakedPct,
            trailingStakeHealth: trail.map(Number),
            stakeVault: tokenOf(acc(optionalKey(deployment.vault))),
            rewardVault: tokenOf(acc(optionalKey(deployment.rewardVault))),
            penaltyVault: tokenOf(acc(optionalKey(deployment.penaltyVault))),
            posrVault: tokenOf(acc(optionalKey(deployment.posrVault))),
            // Freeze feature: raw AFHO carrying an active/uncleared freeze.
            frozenAmount: s(pool?.frozen_amount),
        },
    };
}

function readLedger(): Ledger {
    try {
        const parsed = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf-8")) as Ledger;
        if (parsed && Array.isArray(parsed.rows)) {
            // Self-heal: a snapshot taken at the crank's fail-closed sentinel
            // (state 99) is not a trading day — drop it so the page never
            // renders a phantom "state 99" row.
            const rows = parsed.rows.filter((r) => r.marketState !== 99);
            return { version: 1, rows };
        }
    } catch {
        // missing/corrupt ledger → start fresh
    }
    return { version: 1, rows: [] };
}

function readManifest(): ArchiveManifest {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, "archives.json"), "utf-8")) as ArchiveManifest;
        if (parsed && Array.isArray(parsed.archives)) return parsed;
    } catch {
        // missing/corrupt manifest → start fresh
    }
    return { version: 1, archives: [] };
}

/* ── PDF formatting (ASCII only — the writer escapes/sanitizes) ─────────── */

function fmtCompact(raw: string | number | null, decimals = 9): string {
    if (raw === null || raw === undefined || raw === "") return "-";
    const n = Number(raw) / 10 ** decimals;
    if (!Number.isFinite(n)) return "-";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
    return n.toFixed(2);
}

function fmtPrice9(floor: string | null): string {
    if (!floor) return "-";
    const dollars = Number(floor) / 1e9;
    if (!Number.isFinite(dollars) || dollars <= 0) return "-";
    return "$" + dollars.toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
}

function rowPdfLines(r: RecordRow): string[] {
    const od = r.offerDesk;
    const m = r.market;
    const st = r.staking;
    const tierLine = (name: string, t: RecordTier) =>
        t
            ? `  ${name.padEnd(4)} lot ${t.lotTokens.toLocaleString("en-US")} | ${t.vestingDays}d vest | ` +
              `${(t.discountBps / 10).toFixed(1)}% off | ${t.remaining}/${t.totalOffered} left`
            : `  ${name.padEnd(4)} -`;
    const change = latestChangeCp(m.priceChanges, m.sampleHead);
    const changeStr = change === null ? "-" : `${change > 0 ? "+" : ""}${(change / 100).toFixed(2)}%`;
    return [
        `${r.date}  day #${r.dayIndex}  state: ${MARKET_LABELS[r.marketState] ?? `state ${r.marketState}`}`,
        tierLine("Big", od.big),
        tierLine("Med", od.med),
        tierLine("Sml", od.sml),
        `  Sold ${od.totalComplete !== null ? od.totalComplete.toLocaleString("en-US") : "-"} AFHO | ` +
            `ratchet floor ${fmtPrice9(m.highestBuybackBasis)}`,
        `  AFHO ${fmtPrice9(m.afhoPrice)} | 24h ${changeStr} | ` +
            `momentum ${m.momentumSamples < 5 ? "cold" : `${m.momentum}/10000`} | ` +
            `range ${fmtPrice9(m.spotMin)} - ${fmtPrice9(m.spotMax)}`,
        `  AFHO vault ${fmtCompact(m.afhoVault)} | dip reserve ${m.usdcDip !== null ? fmtCompact(m.usdcDip, 6) : "-"} USDC`,
        `  Staked ${st.totalStaked !== null ? fmtCompact(st.totalStaked) : "-"}` +
            ` (${st.stakedPct !== null ? st.stakedPct.toFixed(2) + "%" : "-"} of supply) | ` +
            `health ${st.trailingStakeHealth.length ? st.trailingStakeHealth.join("->") : "-"}`,
        `  Vaults: stake ${fmtCompact(st.stakeVault)} | rewards ${fmtCompact(st.rewardVault)} | ` +
            `penalty ${fmtCompact(st.penaltyVault)} | posr ${fmtCompact(st.posrVault)}`,
        "",
    ];
}

/* ── 60-trading-day archive blocks ─────────────────────────────────────── */

/** Trading days 0..59 are block 0, 60..119 block 1, etc. — one archive PDF
 * per block, matching the /records page's "new PDF every 60 trading days". */
function blockForDay(dayIndex: number): number {
    return Math.floor(dayIndex / ARCHIVE_BLOCK_DAYS);
}

/* Move rows older than the live ledger into 60-trading-day archive blocks
 * (JSON + PDF) and refresh the manifest the /records page lists. */
function archiveRows(rows: RecordRow[]): void {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    const byBlock = new Map<number, RecordRow[]>();
    for (const r of rows) {
        const block = blockForDay(r.dayIndex);
        if (!byBlock.has(block)) byBlock.set(block, []);
        byBlock.get(block)!.push(r);
    }
    const manifest = readManifest();
    for (const [block, blockRows] of byBlock) {
        blockRows.sort((a, b) => a.dayIndex - b.dayIndex);
        // Merge with whatever this block already archived (the block's day
        // range GROWS as days roll off the live 100 one at a time, so the
        // existing file may carry an older, narrower range — e.g.
        // archive-60-74.json once day 75 rolls in).
        let merged: RecordRow[] = blockRows;
        for (const f of fs.readdirSync(ARCHIVE_DIR)) {
            const m = /^archive-(\d+)-(\d+)\.json$/.exec(f);
            if (!m || blockForDay(Number(m[1])) !== block) continue;
            try {
                const existing = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), "utf-8")) as Archive;
                const known = new Set((existing.rows ?? []).map((r) => r.dayIndex));
                merged = [...(existing.rows ?? []), ...merged.filter((r) => !known.has(r.dayIndex))];
            } catch {
                // unreadable stale file — ignore
            }
        }
        merged.sort((a, b) => a.dayIndex - b.dayIndex);
        const firstDay = merged[0].dayIndex;
        const lastDay = merged[merged.length - 1].dayIndex;
        const jsonPath = path.join(ARCHIVE_DIR, `archive-${firstDay}-${lastDay}.json`);
        const pdfName = `archive-${firstDay}-${lastDay}.pdf`;
        fs.writeFileSync(jsonPath, JSON.stringify({ version: 1, firstDay, lastDay, rows: merged }, null, 2) + "\n");
        fs.writeFileSync(
            path.join(ARCHIVE_DIR, pdfName),
            renderLinesPdf(
                `AFHO Trading Day Metric Ledger — trading days #${firstDay}–#${lastDay} (${merged.length} days)`,
                merged.flatMap(rowPdfLines),
            ),
        );
        // Drop stale files from an older, narrower range of the same block.
        for (const f of fs.readdirSync(ARCHIVE_DIR)) {
            const m = /^archive-(\d+)-(\d+)\.(json|pdf)$/.exec(f);
            if (m && blockForDay(Number(m[1])) === block && f !== path.basename(jsonPath) && f !== pdfName) {
                fs.rmSync(path.join(ARCHIVE_DIR, f));
            }
        }
        const entry = {
            firstDay,
            lastDay,
            days: merged.length,
            pdf: pdfName,
            updatedAt: Math.floor(Date.now() / 1000),
        };
        const idx = manifest.archives.findIndex((a) => blockForDay(a.firstDay) === block);
        if (idx >= 0) manifest.archives[idx] = entry;
        else manifest.archives.push(entry);
    }
    // Prune manifest entries whose PDF no longer exists (range renamed).
    manifest.archives = manifest.archives.filter((a) => fs.existsSync(path.join(ARCHIVE_DIR, a.pdf)));
    manifest.archives.sort((a, b) => b.firstDay - a.firstDay);
    fs.writeFileSync(path.join(ARCHIVE_DIR, "archives.json"), JSON.stringify(manifest, null, 2) + "\n");
}

export function upsertRow(row: RecordRow): { row: RecordRow; inserted: boolean } {
    const ledger = readLedger();
    const inserted = !ledger.rows.some((r) => r.dayIndex === row.dayIndex);
    const rows = ledger.rows.filter((r) => r.dayIndex !== row.dayIndex);
    rows.push(row);
    rows.sort((a, b) => a.dayIndex - b.dayIndex);
    // The newest LATEST_DAYS stay in the live ledger the page renders;
    // anything older archives into 60-trading-day JSON + PDF blocks.
    const overflow = rows.length > LATEST_DAYS ? rows.slice(0, rows.length - LATEST_DAYS) : [];
    const live = rows.slice(-LATEST_DAYS);
    // Archive FIRST: if the archive write fails, the ledger is untouched and
    // the next run retries (archives dedupe by dayIndex, so a retry is
    // idempotent). The old order could lose the overflow rows for good.
    if (overflow.length > 0) archiveRows(overflow);
    fs.writeFileSync(LEDGER_PATH, JSON.stringify({ version: 1, rows: live }, null, 2) + "\n");
    return { row, inserted };
}

/** Refuse snapshots taken at the crank's fail-closed sentinel (state 99) —
 * that is not a trading day, and recording it would leave a phantom row on
 * /records. Callers decide how to surface the message. */
export function ensureRecordable(row: RecordRow): void {
    if (row.marketState === 99) {
        throw new Error(
            `market status is the init sentinel (99) — not a trading day, nothing recorded. ` +
                `Drive a real state first (anchor run set-oracle -- <state>) or cycle the keeper test state.`,
        );
    }
}

/** Snapshot + guard + upsert in one step. Throws (with a clear message) when
 * the market status is still at the init sentinel. */
export async function recordDay(connection: Connection): Promise<{ row: RecordRow; inserted: boolean }> {
    const row = await recordDaySnapshot(connection);
    ensureRecordable(row);
    return upsertRow(row);
}

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const row = await recordDaySnapshot(provider.connection);
    if (process.argv.includes("--dry-run")) {
        console.log(JSON.stringify(row, null, 2));
        return;
    }
    ensureRecordable(row);
    const { inserted } = upsertRow(row);
    console.log(
        ` records: ${inserted ? "NEW trading day" : "updated existing day"} #${row.dayIndex} ` +
            `(${row.date}, state ${row.marketState}) -> app/public/records.json`,
    );
}

if (require.main === module) {
    main().catch((e) => {
        console.error("Error:", e);
        process.exit(1);
    });
}
