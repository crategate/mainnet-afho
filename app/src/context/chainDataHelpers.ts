import { BorshAccountsCoder, type Idl } from '@coral-xyz/anchor';
import {
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import ammIdl from '../../../target/idl/amm.json';
import crankIdl from '../../../target/idl/crank_oracle.json';
import stakingIdl from '../../../target/idl/staking.json';
import { resolveDeployment, type ResolvedDeployment } from '../config';
import { STAKING_PROGRAM_ID } from '../anchor/setup';

/* ── IDL / coder helpers ── */

function idlProgramId(idl: unknown): PublicKey {
    const meta = idl as { metadata?: { address?: string }; address?: string };
    const address = meta.metadata?.address ?? meta.address;
    if (!address) throw new Error('IDL missing program address');
    return new PublicKey(address);
}

export const AMM_PROGRAM_ID = idlProgramId(ammIdl);
export const CRANK_PROGRAM_ID = idlProgramId(crankIdl);

const ammCoder = new BorshAccountsCoder(ammIdl as Idl);
const stakingCoder = new BorshAccountsCoder(stakingIdl as Idl);

export function field<T>(obj: unknown, ...names: string[]): T | undefined {
    const record = obj as Record<string, unknown> | null | undefined;
    for (const n of names) {
        const v = record?.[n];
        if (v !== undefined && v !== null) return v as T;
    }
    return undefined;
}

export function pub(obj: unknown, ...names: string[]): PublicKey | null {
    const v = field(obj, ...names);
    return v instanceof PublicKey ? v : null;
}

export function big(v: unknown): bigint {
    if (v === undefined || v === null) return 0n;
    return BigInt(v.toString());
}

function decode<T>(coder: BorshAccountsCoder, name: string, data: Uint8Array): T | null {
    try {
        return coder.decode(name, Buffer.from(data)) as T;
    } catch {
        return null;
    }
}

/* ── Deployment ── */

export async function fetchDeployment(): Promise<ResolvedDeployment | null> {
    try {
        const response = await fetch(`${import.meta.env.BASE_URL}deployment.json`, {
            cache: 'no-store',
        });
        const config = response.ok ? await response.json() : {};
        return resolveDeployment(config);
    } catch {
        return null;
    }
}

/* ── PDAs ── */

export function deriveMarketStatusPda(crankProgram: PublicKey) {
    return PublicKey.findProgramAddressSync([Buffer.from('market_status')], crankProgram)[0];
}

export function deriveAmmStatePda(mint: PublicKey, ammProgram = AMM_PROGRAM_ID) {
    return PublicKey.findProgramAddressSync(
        [Buffer.from('amm_state'), mint.toBuffer()],
        ammProgram,
    )[0];
}

export function deriveOfferListPda(mint: PublicKey, ammProgram = AMM_PROGRAM_ID) {
    return PublicKey.findProgramAddressSync(
        [Buffer.from('offer_list'), mint.toBuffer()],
        ammProgram,
    )[0];
}

/** Alt desk sheet (fixed-terms second sheet, suspended state only). Same
 *  OfferList layout, separate deterministic PDA — derived directly, so the
 *  client can reference it before the account exists on-chain. */
export function deriveAltOfferListPda(mint: PublicKey, ammProgram = AMM_PROGRAM_ID) {
    return PublicKey.findProgramAddressSync(
        [Buffer.from('alt_offer_list'), mint.toBuffer()],
        ammProgram,
    )[0];
}

export function derivePoolPda(mint: PublicKey) {
    return PublicKey.findProgramAddressSync(
        [Buffer.from('pool'), mint.toBuffer()],
        STAKING_PROGRAM_ID,
    )[0];
}

export function deriveUserIndexPda(owner: PublicKey) {
    return PublicKey.findProgramAddressSync(
        [Buffer.from('user_index'), owner.toBuffer()],
        STAKING_PROGRAM_ID,
    )[0];
}

export function derivePositionPda(poolPda: PublicKey, owner: PublicKey, index: number | bigint) {
    const indexBytes =
        typeof index === 'number'
            ? new Uint8Array(new BigUint64Array([BigInt(index)]).buffer)
            : new Uint8Array(new BigUint64Array([index]).buffer);
    return PublicKey.findProgramAddressSync(
        [Buffer.from('position'), poolPda.toBuffer(), owner.toBuffer(), Buffer.from(indexBytes)],
        STAKING_PROGRAM_ID,
    )[0];
}

/* ── Decoded types ── */

export interface MarketStatusData {
    state: number;
    timestamp: number;
    tradingDay: number;
}

export interface StakePoolData {
    totalStaked: { toString(): string };
    maxMultiplierBps: number;
    posrTaxBps: number;
    afterHoursPenaltyBps: number;
    closedPenaltyBps: number;
    haltedPenaltyBps: number;
    accruedRewardPerShare: { toString(): string };
    vault?: PublicKey;
    // Freeze feature (present on pools initialized with freeze params).
    frozenAmount?: { toString(): string };
    freezeCapBps?: number;
    freezeMinDays?: number;
    freezeMaxFloorDays?: number;
    freezeMaxSpanDays?: number;
    freezeRegimeBear?: number;
    freezeRegimeBull?: number;
    freezeRegimeFloorBps?: number;
    freezePopKneeBps?: number;
    freezePopFloorBps?: number;
    freezeGraceDays?: number;
    [key: string]: unknown;
}

export interface OfferTierRaw {
    lotSize?: number;
    lot_size?: number;
    vestingDays?: number;
    vesting_days?: number;
    discountBps?: number;
    discount_bps?: number;
    remaining?: number;
    totalOffered?: number;
    total_offered?: number;
}

export interface OfferListData {
    dayIndex?: number;
    day_index?: number;
    bigOffer?: OfferTierRaw;
    big_offer?: OfferTierRaw;
    medOffer?: OfferTierRaw;
    med_offer?: OfferTierRaw;
    smlOffer?: OfferTierRaw;
    sml_offer?: OfferTierRaw;
    totalComplete?: number;
    total_complete?: number;
}

export interface AmmStateData {
    highestBuybackBasis?: number | bigint;
    highest_buyback_basis?: number | bigint;
    crankProgram?: PublicKey;
    crank_program?: PublicKey;
    stakingPool?: PublicKey;
    staking_pool?: PublicKey;
    cpmmPoolState?: PublicKey;
    cpmm_pool_state?: PublicKey;
    cpmmProgram?: PublicKey;
    cpmm_program?: PublicKey;
    usdcMint?: PublicKey;
    usdc_mint?: PublicKey;
    cpmmSolUsdcPool?: PublicKey;
    cpmm_sol_usdc_pool?: PublicKey;
    cpmmSolUsdcConfig?: PublicKey;
    cpmm_sol_usdc_config?: PublicKey;
    usdcVault?: PublicKey;
    usdc_vault?: PublicKey;
    usdcDip?: PublicKey;
    usdc_dip?: PublicKey;
    usdcRewards?: PublicKey;
    usdc_rewards?: PublicKey;
    afhoVault?: PublicKey;
    afho_vault?: PublicKey;
}

/* ── Decoders ── */

export function decodeMarketStatus(data: Uint8Array): MarketStatusData | null {
    // Always use the raw layout: the IDL emits snake_case field names, but
    // consumers expect camelCase. Layout is disc(8) + state(1) + timestamp(8) + day(8).
    if (data.length < 25) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return {
        state: view.getUint8(8),
        timestamp: Number(view.getBigInt64(9, true)),
        tradingDay: Number(view.getBigUint64(17, true)),
    };
}

export function decodePool(data: Uint8Array): StakePoolData | null {
    // The raw BorshAccountsCoder decodes the IDL's snake_case field names
    // (accrued_reward_per_share, ...). Consumers expect the camelCase shapes
    // the old `program.account.stakePool.fetch` path produced (Anchor's
    // Program constructor camelCases the IDL before building its coders).
    // The pool account is flat (Pubkeys / BNs / ints), so a top-level key
    // map is sufficient — values are never recursed into, so PublicKey and
    // BN instances stay intact.
    const raw = decode<Record<string, unknown>>(stakingCoder, 'StakePool', data);
    if (!raw) return null;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
        out[key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = value;
    }
    return out as StakePoolData;
}

export interface StakePositionData {
    amount: { toString(): string };
    entryTradingDay: { toString(): string };
    lastClaimTimestamp: { toString(): string };
    daysToUnlock?: number;
    currentWeight?: { toString(): string };
    rewardDebt?: { toString(): string };
    frozenUntilDay?: number;
    freezeBonusBps?: number;
}

export function decodeStakePosition(data: Uint8Array): StakePositionData | null {
    const raw = decode<Record<string, unknown>>(stakingCoder, 'StakePosition', data);
    if (!raw) return null;
    const amount = field<{ toString(): string }>(raw, 'amount');
    const entryTradingDay = field<{ toString(): string }>(raw, 'entryTradingDay', 'entry_trading_day');
    const lastClaimTimestamp = field<{ toString(): string }>(raw, 'lastClaimTimestamp', 'last_claim_timestamp');
    if (!amount || !entryTradingDay || !lastClaimTimestamp) return null;
    // u64 fields decode as BN objects — coerce through toString or every
    // `!== 0` check lies (BN(0) !== 0 is true).
    const num = (v: unknown): number => Number(v?.toString?.() ?? 0);
    return {
        amount,
        entryTradingDay,
        lastClaimTimestamp,
        daysToUnlock: num(field(raw, 'daysToUnlock', 'days_to_unlock')),
        currentWeight: field<{ toString(): string }>(raw, 'currentWeight', 'current_weight'),
        rewardDebt: field<{ toString(): string }>(raw, 'rewardDebt', 'reward_debt'),
        frozenUntilDay: num(field(raw, 'frozenUntilDay', 'frozen_until_day')),
        freezeBonusBps: num(field(raw, 'freezeBonusBps', 'freeze_bonus_bps')),
    };
}

export function decodeAmmState(data: Uint8Array): AmmStateData | null {
    return decode<AmmStateData>(ammCoder, 'AmmState', data);
}

export function decodeOfferList(data: Uint8Array): OfferListData | null {
    return decode<OfferListData>(ammCoder, 'OfferList', data);
}

/* ── Live price helpers ── */

const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

function tokenAmount(data: Uint8Array | null): bigint | null {
    if (!data || data.length < 72) return null;
    return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}

// ── On-chain TWAP mirror (programs/amm/src/instructions/raydium.rs) ──────
// The AMM prices every claim off read_cpmm_price_floor: a time-weighted
// sample of the pinned pool's observation ring when that ring is fresh and
// dense, the raw vault-ratio only as a fallback. The desk MUST gate buys on
// the same quantity — quoting against the raw ratio while the chain charges
// the TWAP is exactly how "10.2% off, buyable" turned into a
// FloorHeldAtSpot revert. These constants and this math mirror the Rust
// 1:1; move them together.
const TWAP_WINDOW_SECONDS = 600n;
const TWAP_MAX_AGE_SECONDS = 600n;
const OBSERVATION_NUM = 100;
// ObservationState: disc(8) + initialized(1) + index(2) + padding(32).
const OBSERVATION_HEADER_LEN = 43;
// Observation: block_timestamp(8) + cumulative_token_0_price_x32(16)
//            + cumulative_token_1_price_x32(16).
const OBSERVATION_SIZE = 40;
const Q32 = 1n << 32n;
// Floor units = USDC price per whole token × 1e9 (nano-dollar). Must equal
// programs/amm raydium::FLOOR_UNITS_PER_Q32 (see the Rust comment for why
// this is 1e12 and not 1e9).
const FLOOR_UNITS_PER_Q32 = 1_000_000_000_000n;

export interface LivePriceData {
    /** Claim-consistent AFHO/USDC price in floor units: the pinned pool's
     *  TWAP when its ring is fresh+dense, else the raw vault ratio — the
     *  exact quantity read_cpmm_price_floor hands to offer_claim. */
    afhoUsdc: bigint | null;
    /** True when afhoUsdc is the observation-ring TWAP (not the vault-ratio
     *  fallback). The desk surfaces it so buyers can tell a settled price
     *  from a just-moved one. */
    afhoPriceIsTwap: boolean;
    solUsdc: bigint | null;
    /**
     * Raw vault reserves of the pinned SOL/USDC pool — the exact numbers the
     * on-chain offer_claim_sol charge solve reads at claim time. Null when
     * the pool isn't pinned or a vault wasn't readable; 0 means the vault
     * exists but is empty (the UI can distinguish both from unknown).
     */
    solPoolReserves: { wsolRaw: bigint; usdcRaw: bigint } | null;
}

/**
 * The accounts needed to compute both legs of the live price, in fixed order:
 * [afhoPoolVault, usdcPoolVault, solUsdcInputVault, solUsdcOutputVault,
 *  afhoPoolState, afhoObservation]. The last two feed the TWAP mirror of
 *  raydium::read_cpmm_price_floor — without them the desk would gate buys on
 *  the raw vault ratio while the chain prices claims off the TWAP.
 *
 * Pricing is pool-only: no mock oracle fallbacks. Unpinned pools are
 * PublicKey.default placeholders (the RPC answers null for them), so one
 * getMultipleAccountsInfo covers the entire price read with no extra
 * round-trips. solUsdc stays null until the SOL/USDC pool is pinned.
 */
export function derivePriceAccounts(ammState: AmmStateData, mint: PublicKey): PublicKey[] {
    const cpmmPoolState = pub(ammState, 'cpmmPoolState', 'cpmm_pool_state');
    const cpmmProgram = pub(ammState, 'cpmmProgram', 'cpmm_program');
    const usdcMint = pub(ammState, 'usdcMint', 'usdc_mint');
    const cpmmSolUsdcPool = pub(ammState, 'cpmmSolUsdcPool', 'cpmm_sol_usdc_pool');

    let afhoPoolVault: PublicKey | null = null;
    let usdcPoolVault: PublicKey | null = null;
    let solUsdcInputVault: PublicKey | null = null;
    let solUsdcOutputVault: PublicKey | null = null;
    let afhoObservation: PublicKey | null = null;

    if (cpmmPoolState && cpmmProgram && usdcMint) {
        [afhoPoolVault] = PublicKey.findProgramAddressSync(
            [Buffer.from('pool_vault'), cpmmPoolState.toBuffer(), mint.toBuffer()],
            cpmmProgram,
        );
        [usdcPoolVault] = PublicKey.findProgramAddressSync(
            [Buffer.from('pool_vault'), cpmmPoolState.toBuffer(), usdcMint.toBuffer()],
            cpmmProgram,
        );
        [afhoObservation] = PublicKey.findProgramAddressSync(
            [Buffer.from('observation'), cpmmPoolState.toBuffer()],
            cpmmProgram,
        );
    }

    if (cpmmSolUsdcPool && cpmmProgram && usdcMint) {
        [solUsdcInputVault] = PublicKey.findProgramAddressSync(
            [Buffer.from('pool_vault'), cpmmSolUsdcPool.toBuffer(), WSOL_MINT.toBuffer()],
            cpmmProgram,
        );
        [solUsdcOutputVault] = PublicKey.findProgramAddressSync(
            [Buffer.from('pool_vault'), cpmmSolUsdcPool.toBuffer(), usdcMint.toBuffer()],
            cpmmProgram,
        );
    }

    return [
        afhoPoolVault ?? PublicKey.default,
        usdcPoolVault ?? PublicKey.default,
        solUsdcInputVault ?? PublicKey.default,
        solUsdcOutputVault ?? PublicKey.default,
        cpmmPoolState ?? PublicKey.default,
        afhoObservation ?? PublicKey.default,
    ];
}

function u128le(d: Uint8Array, off: number): bigint {
    let out = 0n;
    for (let i = 15; i >= 0; i--) out = (out << 8n) | BigInt(d[off + i]);
    return out;
}

/** Exact port of raydium::read_twap_sample: (dcum, dt) over the last 600s,
 *  or null when the ring is uninitialized / empty / stale (latest obs older
 *  than TWAP_MAX_AGE_SECONDS) / too sparse (dt > 2 × window) — every null
 *  case makes the on-chain reader fall back to the vault ratio. */
export function readTwapSample(
    obs: Uint8Array,
    nowSec: number,
): { dcum: bigint; dt: bigint } | null {
    if (obs.length < OBSERVATION_HEADER_LEN + OBSERVATION_NUM * OBSERVATION_SIZE) return null;
    if (obs[8] === 0) return null; // oracle not initialized
    const idx = obs[9] | (obs[10] << 8);
    const read = (i: number) => {
        const s = OBSERVATION_HEADER_LEN + (i % OBSERVATION_NUM) * OBSERVATION_SIZE;
        return { blockTimestamp: readU64le(obs, s), cum0: u128le(obs, s + 8) };
    };
    const latest = read(idx);
    if (latest.blockTimestamp === 0n) return null;
    const now = BigInt(Math.max(0, Math.trunc(nowSec)));
    // A latest observation in the future (clock skew) is as unusable as a
    // stale one — the on-chain Clock read would simply be ≥ the timestamps.
    if (now < latest.blockTimestamp || now - latest.blockTimestamp > TWAP_MAX_AGE_SECONDS) {
        return null;
    }
    // Walk backwards to the newest observation at or before (now − window).
    let oldest: { blockTimestamp: bigint; cum0: bigint } | null = null;
    for (let step = 0; step < OBSERVATION_NUM; step++) {
        const o = read(idx + OBSERVATION_NUM - step);
        if (o.blockTimestamp === 0n) break;
        oldest = o;
        if (
            o.blockTimestamp <= now - TWAP_WINDOW_SECONDS ||
            o.blockTimestamp <= latest.blockTimestamp - TWAP_WINDOW_SECONDS
        ) {
            break;
        }
    }
    if (!oldest) return null;
    const dt = latest.blockTimestamp - oldest.blockTimestamp;
    if (dt === 0n) return null; // single observation / same slot
    // The ring must be dense enough to actually span the window.
    if (dt > TWAP_WINDOW_SECONDS * 2n) return null;
    const dcum = latest.cum0 >= oldest.cum0 ? latest.cum0 - oldest.cum0 : 0n;
    return { dcum, dt };
}

function readU64le(d: Uint8Array, off: number): bigint {
    let out = 0n;
    for (let i = 7; i >= 0; i--) out = (out << 8n) | BigInt(d[off + i]);
    return out;
}

/** Exact port of raydium::q32_to_floor for (dcum, dt): floor-units price of
 *  the pool's base token. token0IsBase mirrors the pool's mint order — the
 *  CPMM stores mints sorted, so either orientation occurs. */
export function q32ToFloor(dcum: bigint, dt: bigint, token0IsBase: boolean): bigint | null {
    if (token0IsBase) {
        // Direct: twap = dcum/dt is quote_raw/base_raw × Q32.
        return (dcum * FLOOR_UNITS_PER_Q32) / dt / Q32;
    }
    // Inverted: 1/twap = dt/dcum × Q32.
    if (dcum === 0n) return null;
    return (dt * Q32 * FLOOR_UNITS_PER_Q32) / dcum;
}

/**
 * The claim-consistent AFHO/USDC price: the pool's TWAP when its observation
 * ring is fresh and dense — the exact number offer_claim will gate and price
 * against — falling back to the instantaneous vault ratio in precisely the
 * cases the on-chain reader falls back (uninitialized/stale/sparse ring).
 * The SOL leg stays a raw vault ratio: offer_claim_sol solves its charge
 * against the pool's live reserves, not a TWAP.
 */
export function computeLivePrice(
    infos: Array<{ data: Uint8Array } | null>,
    baseMint?: PublicKey,
    quoteMint?: PublicKey,
): LivePriceData {
    // POOL-ONLY pricing — no mock oracle fallbacks on either leg. The AFHO
    // price is the pinned AFHO/USDC pool (TWAP when fresh, else vault
    // ratio); the SOL price is the pinned SOL/USDC pool vault ratio. Until a
    // pool is pinned its leg is null: the UI shows "—" and gates the
    // affected flows (fail closed).
    const [afhoVaultInfo, usdcVaultInfo, solInInfo, solOutInfo, afhoPoolStateInfo, afhoObservationInfo] = infos;

    let afhoUsdc: bigint | null = null;
    const baseRaw = tokenAmount(afhoVaultInfo?.data ?? null);
    const quoteRaw = tokenAmount(usdcVaultInfo?.data ?? null);
    if (baseRaw !== null && quoteRaw !== null && baseRaw > 0n) {
        afhoUsdc = (quoteRaw * 1_000_000_000_000n) / baseRaw;
    }
    let afhoPriceIsTwap = false;
    if (afhoUsdc !== null && baseMint && quoteMint && afhoPoolStateInfo?.data && afhoObservationInfo?.data) {
        // Pool mints sit at fixed offsets in this Raydium CPMM fork's
        // zero-copy PoolState — the SAME offsets pool_state_mints() reads
        // on-chain (programs/amm/src/instructions/raydium.rs): token_mint0
        // @168..200, token_mint1 @200..232. Do NOT "fix" these to the
        // vanilla raydium-cp-swap layout (73/105) — this fork's header is
        // larger, and wrong offsets make the orientation check fail, which
        // silently demotes the desk to the instant vault ratio while the
        // chain still gates on the TWAP (the 2026-09-09 buy-gate divergence).
        const pd = afhoPoolStateInfo.data;
        const sample = readTwapSample(afhoObservationInfo.data, Date.now() / 1000);
        if (sample && pd.length >= 232) {
            const mint0 = new PublicKey(pd.slice(168, 200));
            const mint1 = new PublicKey(pd.slice(200, 232));
            const token0IsBase = mint0.equals(baseMint) && mint1.equals(quoteMint);
            const token0IsQuote = mint0.equals(quoteMint) && mint1.equals(baseMint);
            if (token0IsBase || token0IsQuote) {
                const twap = q32ToFloor(sample.dcum, sample.dt, token0IsBase);
                if (twap !== null && twap > 0n) {
                    afhoUsdc = twap;
                    afhoPriceIsTwap = true;
                }
            }
        }
    }

    let solUsdc: bigint | null = null;
    const solBase = tokenAmount(solInInfo?.data ?? null);
    const solQuote = tokenAmount(solOutInfo?.data ?? null);
    if (solBase !== null && solQuote !== null && solBase > 0n) {
        solUsdc = (solQuote * 1_000_000_000_000n) / solBase;
    }
    // Raw reserves for the exact claim-charge mirror (lamportsForCostExact):
    // reported whenever both vaults were readable, even if a side is 0, so
    // the UI can tell "unknown" (null) from "empty" (0) pool states.
    const solPoolReserves =
        solBase !== null && solQuote !== null ? { wsolRaw: solBase, usdcRaw: solQuote } : null;
    // NO mock fallback for the SOL leg: the desk price must come from the
    // pinned Raydium SOL/USDC pool vault ratio or not at all. A stale raw-u64
    // stub (b"mock_price" + wSOL) once priced SOL 1000× off here; until
    // `cpmm_sol_usdc_pool` is pinned in AmmState (`anchor run
    // set-sol-usdc-pool`), solUsdc stays null — the UI shows "—" and keeps
    // the SOL currency option disabled (fail closed).

    return { afhoUsdc, afhoPriceIsTwap, solUsdc, solPoolReserves };
}

/* ── wSOL ATA helper for SOL claim path ── */

export function deriveWsolVault(ammStatePda: PublicKey) {
    return getAssociatedTokenAddressSync(WSOL_MINT, ammStatePda, true, TOKEN_PROGRAM_ID);
}

/* ── Generic retry/backoff helper ── */

export function isRateLimitError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /429|rate.?limit|too many requests/i.test(msg);
}

export async function withBackoff<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i <= maxRetries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (!isRateLimitError(err) || i === maxRetries) throw err;
            const delay = Math.min(1000 * 2 ** i, 30000);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw lastErr;
}
