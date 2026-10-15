pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

pub use instructions::*;
pub use state::*;

declare_id!("6Bx8dfQJzouVLDMLvzj6AKxe91ggbyTtyFFgLeHWBxKn");

// Pin-time ownership allowlist for the Raydium pool-pin instructions
// (set_cpmm_pool / set_sol_usdc_pool). The pool account passed in must be
// owned by the cp-swap program — a layout-independent check (no Raydium
// state parsing), so it survives a Raydium program rotation while still
// refusing pins of arbitrary pubkeys / non-Raydium programs. A hostile
// program pin is a vault-drain vector (the swap CPI would call attacker
// code), which the signer gate alone does not cover.
pub const CPMM_PROGRAM_MAINNET: Pubkey =
    pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");

/// Emitted by set_cpmm_pool (which=0) / set_sol_usdc_pool (which=1) — the
/// durable rotation signal: indexers / the /authority page can show exactly
/// which pool was pinned, to what program, when.
#[event]
pub struct PoolPinned {
    /// 0 = AFHO/USDC desk pool, 1 = SOL/USDC conversion pool
    pub which: u8,
    pub program: Pubkey,
    pub pool: Pubkey,
    pub amm_config: Pubkey,
}

#[program]
pub mod amm {
    use super::*;

    pub fn initialize_amm(
        ctx: Context<InitializeAmm>,
        staking_pool: Pubkey,
    ) -> Result<()> {
        initialize::handler(ctx, staking_pool)
    }

    pub fn make_offers(ctx: Context<MakeOffers>) -> Result<()> {
        make_offers::handler(ctx)
    }

    pub fn calc_completed_offers(ctx: Context<CalcCompletedOffers>) -> Result<()> {
        calc_completed_offers::handler(ctx)
    }

    // End-of-day metric writes; keeper fires this BEFORE make_offers.
    pub fn update_tradeday_stats(ctx: Context<UpdateTradedayStats>) -> Result<()> {
        update_tradeday_stats::handler(ctx)
    }

    pub fn set_keeper(ctx: Context<SetKeeper>, new_keeper: Pubkey) -> Result<()> {
        set_keeper::handler(ctx, new_keeper)
    }

    pub fn set_authority(ctx: Context<SetAuthority>, new_authority: Pubkey) -> Result<()> {
        set_authority::handler(ctx, new_authority)
    }

    // Pin the Raydium CPMM pool for the swap adapter (authority-only; the
    // pool account is passed in and ownership-validated).
    pub fn set_cpmm_pool(
        ctx: Context<SetCpmmPool>,
        cpmm_program: Pubkey,
        pool_state: Pubkey,
        amm_config: Pubkey,
    ) -> Result<()> {
        set_cpmm_pool::handler(ctx, cpmm_program, pool_state, amm_config)
    }

    // Pin the SOL/USDC pool for All-USDC claim conversion (authority-only;
    // pool account passed in and ownership-validated).
    pub fn set_sol_usdc_pool(
        ctx: Context<SetSolUsdcPool>,
        pool_state: Pubkey,
        amm_config: Pubkey,
    ) -> Result<()> {
        set_sol_usdc_pool::handler(ctx, pool_state, amm_config)
    }

    // Bounty auto-top-up: swap USDC → SOL and fund the crank bounty vault.
    pub fn bounty_top_up(ctx: Context<BountyTopUp>) -> Result<()> {
        bounty_top_up::handler(ctx)
    }

    // Night-desk taking instruction. Buyer pays USDC (SOL support at
    // mainnet); payment splits 80% buyback vault / 10% dip reserve / 10%
    // staker-rewards holding vault at claim time. Purchased AFHO goes
    // directly into a vesting StakePosition via CPI — it never sits in the
    // buyer's wallet. Claims only while the market is after-hours/closed,
    // against the current day's sheet.
    pub fn offer_claim(ctx: Context<OfferClaim>, tier: u8, units: u32, index: u64) -> Result<()> {
        offer_claim::handler(ctx, tier, units, index)
    }

    // Same desk, SOL payment: the USDC-terms cost (same floor, same discount)
    // is charged in lamports and swapped to USDC on the pinned SOL/USDC pool,
    // then splits 80/10/10 into the USDC buyback / dip / staker-rewards vaults.
    pub fn offer_claim_sol(
        ctx: Context<OfferClaimSol>,
        tier: u8,
        units: u32,
        index: u64,
    ) -> Result<()> {
        offer_claim::handler_sol(ctx, tier, units, index)
    }

    // Start-of-day staker distribution: swap yesterday's 10% USDC share into
    // AFHO and deposit it into the staking reward vault (MasterChef index
    // bump → instantly claimable pro-rata). Once per trading day.
    pub fn distribute_staker_rewards(ctx: Context<DistributeStakerRewards>) -> Result<()> {
        distribute_staker_rewards::handler(ctx)
    }

    pub fn dex_buyback(ctx: Context<DexBuyback>) -> Result<()> {
        dex_buyback::handler(ctx)
    }

    // The "always on" dip buyer: spends the 10% dip reserve whenever the live
    // spot price sits >=3% below the recent spot-ring norm; size is quadratic
    // in depth and scaled by the 20-day trend slope. Any market state.
    pub fn buy_the_dip(ctx: Context<BuyTheDip>) -> Result<()> {
        buy_the_dip::handler(ctx)
    }

    // Alt desk sheet post: a second, fixed-terms bond sheet (exactly 5% of
    // the bond vault; big −5%/med −4%/sml −3% off live price at claim time;
    // 7/4/3-day vesting) that the keeper posts ONLY while the market-status
    // feed reports the suspended state (3), at most ONE sheet per trading
    // day. Deliberately a separate instruction family: the night desk's
    // quote_claim pricing, ratchet floor and above-spot gate are untouched,
    // and alt fills never touch the metrics (accepted_offers / demand-keep
    // / ratchet are blind to this desk).
    pub fn make_alt_offers(ctx: Context<MakeAltOffers>) -> Result<()> {
        alt_offers::handler_make(ctx)
    }

    // Alt desk taking instruction (USDC): valid ONLY while the suspended
    // state holds — any 3→(0|1|2) transition retires the sheet. Payment
    // splits 80/10/10 exactly like the night desk; purchased AFHO goes
    // directly into a vesting StakePosition via CPI.
    pub fn alt_offer_claim(
        ctx: Context<AltOfferClaim>,
        tier: u8,
        units: u32,
        index: u64,
    ) -> Result<()> {
        alt_offers::handler_claim(ctx, tier, units, index)
    }

    // Alt desk taking instruction (SOL): the USDC-terms cost is charged in
    // lamports and swapped to USDC on the pinned SOL/USDC pool, then splits
    // 80/10/10 into the USDC buyback / dip / staker-rewards vaults.
    pub fn alt_offer_claim_sol(
        ctx: Context<AltOfferClaimSol>,
        tier: u8,
        units: u32,
        index: u64,
    ) -> Result<()> {
        alt_offers::handler_claim_sol(ctx, tier, units, index)
    }
}
#[derive(Accounts)]
pub struct CompletedOffers<'info> {
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}