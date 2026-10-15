import { useCallback, useMemo } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useQuery } from '@tanstack/react-query';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { STAKING_PROGRAM_ID } from '../../anchor/setup';
import { useChainData } from '../../context/useChainData';
import {
    AMM_PROGRAM_ID,
    big,
    deriveAmmStatePda,
    deriveOfferListPda,
    field,
    pub,
    type AmmStateData,
} from '../../context/chainDataHelpers';
import { lotTokens } from './offerMath.ts';

/* ── types ── */

export interface OfferTierData {
    key: 'sml' | 'med' | 'big';
    tier: number;
    label: string;
    lotTier: number;
    lotTokens: number;
    vestingDays: number;
    /** Sheet (base) discount, stored tenths of a percent (115 = 11.5%). */
    discountBps: number;
    /** Bonus depth in the same units (5 = +0.5%) while the market is
     *  CLOSED (state 2) — the late-nite bonus. 0 in every other state:
     *  the bonus never shows, prices, or applies in extended hours
     *  (state 1). Mirrors offer_claim::quote_claim — the on-chain claim
     *  price uses discountBps + bonusBps. Kept SEPARATE from the base so
     *  the UI can show the base pill plus a distinct bonus pill. */
    bonusBps: number;
    remaining: number;
    totalOffered: number;
}

export interface ClaimAccounts {
    ammState: PublicKey;
    offerList: PublicKey;
    afhoMint: PublicKey;
    usdcMint: PublicKey;
    marketStatus: PublicKey;
    stakingPool: PublicKey;
    stakingVault: PublicKey;
    ammUsdcVault: PublicKey;
    usdcDip: PublicKey;
    usdcRewards: PublicKey;
    ammAfhoVault: PublicKey;
    cpmmPoolState: PublicKey;
    cpmmObservation: PublicKey;
    cpmmInputVault: PublicKey;
    cpmmOutputVault: PublicKey;
}

export interface SolClaimAccounts {
    // Raydium CPMM program. offer_claim_sol CPIs the wSOL→USDC swap into it,
    // and the runtime requires the callee program id to be among the caller
    // instruction's accounts — the client passes it as a remaining account.
    cpmmProgram: PublicKey;
    wsolVault: PublicKey;
    wrappedSolMint: PublicKey;
    solUsdcPoolState: PublicKey;
    solUsdcAmmConfig: PublicKey;
    solUsdcInputVault: PublicKey;
    solUsdcOutputVault: PublicKey;
    solUsdcObservation: PublicKey;
    solUsdcAuthority: PublicKey;
}

export interface OfferDeskData {
    tiers: OfferTierData[];
    livePrice: bigint | null;
    /** True when livePrice is the pinned pool's observation-ring TWAP — the
     *  same quantity the on-chain claim gates against — and false when the
     *  ring was stale/sparse and the raw vault ratio is shown instead. */
    afhoPriceIsTwap: boolean;
    solPrice: bigint | null;
    // Raw vault reserves of the pinned SOL/USDC pool — lets the UI mirror
    // the exact offer_claim_sol charge solve instead of the spot ratio.
    solPoolReserves: { wsolRaw: bigint; usdcRaw: bigint } | null;
    // Address lookup table for v0 SOL claim transactions (nullable: the app
    // falls back to the legacy transaction before scripts/launch/create-claim-alt
    // has run).
    claimLookupTable: string | null;
    floorBasis: bigint;
    afhoDecimals: number;
    usdcDecimals: number;
    marketState: number | null;
    tradingDay: number | null;
    sheetDay: number | null;
    deskOpen: boolean;
    sheetStale: boolean;
    offersLive: boolean;
    /** Alt desk (suspended state only): the fixed-terms sheet, its day, and
     *  whether the window is live right now (state 3 + today's sheet + lots
     *  left). Mirrors alt_offers::quote_alt_claim's gate. */
    altActive: boolean;
    altSheetDay: number | null;
    accounts: ClaimAccounts | null;
    solAccounts: SolClaimAccounts | null;
    loading: boolean;
    error: string | null;
    updatedAt: string | null;
    refresh: () => void;
}

/* ── helpers ── */

const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

