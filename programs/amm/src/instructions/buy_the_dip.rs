// programs/amm/src/instructions/buy_the_dip.rs
//
// The dip buyer — "always on" counterpart to dex_buyback. Not gated on market
// state or offer fills: any time the live spot price sits below the recent
// norm, the protocol spends a slice of the dip reserve (the 10% claim split)
// buying AFHO back.
//
// Spec (modeled in sim/dip.py + sim/run_dip.py):
//   reference = mean of the nonzero samples in the high-frequency spot ring
//               (MarketMetrics.spot_prices, self-sampled on every call,
//               throttled to one write per SPOT_SAMPLE_SLOTS)
//   depth_bps = (reference - spot) * 10000 / reference
//   trigger   : depth_bps >= DIP_TRIGGER_BPS (3% below the recent norm)
//   size      = DIP_BASE_SPEND_BPS x (depth/FULL_DEPTH)^2 x trend_mult
//               (quadratic: shallow dips stay cheap, powder kept for deeper)
//   trend_mult= clamp(10000 + slope*10, 2500, 12500) — recent-5 vs older-15
//               mean of the 20-day price_changes ring; knife guard at 25%
//   day cap   = DIP_DAY_CAP_BPS of the day-start reserve snapshot per leg
//   pacing    = one slice per DIP_MIN_SLICE_SLOTS (same rhythm as dex_buyback)
//
// Fills ratchet highest_buyback_basis exactly like dex_buyback fills; bought
// AFHO lands in the main afho_vault (desk inventory). Pricing: the pinned
// Raydium CPMM pool's TWAP (vault-ratio fallback), like every other priced
// instruction — unpinned pool hard-errors.

use crate::state::offers_state::{AmmState, MarketMetrics};
use anchor_lang::prelude::*;

use crate::error::AmmError;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use super::dex_buyback::{
    execute_swap, ratchet_within_band, SwapInfos, MAX_SLIPPAGE_BPS, NOMINAL_SLOT_MS,
    SLICE_INTERVAL_MS,
};

// Spot ring: ~30s between samples (derived from dex_buyback::NOMINAL_SLOT_MS —
// 150 slots @ 200ms; slower chains sample proportionally slower — 60s @
// 400ms, ~25s on devnet's ~167ms today), 32 slots of history, 5 samples
// before the trigger arms (cold start = no dip buys).
const SPOT_SAMPLE_INTERVAL_MS: u64 = 30_000;
const SPOT_SAMPLE_SLOTS: u64 = SPOT_SAMPLE_INTERVAL_MS / NOMINAL_SLOT_MS;
const SPOT_MIN_SAMPLES: usize = 5;

// Trigger/sizing (bps of reference depth, bps of reserve).
const DIP_TRIGGER_BPS: u64 = 300; // 3% below the recent norm
const DIP_FULL_DEPTH_BPS: u64 = 1_000; // 10% below = full aggression
const DIP_BASE_SPEND_BPS: u64 = 2_500; // 25% of reserve at full depth, flat trend
const DIP_TREND_GAIN: i64 = 10; // multiplier bps per centi-percent of slope
const DIP_TREND_FLOOR_BPS: i64 = 2_500; // knife guard: 25% of base
const DIP_TREND_CAP_BPS: i64 = 12_500; // uptrend boost: 125% of base
const DIP_DAY_CAP_BPS: u64 = 4_000; // <=40% of the day-start reserve per leg
// Same rhythm as dex_buyback (~1 slice/min of wall clock at 200ms —
// re-derives with NOMINAL_SLOT_MS; slower chains pace proportionally
// slower). This — not the trigger — is what throttles QUICK dips:
// at 3.5% depth a slice is only
// ~3% of the reserve, so a slow pacing window means a minutes-long dip gets
// one small slice and the ring mean re-adapts before the next one.
const DIP_MIN_SLICE_SLOTS: u64 = SLICE_INTERVAL_MS / NOMINAL_SLOT_MS;

// Same per-sample clamp as calculate_momentum_score.
const SAMPLE_CAP_CP: i64 = 1_000;

