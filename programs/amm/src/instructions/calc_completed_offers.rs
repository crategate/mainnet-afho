use crate::state::offers_state::{AcceptedOffers, AmmState, Offer, OfferList};
use anchor_lang::prelude::*;

use crate::error::AmmError;

// Fires off at beginning of each trade day.

#[derive(Accounts)]
pub struct CalcCompletedOffers<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"amm_state", amm_state.afho_mint.as_ref()], bump = amm_state.bump,)]
    pub amm_state: Box<Account<'info, AmmState>>,

    #[account(
        mut,
        seeds = [b"offer_list", amm_state.afho_mint.as_ref()],
        bump = offer_list.bump,
    )]
    pub offer_list: Box<Account<'info, OfferList>>,
    /// CHECK: market status PDA, same verification as MakeOffers
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"accepted_offers", amm_state.afho_mint.as_ref()], bump)]
    pub accepted_offers: Box<Account<'info, AcceptedOffers>>,

    // Raydium CPMM AFHO/USDC pool — the ONLY price source (pool pins in
    // AmmState; the handler hard-errors when unset and validates the
    // accounts against the pool's derived PDAs).
    /// CHECK: pool state, pinned to amm_state.cpmm_pool_state in the handler
    pub cpmm_pool_state: Option<AccountInfo<'info>>,
    /// CHECK: pool observation (TWAP ring)
    pub cpmm_observation: Option<AccountInfo<'info>>,
    /// CHECK: pool USDC vault (quote leg)
    pub cpmm_input_vault: Option<AccountInfo<'info>>,
    /// CHECK: pool AFHO vault (base leg)
    pub cpmm_output_vault: Option<AccountInfo<'info>>,
}

// Ratchet floor decay — fill-modulated, depth-accelerated:
//   grace = locked trading days (live < floor) before decay starts,
//   step  = FLOOR_DECAY_PCT% of the (floor − live) gap per locked day,
//   scaled by DEPTH (×1 at ≤10% gap up to ×7.41 at ≥64.1% — deep crashes re-arm
//   the desk in weeks, not quarters) and modulated by DEMAND (the scored
//   sheet's tier-weighted fill %: a cleared sheet holds the floor, a single
//   pity lot decays at ~full rate — fills can never BLOCK decay, only real
//   demand can SLOW it). Decay is the desk's only bear-recovery path, so it
//   must not be gameable: untaken_days counts consecutive LOCKED days
//   (live < floor) and fills no longer reset it.
const FLOOR_LOCK_GRACE_DAYS: u16 = 5;
const FLOOR_DECAY_PCT: u64 = 1;
// Depth scaling: multiplier = (NUM + depth_bps) / NUM capped at CAP — doubles
// at a 10% gap (depth 1000 bps), 7.41× cap at ≥64.1% (depth 6410 bps).
const FLOOR_DEPTH_SCALE_NUM: u64 = 1_000;
const FLOOR_DEPTH_SCALE_CAP: u64 = 7_410;

/// One locked day's floor decay, in floor units:
///   cut = gap × FLOOR_DECAY_PCT% × depth_factor × keep_pct%
/// keep_pct = 100 − tier-weighted demand (0..=100; 0 = the sheet fully
/// cleared — real demand holds the floor). Returns 0 when keep_pct is 0;
/// otherwise at least 1 floor unit (integer stall guard) and at most `gap`
/// (the floor lands exactly on live, never below).
fn floor_decay_cut(gap: u64, live: u64, keep_pct: u64) -> u64 {
    if keep_pct == 0 || gap == 0 {
        return 0;
    }
    let factor = if live == 0 {
        // Zero live price = unbounded depth: max acceleration.
        FLOOR_DEPTH_SCALE_CAP
    } else {
        let depth_bps = (gap as u128 * 10_000 / live as u128) as u64;
        (FLOOR_DEPTH_SCALE_NUM + depth_bps).min(FLOOR_DEPTH_SCALE_CAP)
    };
    let cut = (gap as u128 * FLOOR_DECAY_PCT as u128 * factor as u128 * keep_pct as u128
        / (100u128 * FLOOR_DEPTH_SCALE_NUM as u128 * 100u128)) as u64;
    cut.max(1).min(gap)
}

