use crate::state::offers_state::{AmmState, MarketMetrics};
use anchor_lang::prelude::*;

use crate::error::AmmError;
use anchor_spl::token_interface::{Mint, TokenAccount};

use super::helpers_make_offers::{calculate_momentum_score, record_price_change, record_stake_ratio};

// Fires at END of every trading day (after-hours begin / market closes),
// BEFORE make_offers. Owns ALL end-of-day metric writes: today's price sample
// and today's staking ratio. make_offers only READS what this records.
// (Start-of-day offer accounting is calc_completed_offers' job.)

#[derive(Accounts)]
pub struct UpdateTradedayStats<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(seeds = [b"amm_state", amm_state.afho_mint.as_ref()], bump = amm_state.bump,)]
    pub amm_state: Box<Account<'info, AmmState>>,

    #[account(
        mut,
        seeds = [b"metrics", amm_state.afho_mint.as_ref()],
        bump
    )]
    pub market_metrics: Box<Account<'info, MarketMetrics>>,
    /// CHECK: market status PDA
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,

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

    /// Staking pool — the source of truth for total_staked (stake-health
    /// metric). Typed account: owner + discriminator checked automatically.
    #[account(address = amm_state.staking_pool)]
    pub staking_pool: Box<Account<'info, staking::StakePool>>,
    /// AFHO mint — the source of truth for total_supply.
    #[account(address = amm_state.afho_mint)]
    pub afho_mint: Box<InterfaceAccount<'info, Mint>>,
    /// The AMM's own AFHO vault — its balance is subtracted from total_supply
    /// to get the circulating/available supply for the stake ratio.
    #[account(address = amm_state.afho_vault)]
    pub afho_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}

pub(crate) fn handler(ctx: Context<UpdateTradedayStats>) -> Result<()> {
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
    // End of trading day only (extended hours or closed)
    require!(
        current_state == 1 || current_state == 2,
        AmmError::InvalidMarketState
    );
    // Once per trading day
    require!(
        ctx.accounts.market_metrics.day_index != current_day,
        AmmError::AlreadyConstructed
    );
    ctx.accounts.market_metrics.day_index = current_day;

    // Refresh the staking inputs from their on-chain sources of truth before
    // recording today's stake ratio (without this, stake health reads 0).
    ctx.accounts.market_metrics.total_staked = ctx.accounts.staking_pool.total_staked;
    ctx.accounts.market_metrics.total_supply = ctx.accounts.afho_mint.supply;
    ctx.accounts.market_metrics.available_supply = ctx
        .accounts
        .afho_mint
        .supply
        .saturating_sub(ctx.accounts.afho_vault.amount);

    // End-of-day metric writes (helpers_make_offers.rs). The momentum input is
    // a close→close change computed from the live AFHO/USDC price (pinned
    // pool TWAP, vault-ratio fallback): record today's close against the
    // previous day's.
    let spot = {
        let amm_state = &ctx.accounts.amm_state;
        let pinned = amm_state.cpmm_pool_state != Pubkey::default();
        require!(pinned, AmmError::PoolNotPinned);
        let clock = Clock::get()?;
            let pool_state = ctx.accounts.cpmm_pool_state.as_ref().ok_or(AmmError::InvalidPoolAccount)?;
            let observation = ctx.accounts.cpmm_observation.as_ref().ok_or(AmmError::InvalidPoolAccount)?;
            let base_vault = ctx.accounts.cpmm_output_vault.as_ref().ok_or(AmmError::InvalidPoolAccount)?;
            let quote_vault = ctx.accounts.cpmm_input_vault.as_ref().ok_or(AmmError::InvalidPoolAccount)?;
            require!(
                pool_state.key() == amm_state.cpmm_pool_state,
                AmmError::InvalidPoolAccount
            );
            require!(
                observation.key()
                    == crate::instructions::raydium::observation_pda(&amm_state.cpmm_program, amm_state.cpmm_pool_state).0,
                AmmError::InvalidPoolAccount
            );
            require!(
                quote_vault.key()
                    == crate::instructions::raydium::pool_vault_pda(&amm_state.cpmm_program, amm_state.cpmm_pool_state, amm_state.usdc_mint).0,
                AmmError::InvalidPoolAccount
            );
            require!(
                base_vault.key()
                    == crate::instructions::raydium::pool_vault_pda(&amm_state.cpmm_program, amm_state.cpmm_pool_state, amm_state.afho_mint).0,
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
    record_price_change(&mut ctx.accounts.market_metrics, spot);
    record_stake_ratio(&mut ctx.accounts.market_metrics);

    // Freeze-feature writes: the daily momentum snapshot (single computation
    // site — the freeze curve in the staking program reads this scalar) and
    // the frozen-share ring (homepage graph).
    let momentum = calculate_momentum_score(&ctx.accounts.market_metrics);
    ctx.accounts.market_metrics.momentum_score = momentum;
    let staked = ctx.accounts.staking_pool.total_staked;
    let frozen = ctx.accounts.staking_pool.frozen_amount;
    let frozen_pct: u8 = if staked > 0 {
        ((frozen as u128 * 100 / staked as u128) as u8).min(100)
    } else {
        0
    };
    let head = (ctx.accounts.market_metrics.frozen_head as usize) % 30;
    ctx.accounts.market_metrics.frozen_share[head] = frozen_pct;
    ctx.accounts.market_metrics.frozen_head = ((head + 1) % 30) as u8;

    Ok(())
}