function parseTier(key: 'sml' | 'med' | 'big', tier: number, label: string, raw: unknown): OfferTierData {
    const o = (raw ?? {}) as Record<string, unknown>;
    const lotTier = Number(field(o, 'lotSize', 'lot_size') ?? 0);
    return {
        key,
        tier,
        label,
        lotTier,
        lotTokens: lotTokens(lotTier),
        vestingDays: Number(field(o, 'vestingDays', 'vesting_days') ?? 0),
        discountBps: Number(field(o, 'discountBps', 'discount_bps') ?? 0),
        bonusBps: 0, // set per-tick below (state 2 closed-session boost)
        remaining: Number(field(o, 'remaining') ?? 0),
        totalOffered: Number(field(o, 'totalOffered', 'total_offered') ?? 0),
    };
}

function deriveClaimAccounts(
    ammState: AmmStateData,
    ammStatePda: PublicKey,
    offerListPda: PublicKey,
    marketStatusPda: PublicKey,
    mint: PublicKey,
): ClaimAccounts | null {
    const usdcMint = pub(ammState, 'usdcMint', 'usdc_mint');
    const usdcVault = pub(ammState, 'usdcVault', 'usdc_vault');
    const usdcDip = pub(ammState, 'usdcDip', 'usdc_dip');
    const usdcRewards = pub(ammState, 'usdcRewards', 'usdc_rewards');
    const afhoVault = pub(ammState, 'afhoVault', 'afho_vault');
    const stakingPool = pub(ammState, 'stakingPool', 'staking_pool');
    const cpmmPoolState = pub(ammState, 'cpmmPoolState', 'cpmm_pool_state');
    const cpmmProgram = pub(ammState, 'cpmmProgram', 'cpmm_program');

    if (
        !usdcMint ||
        !usdcVault ||
        !usdcDip ||
        !usdcRewards ||
        !afhoVault ||
        !stakingPool ||
        !cpmmPoolState ||
        !cpmmProgram
    ) {
        return null;
    }

    const [stakingVault] = PublicKey.findProgramAddressSync(
        [Buffer.from('vault'), stakingPool.toBuffer()],
        STAKING_PROGRAM_ID,
    );
    const [cpmmObservation] = PublicKey.findProgramAddressSync(
        [Buffer.from('observation'), cpmmPoolState.toBuffer()],
        cpmmProgram,
    );
    const [cpmmInputVault] = PublicKey.findProgramAddressSync(
        [Buffer.from('pool_vault'), cpmmPoolState.toBuffer(), usdcMint.toBuffer()],
        cpmmProgram,
    );
    const [cpmmOutputVault] = PublicKey.findProgramAddressSync(
        [Buffer.from('pool_vault'), cpmmPoolState.toBuffer(), mint.toBuffer()],
        cpmmProgram,
    );

    return {
        ammState: ammStatePda,
        offerList: offerListPda,
        afhoMint: mint,
        usdcMint,
        marketStatus: marketStatusPda,
        stakingPool,
        stakingVault,
        ammUsdcVault: usdcVault,
        usdcDip,
        usdcRewards,
        ammAfhoVault: afhoVault,
        cpmmPoolState,
        cpmmObservation,
        cpmmInputVault,
        cpmmOutputVault,
    };
}

function deriveSolClaimAccounts(
    ammState: AmmStateData,
    ammStatePda: PublicKey,
): SolClaimAccounts | null {
    const cpmmSolUsdcPool = pub(ammState, 'cpmmSolUsdcPool', 'cpmm_sol_usdc_pool');
    const cpmmSolUsdcConfig = pub(ammState, 'cpmmSolUsdcConfig', 'cpmm_sol_usdc_config');
    const cpmmProgram = pub(ammState, 'cpmmProgram', 'cpmm_program');
    const usdcMint = pub(ammState, 'usdcMint', 'usdc_mint');

    if (!cpmmSolUsdcPool || !cpmmSolUsdcConfig || !cpmmProgram || !usdcMint) {
        return null;
    }

    const wsolVault = getAssociatedTokenAddressSync(WSOL_MINT, ammStatePda, true, TOKEN_PROGRAM_ID);

    const [solUsdcInputVault] = PublicKey.findProgramAddressSync(
        [Buffer.from('pool_vault'), cpmmSolUsdcPool.toBuffer(), WSOL_MINT.toBuffer()],
        cpmmProgram,
    );
    const [solUsdcOutputVault] = PublicKey.findProgramAddressSync(
        [Buffer.from('pool_vault'), cpmmSolUsdcPool.toBuffer(), usdcMint.toBuffer()],
        cpmmProgram,
    );
    const [solUsdcObservation] = PublicKey.findProgramAddressSync(
        [Buffer.from('observation'), cpmmSolUsdcPool.toBuffer()],
        cpmmProgram,
    );
    const [solUsdcAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from('vault_and_lp_mint_auth_seed')],
        cpmmProgram,
    );

    return {
        cpmmProgram,
        wsolVault,
        wrappedSolMint: WSOL_MINT,
        solUsdcPoolState: cpmmSolUsdcPool,
        solUsdcAmmConfig: cpmmSolUsdcConfig,
        solUsdcInputVault,
        solUsdcOutputVault,
        solUsdcObservation,
        solUsdcAuthority,
    };
}