#[derive(Accounts)]
pub struct BuyTheDip<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"amm_state", amm_state.afho_mint.as_ref()], bump = amm_state.bump,)]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// CHECK: market status PDA — only the day index is read (dip buys are
    /// allowed in EVERY market state; the day index drives the daily cap)
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"metrics", amm_state.afho_mint.as_ref()], bump)]
    pub metrics: Box<Account<'info, MarketMetrics>>,

    /// 10% claim split — USDC dip reserve (PDA token account, amm_state signs)
    #[account(mut, address = amm_state.usdc_dip)]
    pub usdc_dip: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Swap out-leg destination: main desk inventory
    #[account(mut, address = amm_state.afho_vault)]
    pub afho_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub afho_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = amm_state.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    // --- Raydium CPMM — the ONLY swap venue and price source. The pool pins
    // live in AmmState (set_cpmm_pool); the handler hard-errors when unset
    // and validates every account against the pool's derived PDAs (H1). ---
    #[account(mut)]
    /// CHECK: Raydium CPMM account (validated at CPI time).
    pub cpmm_pool_state: UncheckedAccount<'info>,
    /// CHECK: Raydium CPMM account (validated at CPI time).
    pub cpmm_amm_config: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: Raydium CPMM account (validated at CPI time).
    pub cpmm_input_vault: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: Raydium CPMM account (validated at CPI time).
    pub cpmm_output_vault: UncheckedAccount<'info>,
    #[account(mut)]
    /// CHECK: Raydium CPMM account (validated at CPI time).
    pub cpmm_observation: UncheckedAccount<'info>,
    /// CHECK: Raydium CPMM account (validated at CPI time).
    pub cpmm_authority: UncheckedAccount<'info>,
    /// CHECK: the Raydium CPMM program itself — the runtime refuses the CPI
    /// unless the callee program is among the caller instruction's accounts;
    /// address-pinned to AmmState.cpmm_program.
    #[account(address = amm_state.cpmm_program)]
    pub cpmm_program: UncheckedAccount<'info>,

    /// Classic SPL (USDC in-leg)
    pub token_program: Interface<'info, TokenInterface>,
    /// Token-2022 (AFHO out-leg via the pool)
    pub token_2022_program: Interface<'info, TokenInterface>,
}

// Mean of the nonzero spot-ring samples + how many there were.
fn spot_reference(metrics: &MarketMetrics) -> (u64, usize) {
    let mut sum: u128 = 0;
    let mut n: usize = 0;
    for &p in metrics.spot_prices.iter() {
        if p > 0 {
            sum += p as u128;
            n += 1;
        }
    }
    if n == 0 {
        return (0, 0);
    }
    ((sum / n as u128) as u64, n)
}

// Slope of the chained 20-day metric: recent-5 mean minus older-15 mean,
// centi-percent (exact port of sim/dip.py::trend_slope_cp; truncating
// division, ±SAMPLE_CAP_CP per sample, 0 reads as "no sample").
fn trend_slope_cp(metrics: &MarketMetrics) -> i64 {
    const RECENT: usize = 5;
    let n = metrics.price_changes.len();
    let head = metrics.sample_head as usize % n;
    let mut recent_sum: i64 = 0;
    let mut recent_n: i64 = 0;
    let mut older_sum: i64 = 0;
    let mut older_n: i64 = 0;
    for age in 0..n {
        let raw = metrics.price_changes[(head + age) % n];
        if raw == 0 {
            continue;
        }
        let v = (raw as i64).clamp(-SAMPLE_CAP_CP, SAMPLE_CAP_CP);
        if age >= n - RECENT {
            recent_sum += v;
            recent_n += 1;
        } else {
            older_sum += v;
            older_n += 1;
        }
    }
    let recent = if recent_n > 0 {
        recent_sum / recent_n
    } else {
        0
    };
    let older = if older_n > 0 { older_sum / older_n } else { 0 };
    recent - older
}

