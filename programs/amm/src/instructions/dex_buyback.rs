use crate::state::offers_state::AmmState;
use anchor_lang::prelude::*;

use crate::error::AmmError;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

// Nominal slot duration — every slot-denominated interval below (and in
// buy_the_dip.rs) derives from it at COMPILE TIME. 200ms = the floor of
// Solana's staged reduction (SIMD-0525); while chains run slower, wall-clock
// pacing runs slower than design — the conservative direction (unspent budget
// rolls over). Over-cadence only occurs below 200ms. Not re-tunable after
// `--final`; total spend stays bounded by per-slice weights, the 5% band and
// day budgets at any slot time. The keeper logs measured ms/slot.
pub(crate) const NOMINAL_SLOT_MS: u64 = 200;
// Pacing intent: ~1 slice per minute of wall clock (300 slots @ 200ms).
pub(crate) const SLICE_INTERVAL_MS: u64 = 60_000;
// Minimum slots between slices — pacing so one crank burst can't drain the
// day's budget in a single block.
const MIN_SLICE_SLOTS: u64 = SLICE_INTERVAL_MS / NOMINAL_SLOT_MS;
// Slice sizing. The first hour's "lion's share" is a per-day pseudo-random
// target drawn 30%..60% of the day's budget (the vault snapshot), converted to
// a per-slice compounding weight via first_hour_slice_weight_bps() so the ~60
// first-hour slices land on that target. It is NOT gated on fills and does not
// scale to vault size or price — any balance gets spent on any trading day.
// The tail slices 5% of the remaining budget each time, which drains the rest
// well before close.
const TAIL_WEIGHT_BPS: u64 = 500;

// M3 — per-fill sanity band vs the spot oracle: a fill whose exec price
// overpays the oracle by more than this reverts the whole tx, and the floor
// ratchets only inside the band — a price spike into a fill can't pin the
// offer-desk floor above market.
pub(crate) const MAX_SLIPPAGE_BPS: u64 = 500; // 5%

/// Convert a day's hour-1 spend target (bps of the day's budget, 3000..=6000)
/// into the per-slice compounding weight (slice = remaining × weight_bps /
/// 10_000) that spends ~that share over ~60 first-hour slices. w ≈
/// -ln(1-F)/60; the Mercator series is summed in fixed point (no floats on
/// SBF).
fn first_hour_slice_weight_bps(hour1_target_bps: u64) -> u64 {
    let f = hour1_target_bps as u128; // F × 10_000
    // -ln(1-F) scaled by 1e12. term_k = F^k/k × 1e12, advanced as
    // term_{k+1} = term_k × F (F = f/10_000).
    let mut term = f * 100_000_000u128; // F × 1e12 (term 1)
    let mut ln = 0u128;
    let mut k = 1u128;
    while k <= 8 && term > 0 {
        ln += term / k;
        term = term * f / 10_000u128;
        k += 1;
    }
    // weight_bps = (-ln(1-F)) × 10_000 / 60.
    (ln * 10_000u128 / (60u128 * 1_000_000_000_000u128)) as u64
}

#[derive(Accounts)]
pub struct DexBuyback<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"amm_state", amm_state.afho_mint.as_ref()], bump = amm_state.bump,)]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// CHECK: market status PDA (state byte + open timestamp + day index)
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,

    #[account(mut, address = amm_state.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = amm_state.afho_vault)]
    pub afho_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub afho_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = amm_state.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    // --- Raydium CPMM — the ONLY swap venue and price source. The pool pins
    // (program/pool/config) live in AmmState via set_cpmm_pool; the handler
    // hard-errors when they are unset, and validates every account below
    // against the pool's own derived PDAs (H1 re-pin). ---
    /// CHECK: CPMM pool state PDA (pinned in state via set_cpmm_pool)
    #[account(mut)]
    pub cpmm_pool_state: UncheckedAccount<'info>,
    /// CHECK: CPMM amm_config (pinned in state via set_cpmm_pool)
    pub cpmm_amm_config: UncheckedAccount<'info>,
    /// CHECK: pool's input (USDC) vault
    #[account(mut)]
    pub cpmm_input_vault: UncheckedAccount<'info>,
    /// CHECK: pool's output (AFHO) vault
    #[account(mut)]
    pub cpmm_output_vault: UncheckedAccount<'info>,
    /// CHECK: pool's observation (TWAP) account
    #[account(mut)]
    pub cpmm_observation: UncheckedAccount<'info>,
    /// CHECK: pool authority PDA (signs vault/LP-mint transfers)
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