pub(crate) fn handler(ctx: Context<CalcCompletedOffers>) -> Result<()> {
    let caller = ctx.accounts.cranker.key();
    require!(
        caller == ctx.accounts.amm_state.authority || caller == ctx.accounts.amm_state.keeper,
        AmmError::UnauthorizedCaller
    );

    // MarketStatus layout: disc(8) + current_state(1) + timestamp(8) + trading_day_index(8)
    let market_data = ctx.accounts.market_status.try_borrow_data()?;
    require!(market_data.len() >= 25, AmmError::InvalidMarketStatus);
    let current_state = market_data[8];
    let current_day = u64::from_le_bytes(market_data[17..25].try_into().unwrap());
    // Only record at the start of a trading day (market just opened)
    require!(current_state == 0, AmmError::InvalidMarketState);
    // Once per trading day
    require!(
        ctx.accounts.accepted_offers.day_index != current_day,
        AmmError::AlreadyConstructed
    );
    ctx.accounts.accepted_offers.day_index = current_day;

    // M2 — only score YESTERDAY's sheet. Without this freshness check a missed
    // make_offers night double-counts the stale sheet's fill %, and a
    // partially-filled stale sheet keeps resetting untaken_days forever,
    // permanently blocking ratchet-floor decay. Day 0 has no yesterday's
    // sheet (L1 inits day_index to u64::MAX), so this correctly errors there.
    require!(
        ctx.accounts.offer_list.day_index == current_day.saturating_sub(1),
        AmmError::StaleOfferSheet
    );

    let offer_list = &ctx.accounts.offer_list;
    let big_pct = pct_accepted(&offer_list.big_offer);
    let med_pct = pct_accepted(&offer_list.med_offer);
    let sml_pct = pct_accepted(&offer_list.sml_offer);

    update_offer_sheet_records(&mut ctx.accounts.accepted_offers, big_pct, med_pct, sml_pct);

    // ── Ratchet floor decay ──
    // The floor only ever moves UP via buyback fills (dex_buyback). When the
    // market falls below it the desk is locked: sheets go untaken (claims
    // fail at the floor) or metrics refuse a sheet at all. After
    // FLOOR_LOCK_GRACE_DAYS straight days with no fills, decay the floor
    // toward the live price by FLOOR_DECAY_PCT of the gap per trading day —
    // exponential convergence that never crosses below live and never zeroes.
    let live_price = {
        let amm_state = &ctx.accounts.amm_state;
        let pinned = amm_state.cpmm_pool_state != Pubkey::default();
        require!(pinned, AmmError::PoolNotPinned);
        let clock = Clock::get()?;
        let pool_state = ctx
            .accounts
            .cpmm_pool_state
            .as_ref()
            .ok_or(AmmError::InvalidPoolAccount)?;
        let observation = ctx
            .accounts
            .cpmm_observation
            .as_ref()
            .ok_or(AmmError::InvalidPoolAccount)?;
        let base_vault = ctx
            .accounts
            .cpmm_output_vault
            .as_ref()
            .ok_or(AmmError::InvalidPoolAccount)?;
        let quote_vault = ctx
            .accounts
            .cpmm_input_vault
            .as_ref()
            .ok_or(AmmError::InvalidPoolAccount)?;
        require!(
            pool_state.key() == amm_state.cpmm_pool_state,
            AmmError::InvalidPoolAccount
        );
        require!(
            observation.key()
                == crate::instructions::raydium::observation_pda(
                    &amm_state.cpmm_program,
                    amm_state.cpmm_pool_state
                )
                .0,
            AmmError::InvalidPoolAccount
        );
        require!(
            quote_vault.key()
                == crate::instructions::raydium::pool_vault_pda(
                    &amm_state.cpmm_program,
                    amm_state.cpmm_pool_state,
                    amm_state.usdc_mint
                )
                .0,
            AmmError::InvalidPoolAccount
        );
        require!(
            base_vault.key()
                == crate::instructions::raydium::pool_vault_pda(
                    &amm_state.cpmm_program,
                    amm_state.cpmm_pool_state,
                    amm_state.afho_mint
                )
                .0,
            AmmError::InvalidPoolAccount
        );
        super::raydium::read_cpmm_price_floor(
            pool_state,
            observation,
            base_vault,
            quote_vault,
            &amm_state.afho_mint,
            &amm_state.usdc_mint,
            clock.unix_timestamp as u64,
        )
        .ok_or(AmmError::InvalidOracle)?
    };
    let amm_state = &mut ctx.accounts.amm_state;
    let floor = amm_state.highest_buyback_basis;

    // ── Ratchet floor decay (fill-modulated, depth-accelerated) ──
    // Runs on EVERY locked trading day (live < floor) after the grace; fills
    // only modulate the rate (see floor_decay_cut). untaken_days counts
    // consecutive locked days and resets only when the price recovers to or
    // above the floor — the old any-fill reset let a ~$0.05 lot freeze
    // decay forever.
    if live_price >= floor {
        amm_state.untaken_days = 0;
    } else {
        amm_state.untaken_days = amm_state.untaken_days.saturating_add(1);
        if amm_state.untaken_days > FLOOR_LOCK_GRACE_DAYS {
            let gap = floor - live_price;
            // Today's demand, tier-weighted like offer_accepted_aggression
            // (big×4, med×2, sml×1; weight sum 700): 0 = nothing taken,
            // 100 = the whole sheet cleared.
            let demand =
                ((big_pct as u32 * 4 + med_pct as u32 * 2 + sml_pct as u32) * 100 / 700) as u64;
            let cut = floor_decay_cut(gap, live_price, 100 - demand.min(100));
            if cut > 0 {
                amm_state.highest_buyback_basis = floor - cut;
                msg!(
                    "floor decay locked day {}: {} -> {} (live {}, demand {}%, cut {})",
                    amm_state.untaken_days,
                    floor,
                    amm_state.highest_buyback_basis,
                    live_price,
                    demand,
                    cut,
                );
            }
        }
    }

    Ok(())
}