// bps of the current dip reserve to spend on this slice (0 = no buy).
fn dip_spend_bps(depth_bps: u64, slope_cp: i64) -> u64 {
    if depth_bps < DIP_TRIGGER_BPS {
        return 0;
    }
    let clamped = depth_bps.min(DIP_FULL_DEPTH_BPS) as u128;
    // quadratic depth: (depth/FULL_DEPTH)^2 in bps
    let depth2 =
        clamped * clamped * 10_000u128 / (DIP_FULL_DEPTH_BPS as u128 * DIP_FULL_DEPTH_BPS as u128);
    let mult =
        (10_000i64 + slope_cp * DIP_TREND_GAIN).clamp(DIP_TREND_FLOOR_BPS, DIP_TREND_CAP_BPS);
    (DIP_BASE_SPEND_BPS as u128 * depth2 * mult as u128 / 100_000_000u128) as u64
}

pub(crate) fn handler(ctx: Context<BuyTheDip>) -> Result<()> {
    let swap = SwapInfos {
        amm_state: ctx.accounts.amm_state.to_account_info(),
        // the vault slot carries the DIP reserve vault here
        usdc_vault: ctx.accounts.usdc_dip.to_account_info(),
        afho_vault: ctx.accounts.afho_vault.to_account_info(),
        afho_mint: ctx.accounts.afho_mint.to_account_info(),
        usdc_mint: ctx.accounts.usdc_mint.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
        token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
        cpmm_pool_state: ctx.accounts.cpmm_pool_state.to_account_info(),
        cpmm_amm_config: ctx.accounts.cpmm_amm_config.to_account_info(),
        cpmm_input_vault: ctx.accounts.cpmm_input_vault.to_account_info(),
        cpmm_output_vault: ctx.accounts.cpmm_output_vault.to_account_info(),
        cpmm_observation: ctx.accounts.cpmm_observation.to_account_info(),
        cpmm_authority: ctx.accounts.cpmm_authority.to_account_info(),
    };

    let amm_state = &mut ctx.accounts.amm_state;
    let caller = ctx.accounts.cranker.key();
    require!(
        caller == amm_state.authority || caller == amm_state.keeper,
        AmmError::UnauthorizedCaller
    );

    // The CPMM pool is the only swap venue: hard-error when unpinned.
    require!(
        amm_state.cpmm_pool_state != Pubkey::default(),
        AmmError::PoolNotPinned
    );
    // H1 re-pin: the swap/pricing accounts must be the pool's own derived
    // PDAs.
    require!(
        super::raydium::pinned_pool_accounts_valid(
            amm_state.cpmm_program,
            amm_state.cpmm_pool_state,
            amm_state.cpmm_amm_config,
            ctx.accounts.afho_mint.key(),
            ctx.accounts.usdc_mint.key(),
            &ctx.accounts.cpmm_pool_state.to_account_info(),
            &ctx.accounts.cpmm_amm_config.to_account_info(),
            &ctx.accounts.cpmm_output_vault.to_account_info(),
            &ctx.accounts.cpmm_input_vault.to_account_info(),
            &ctx.accounts.cpmm_observation.to_account_info(),
            &ctx.accounts.cpmm_authority.to_account_info(),
        ),
        AmmError::InvalidPoolAccount
    );

    // MarketStatus layout: disc(8) + current_state(1) + timestamp(8) + trading_day_index(8)
    let market_data = ctx.accounts.market_status.try_borrow_data()?;
    require!(market_data.len() >= 25, AmmError::InvalidMarketStatus);
    let current_day = u64::from_le_bytes(market_data[17..25].try_into().unwrap());

    let clock = Clock::get()?;
    let spot = super::raydium::read_price(
        &ctx.accounts.cpmm_pool_state.to_account_info(),
        &ctx.accounts.cpmm_observation.to_account_info(),
        &ctx.accounts.cpmm_output_vault.to_account_info(), // AFHO (base) vault
        &ctx.accounts.cpmm_input_vault.to_account_info(),  // USDC (quote) vault
        &ctx.accounts.afho_mint.key(),
        &ctx.accounts.usdc_mint.key(),
        clock.unix_timestamp as u64,
    )
    .ok_or(AmmError::InvalidOracle)?;
    require!(spot > 0, AmmError::InvalidOracle);

    let metrics = &mut ctx.accounts.metrics;

    // Reference = mean of the ring BEFORE this sample goes in, so the fresh
    // (dipped) price doesn't dilute the norm it's measured against.
    let (reference, samples) = spot_reference(metrics);

    // Self-sample the spot price (throttled) — the keeper calling this
    // instruction on every loop is what keeps the ring fresh.
    if clock.slot.saturating_sub(metrics.spot_last_slot) >= SPOT_SAMPLE_SLOTS {
        let head = (metrics.spot_head as usize) % metrics.spot_prices.len();
        metrics.spot_prices[head] = spot;
        metrics.spot_head = ((head + 1) % metrics.spot_prices.len()) as u8;
        metrics.spot_last_slot = clock.slot;
    }

    // Cold start: not enough reference history yet — no dip buys.
    if samples < SPOT_MIN_SAMPLES {
        return Ok(());
    }
    // At/above the norm — nothing to do.
    if spot >= reference {
        return Ok(());
    }
    let depth_bps = ((reference - spot) as u128 * 10_000u128 / reference as u128) as u64;
    let slope = trend_slope_cp(metrics);
    let spend_bps = dip_spend_bps(depth_bps, slope);
    if spend_bps == 0 {
        return Ok(());
    }

    // New trading day: snapshot the dip reserve as today's budget base.
    if amm_state.dip_day_index != current_day {
        amm_state.dip_day_index = current_day;
        amm_state.dip_day_usdc = ctx.accounts.usdc_dip.amount;
        amm_state.dip_spent_usdc = 0;
        amm_state.dip_slice_count = 0;
        amm_state.dip_last_slot = 0;
    }

    // Pacing: at most one slice per DIP_MIN_SLICE_SLOTS.
    if amm_state.dip_last_slot != 0 && clock.slot - amm_state.dip_last_slot < DIP_MIN_SLICE_SLOTS {
        return Ok(());
    }

    let mint_key = amm_state.afho_mint;
    let state_bump = amm_state.bump;

    // ---- USDC leg ----
    let day_cap_usdc = amm_state.dip_day_usdc as u128 * DIP_DAY_CAP_BPS as u128 / 10_000u128;
    let cap_left_usdc = day_cap_usdc.saturating_sub(amm_state.dip_spent_usdc as u128) as u64;
    let slice_usdc = (ctx.accounts.usdc_dip.amount as u128 * spend_bps as u128 / 10_000u128) as u64;
    let slice_usdc = slice_usdc.min(cap_left_usdc);
    if slice_usdc > 0 {
        let before = ctx.accounts.afho_vault.amount;
        // Reserves-preview min-out (see dex_buyback): the TWAP-anchored floor
        // fails into a climbing pool; the pool's own vaults are the truth.
        let min_out = super::raydium::cpmm_swap_min_out_from_vaults(
            &swap.cpmm_input_vault,  // pool USDC (input) vault
            &swap.cpmm_output_vault, // pool AFHO (output) vault
            slice_usdc,
            MAX_SLIPPAGE_BPS,
        )
        .unwrap_or_else(|| {
            if spot > 0 {
                (slice_usdc as u128 * 1_000_000_000_000u128 * 10_000u128
                    / (spot as u128 * (10_000 + MAX_SLIPPAGE_BPS) as u128)) as u64
            } else {
                0
            }
        });
        execute_swap(
            &swap,
            mint_key,
            state_bump,
            slice_usdc,
            min_out,
            amm_state.cpmm_program,
        )?;
        ctx.accounts.afho_vault.reload()?;
        let out = ctx.accounts.afho_vault.amount.saturating_sub(before);
        if out > 0 {
            // M3: fill must sit inside the slippage band vs spot
            ratchet_within_band(
                amm_state,
                (slice_usdc as u128 * 1_000_000_000_000 / out as u128) as u64,
                spot,
            )?;
        }
        amm_state.dip_spent_usdc += slice_usdc;
    }

    if slice_usdc == 0 {
        return Ok(()); // day cap exhausted / empty reserve
    }

    amm_state.dip_slice_count += 1;
    amm_state.dip_last_slot = clock.slot;
    msg!(
        "dip slice {}: depth {}bps, slope {}cp, spend {}bps -> {} usdc (spent {}/{})",
        amm_state.dip_slice_count,
        depth_bps,
        slope,
        spend_bps,
        slice_usdc,
        amm_state.dip_spent_usdc,
        amm_state.dip_day_usdc,
    );
    Ok(())
}