// AccountInfo clones handed to the swap adapter, collected before amm_state
// is mutably borrowed (avoids whole-struct borrow conflicts). Shared with
// distribute_staker_rewards — the `usdc_vault` slot holds whichever vault
// funds the swap (buyback vault or staker-rewards holding vault).
pub(crate) struct SwapInfos<'info> {
    pub amm_state: AccountInfo<'info>,
    pub usdc_vault: AccountInfo<'info>,
    pub afho_vault: AccountInfo<'info>,
    pub afho_mint: AccountInfo<'info>,
    pub usdc_mint: AccountInfo<'info>,
    pub token_program: AccountInfo<'info>,
    pub token_2022_program: AccountInfo<'info>,
    pub cpmm_pool_state: AccountInfo<'info>,
    pub cpmm_amm_config: AccountInfo<'info>,
    pub cpmm_input_vault: AccountInfo<'info>,
    pub cpmm_output_vault: AccountInfo<'info>,
    pub cpmm_observation: AccountInfo<'info>,
    pub cpmm_authority: AccountInfo<'info>,
}

pub(crate) fn handler(ctx: Context<DexBuyback>) -> Result<()> {
    let swap = SwapInfos {
        amm_state: ctx.accounts.amm_state.to_account_info(),
        usdc_vault: ctx.accounts.usdc_vault.to_account_info(),
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
    let current_state = market_data[8];
    let open_ts = i64::from_le_bytes(market_data[9..17].try_into().unwrap());
    let current_day = u64::from_le_bytes(market_data[17..25].try_into().unwrap());
    // Buybacks only execute while the market is OPEN. Fills are deliberately
    // NOT a gate: any balance in the buyback vault is spent on any trading day,
    // whether or not yesterday's offers were taken.
    require!(current_state == 0, AmmError::MarketNotOpen);

    let clock = Clock::get()?;

    // New trading day: snapshot the USDC vault balance as today's budget.
    // Unspent budget stays in the vault — rollover needs no bookkeeping.
    if amm_state.bb_day_index != current_day {
        amm_state.bb_day_index = current_day;
        amm_state.bb_budget_usdc = ctx.accounts.usdc_vault.amount;
        amm_state.bb_spent_usdc = 0;
        amm_state.bb_slice_count = 0;
        amm_state.bb_last_slot = 0;
    }

    // Pacing: at most one slice per MIN_SLICE_SLOTS.
    if amm_state.bb_last_slot != 0 && clock.slot - amm_state.bb_last_slot < MIN_SLICE_SLOTS {
        return Ok(());
    }

    let remaining_usdc = amm_state
        .bb_budget_usdc
        .saturating_sub(amm_state.bb_spent_usdc)
        .min(ctx.accounts.usdc_vault.amount);
    if remaining_usdc == 0 {
        return Ok(());
    }

    // Slice size. The first hour targets a per-day pseudo-random share of the
    // budget (30%..60%, drawn from the day index + mint so a mid-hour keeper
    // restart can't change it), converted to a per-slice compounding weight;
    // the tail slices a flat 5% of the remainder with a 0.5x–1.5x spread so
    // individual tail sizes aren't a fixed ladder.
    let elapsed = (clock.unix_timestamp - open_ts).max(0) as u64;
    let weight_bps = if elapsed < 3_600 {
        let mut day_seed = current_day
            .wrapping_mul(0x9E37_79B9_7F4A_7C15)
            ^ ((amm_state.afho_mint.to_bytes()[0] as u64) << 56)
            ^ ((amm_state.afho_mint.to_bytes()[31] as u64) << 32);
        day_seed ^= day_seed >> 29;
        day_seed = day_seed.wrapping_mul(0xBF58_476D_1CE4_E5B9);
        day_seed ^= day_seed >> 32;
        let hour1_target_bps = 3_000 + (day_seed % 3_001); // 30%..=60%
        first_hour_slice_weight_bps(hour1_target_bps)
    } else {
        TAIL_WEIGHT_BPS
    };
    let x = clock.slot ^ (current_day << 16) ^ amm_state.bb_slice_count as u64;
    // Hour-1 slices use the exact target weight (factor 1.0) so the 30–60%
    // bound holds; tail slices get the 0.5x–1.5x spread.
    let factor_bps = if elapsed < 3_600 {
        10_000
    } else {
        5_000 + (x % 10_001)
    };

    let mint_key = amm_state.afho_mint;
    let state_bump = amm_state.bump;

    // USDC leg.
    let slice_usdc = ((remaining_usdc as u128 * weight_bps as u128 * factor_bps as u128)
        / 100_000_000u128) as u64;
    let slice_usdc = slice_usdc.min(remaining_usdc);
    if slice_usdc > 0 {
        // Live AFHO/USDC price in floor units: pinned CPMM pool TWAP with
        // the pool's own vault-ratio fallback. The mock oracle is gone.
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
        // min-out for the CPMM swap: preview the pool's actual constant-product
        // output from its vault balances (a TWAP-anchored floor ignores the
        // trade's own price impact and fails into a climbing pool). Residual
        // tolerance stays MAX_SLIPPAGE_BPS (5%) for the input fee + concurrent
        // trades; flat-floor fallback only if the vaults are unreadable.
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
        let before = ctx.accounts.afho_vault.amount;
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
            ratchet_within_band(
                amm_state,
                (slice_usdc as u128 * 1_000_000_000_000 / out as u128) as u64,
                spot,
            )?;
        }
        amm_state.bb_spent_usdc += slice_usdc;
    }

    amm_state.bb_slice_count += 1;
    amm_state.bb_last_slot = clock.slot;
    msg!(
        "buyback slice {}: {} usdc (spent {}/{})",
        amm_state.bb_slice_count,
        slice_usdc,
        amm_state.bb_spent_usdc,
        amm_state.bb_budget_usdc,
    );
    Ok(())
}