function decimalsFromAccountInfo(info: { data: Uint8Array } | null | undefined): number | null {
    if (!info || info.data.length <= 44) return null;
    return info.data[44];
}

/* ── hook ── */

export function useAmmData(): OfferDeskData {
    const { connection } = useConnection();
    const {
        deployment,
        ammState,
        offerList,
        altList,
        marketStatus,
        livePrice,
        livePriceUpdatedAt,
        refresh,
    } = useChainData();

    const ammProgram = useMemo(
        () => (deployment?.ammProgram ? new PublicKey(deployment.ammProgram) : AMM_PROGRAM_ID),
        [deployment?.ammProgram],
    );

    const mint = deployment?.mintKey;
    // Derived keys must be referentially stable: a fresh PublicKey instance
    // every render cascades through `accounts` (memo deps) into OfferLists'
    // balance effect → setBalances every render → "Maximum update depth
    // exceeded" → blank offer desk.
    const ammStatePda = useMemo(
        () => (mint ? deriveAmmStatePda(mint, ammProgram) : null),
        [mint, ammProgram],
    );
    const offerListPda = useMemo(
        () => (mint ? deriveOfferListPda(mint, ammProgram) : null),
        [mint, ammProgram],
    );
    const marketStatusPda = deployment?.marketStatusKey ?? null;

    // Fetch static mint decimals once per session. Everything else is derived
    // from the shared ChainData context, so this hook makes 0–2 RPC calls
    // total instead of 2+ calls every 4 seconds.
    const decimalsQuery = useQuery({
        queryKey: ['ammDecimals', mint?.toBase58() ?? ''],
        queryFn: async () => {
            if (!mint) throw new Error('Mint unknown');
            const info = await connection.getAccountInfo(mint, 'confirmed');
            return {
                afho: decimalsFromAccountInfo(info) ?? 9,
                usdc: 6, // devnet USDC is always 6 dp
            };
        },
        enabled: !!mint,
        staleTime: Infinity,
        gcTime: Infinity,
        refetchOnWindowFocus: false,
    });

    const decimals = decimalsQuery.data ?? { afho: 9, usdc: 6 };

    const { tiers, sheetDay, offersLive } = useMemo(() => {
        if (!offerList) return { tiers: [], sheetDay: null, offersLive: false };
        const list = [
            parseTier('big', 2, 'Bulk lot', field(offerList, 'bigOffer', 'big_offer')),
            parseTier('med', 1, 'Medium lot', field(offerList, 'medOffer', 'med_offer')),
            parseTier('sml', 0, 'Small lot', field(offerList, 'smlOffer', 'sml_offer')),
        ];
        const day = offerList ? Number(big(field(offerList, 'dayIndex', 'day_index'))) : null;
        const live = list.some((t) => t.remaining > 0);
        return { tiers: list, sheetDay: day, offersLive: live };
    }, [offerList]);

    const marketState = marketStatus?.state ?? null;
    const tradingDay = marketStatus?.tradingDay ?? null;
    const nightGate = marketState === 1 || marketState === 2;
    const sheetStale = sheetDay !== null && tradingDay !== null && sheetDay !== tradingDay;
    const deskOpen = nightGate && offersLive && !sheetStale;

    // Alt desk (suspended state, 3): fixed-terms sheet — big −5% / med −4% /
    // sml −3% off LIVE price at claim time, 7/4/3-day vesting (mirrors
    // alt_offers::quote_alt_claim; NO ratchet floor, NO bonus, NO above-spot
    // gate — every tier prices strictly below live by construction). The
    // regular sheet is hidden while the alt window is live.
    const { altTiers, altSheetDay, altOffersLive } = useMemo(() => {
        if (!altList) return { altTiers: [], altSheetDay: null, altOffersLive: false };
        const list = [
            parseTier('big', 2, 'Bulk lot', field(altList, 'bigOffer', 'big_offer')),
            parseTier('med', 1, 'Medium lot', field(altList, 'medOffer', 'med_offer')),
            parseTier('sml', 0, 'Small lot', field(altList, 'smlOffer', 'sml_offer')),
        ];
        const day = Number(big(field(altList, 'dayIndex', 'day_index')));
        const live = list.some((t) => t.remaining > 0);
        return { altTiers: list, altSheetDay: day, altOffersLive: live };
    }, [altList]);

    const altWindowOpen = marketState === 3 && altSheetDay !== null && tradingDay !== null && altSheetDay === tradingDay;
    const altActive = altWindowOpen && altOffersLive;

    const accounts = useMemo(() => {
        if (!ammState || !ammStatePda || !offerListPda || !marketStatusPda || !mint) return null;
        return deriveClaimAccounts(ammState, ammStatePda, offerListPda, marketStatusPda, mint);
    }, [ammState, ammStatePda, offerListPda, marketStatusPda, mint]);

    const solAccounts = useMemo(() => {
        if (!ammState || !ammStatePda) return null;
        return deriveSolClaimAccounts(ammState, ammStatePda);
    }, [ammState, ammStatePda]);

    const doRefresh = useCallback(() => {
        void refresh('amm');
    }, [refresh]);

    const loading =
        !deployment ||
        !marketStatus ||
        !ammState ||
        decimalsQuery.isLoading;

    const error =
        (!deployment && 'Deployment not loaded') ||
        (!ammState && 'AMM state not found — run anchor run amm-init') ||
        (decimalsQuery.error instanceof Error ? decimalsQuery.error.message : null);

    // CLOSED-SESSION BOOST mirror (programs/amm offer_claim::quote_claim):
    // while the market is CLOSED (state 2) every remaining tier prices 0.5%
    // deeper (5 tenths, saturating at the u8 cap); back in extended hours
    // (state 1 = pre-trade) it reverts to the sheet's base discount — and
    // the bonus itself is GONE. The late-nite bonus NEVER shows, prices, or
    // applies outside state 2: a floor at/above spot keeps the tier refused
    // with FloorHeldAtSpot on-chain, and the UI mirrors that refusal
    // instead of inventing a bonus the claim would reject. Kept as a
    // SEPARATE bonusBps field — the UI shows the base discount pill plus a
    // distinct blue bonus pill in state 2, while the cost math sums both
    // to stay exact with the on-chain quote.
    const floorBasis = ammState ? big(field(ammState, 'highestBuybackBasis', 'highest_buyback_basis')) : 0n;
    const tiersDisplay = useMemo(() => {
        // SUSPENDED-STATE OVERRIDE: while the alt window is live, the desk
        // shows the alt sheet ONLY — the regular sheet is hidden (its
        // on-chain claims are DeskClosed-gated in state 3 anyway). Alt tiers
        // display their base discount as-is: no bonus exists on this desk.
        if (altActive) return altTiers.map((t) => ({ ...t, bonusBps: 0 }));
        if (marketState === 2) {
            return tiers.map((t) => ({ ...t, bonusBps: Math.min(t.discountBps + 5, 255) - t.discountBps }));
        }
        return tiers;
    }, [tiers, altTiers, altActive, marketState]);

    return {
        tiers: tiersDisplay,
        livePrice: livePrice.afhoUsdc,
        afhoPriceIsTwap: livePrice.afhoPriceIsTwap,
        solPrice: livePrice.solUsdc,
        solPoolReserves: livePrice.solPoolReserves,
        claimLookupTable: deployment?.claimLookupTable ?? null,
        floorBasis,
        afhoDecimals: decimals.afho,
        usdcDecimals: decimals.usdc,
        marketState,
        tradingDay,
        sheetDay,
        deskOpen,
        sheetStale,
        offersLive,
        altActive,
        altSheetDay,
        accounts,
        solAccounts,
        loading,
        error,
        // Honest freshness: when the last poll tick got rate-limited, the UI
        // shows how stale the displayed price actually is instead of a fake
        // "0s ago" computed from render time.
        updatedAt: livePriceUpdatedAt ? new Date(livePriceUpdatedAt).toISOString() : null,
        refresh: doRefresh,
    };
}