// % of the tier that buyers cleared: 100 = sold out, 0 = untouched / no offers that day
fn pct_accepted(offer: &Offer) -> u8 {
    if offer.total_offered == 0 {
        return 0;
    }
    let cleared = (offer.total_offered - offer.remaining) as u64;
    (cleared * 100 / offer.total_offered as u64).min(100) as u8
}

#[cfg(test)]
mod floor_decay_tests {
    use super::*;

    // The devnet case: floor 5110 vs live 3600 (42% gap). Depth 4194 bps →
    // factor 5194 → 1% × 5.194 ≈ 5.2% of the gap per locked day.
    #[test]
    fn deep_gap_decays_fast() {
        assert_eq!(floor_decay_cut(1510, 3600, 100), 78);
    }

    #[test]
    fn full_demand_holds_the_floor() {
        assert_eq!(floor_decay_cut(1510, 3600, 0), 0);
    }

    #[test]
    fn a_pity_lot_decays_at_essentially_full_rate() {
        // 1 lot of a 374-lot sml sheet ≈ 0.3% demand → demand rounds to 0 →
        // keep 100; keep 99 is within one floor unit of full rate.
        assert_eq!(floor_decay_cut(1510, 3600, 100), 78);
        assert_eq!(floor_decay_cut(1510, 3600, 99), 77);
    }

    #[test]
    fn depth_factor_caps_at_seven_four_one_x() {
        // 90% gap: depth 9000 bps → factor capped at 7410 → 7.41%/day.
        assert_eq!(floor_decay_cut(900, 1000, 100), 66);
    }

    #[test]
    fn shallow_gap_stays_gentle_but_never_stalls() {
        // 1% gap: depth 100 bps → factor 1100 → 1.1% of gap; below one
        // floor unit the integer stall guard lifts the cut to 1.
        assert_eq!(floor_decay_cut(10, 1000, 100), 1);
        assert_eq!(floor_decay_cut(1000, 100_000, 100), 11);
    }

    #[test]
    fn cut_never_exceeds_the_gap() {
        assert_eq!(floor_decay_cut(2, 98, 100), 1);
        assert_eq!(floor_decay_cut(1, 99, 100), 1);
    }

    #[test]
    fn zero_live_price_uses_max_acceleration() {
        assert_eq!(floor_decay_cut(1000, 0, 100), 74);
    }

    #[test]
    fn stall_guard_lands_exactly_on_live_never_below() {
        // 7.41% of a 1- or 2-unit gap truncates to 0; the integer stall
        // guard lifts the cut to 1 and .min(gap) keeps it at the gap, so the
        // floor lands exactly on live and never crosses below it.
        assert_eq!(floor_decay_cut(1, 100, 100), 1);
        assert_eq!(floor_decay_cut(2, 100, 100), 1);
    }
}

// Update percentages of the AcceptedOffers account
fn update_offer_sheet_records(
    accepted: &mut AcceptedOffers,
    big_pct: u8,
    med_pct: u8,
    sml_pct: u8,
) {
    accepted.big_offers_accepted.copy_within(1.., 0);
    accepted.big_offers_accepted[4] = big_pct;

    accepted.med_offers_accepted.copy_within(1.., 0);
    accepted.med_offers_accepted[4] = med_pct;

    accepted.sml_offers_accepted.copy_within(1.., 0);
    accepted.sml_offers_accepted[4] = sml_pct;
}