// Swap adapter: USDC → AFHO via Raydium CPMM swap_base_input ONLY (raw
// invoke_signed — raydium-cpmm-cpi pins anchor 1.0, incompatible with anchor
// 0.31). The mock-dex-pool venue is gone; callers hard-error when the pool
// is unpinned. Everything else in this file is swap-agnostic.
pub(crate) fn execute_swap(
    swap: &SwapInfos,
    mint_key: Pubkey,
    state_bump: u8,
    amount_in: u64,
    min_amount_out: u64,
    cpmm_program: Pubkey,
) -> Result<()> {
    let pool_state = &swap.cpmm_pool_state;
    let amm_config = &swap.cpmm_amm_config;
    let input_vault = &swap.cpmm_input_vault;
    let output_vault = &swap.cpmm_output_vault;
    let observation = &swap.cpmm_observation;
    let authority = &swap.cpmm_authority;
    let ix = crate::instructions::raydium::cpmm_swap_base_input_ix(
        cpmm_program,
        swap.amm_state.key(), // payer (PDA signs)
        authority.key(),
        amm_config.key(),
        pool_state.key(),
        swap.usdc_vault.key(), // input_token_account
        swap.afho_vault.key(), // output_token_account
        input_vault.key(),
        output_vault.key(),
        swap.token_program.key(),      // input token program (USDC)
        swap.token_2022_program.key(), // output token program (AFHO)
        swap.usdc_mint.key(),          // input token mint
        swap.afho_mint.key(),          // output token mint
        observation.key(),
        amount_in,
        min_amount_out,
    );
    let seeds: &[&[u8]] = &[b"amm_state", mint_key.as_ref(), &[state_bump]];
    let infos = vec![
        swap.amm_state.clone(),
        authority.clone(),
        amm_config.clone(),
        pool_state.clone(),
        swap.usdc_vault.clone(),
        swap.afho_vault.clone(),
        input_vault.clone(),
        output_vault.clone(),
        swap.token_program.to_account_info(),
        swap.token_2022_program.to_account_info(),
        swap.usdc_mint.clone(),
        swap.afho_mint.clone(),
        observation.clone(),
    ];
    anchor_lang::solana_program::program::invoke_signed(&ix, &infos, &[seeds])?;
    Ok(())
}

// The ratchet floor is the offer desk's ONLY bear-shutdown mechanism:
// make_offers may never price a lot below the highest realized buyback price,
// so when the live price falls to the floor the desk goes dark on its own.
// It therefore only ever moves UP — call once per executed buyback fill.
// Units: (input raw × 1e12) / afho raw — floor units (nano-USD per whole
// token) for the 6-dp USDC / 9-dp AFHO pair: usdc_raw×1e12/afho_raw =
// price×1e9. buy_the_dip and distribute_staker_rewards ratchet through the
// same helper.
pub(crate) fn ratchet_buyback_basis(amm_state: &mut AmmState, executed_price: u64) {
    if executed_price > amm_state.highest_buyback_basis {
        amm_state.highest_buyback_basis = executed_price;
    }
}

// M3 — gate a fill's ratchet on the spot-oracle band (MAX_SLIPPAGE_BPS).
// Overpaying fills are a hard error, reverting the whole tx — the in-leg
// transfer and the out-leg CPI roll back with it. In-band fills ratchet;
// underpaying fills (exec below oracle) ratchet too — they can only move the
// floor up BELOW market, never pin it above. Missing/unreadable/zero oracle
// fails closed (the read_price check).
pub(crate) fn ratchet_within_band(
    amm_state: &mut AmmState,
    exec_price: u64,
    oracle_price: u64,
) -> Result<()> {
    require!(oracle_price > 0, AmmError::InvalidOracle);
    let cap = (oracle_price as u128 * (10_000 + MAX_SLIPPAGE_BPS) as u128 / 10_000) as u64;
    require!(exec_price <= cap, AmmError::SlippageExceeded);
    ratchet_buyback_basis(amm_state, exec_price);
    Ok(())
}

