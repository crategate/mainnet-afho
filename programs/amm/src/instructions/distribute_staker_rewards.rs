// programs/amm/src/instructions/distribute_staker_rewards.rs
//
// The stakers' 10%: once per trading day, while the market is OPEN, swap the
// balances accumulated in the rewards holding vaults (last night's claim
// share — USDC and/or SOL) into AFHO via the same swap adapter dex_buyback
// uses, then CPI the staking program to deposit the combined AFHO into
// reward_vault — the MasterChef index bump (divided by total_WEIGHTED_stake,
// so lock multipliers are respected) makes it instantly claimable pro-rata.
// Distributing the PREVIOUS day's proceeds at the start of the day is
// deliberate: it's one CPI per day, the day_index guard makes it idempotent,
// and it matches dex_buyback's snapshot-at-open pattern.
//
// If there are no stakers, the funds stay in the holding vaults and roll into
// the next day (the staking program would reject the deposit anyway).

use crate::state::offers_state::AmmState;
use anchor_lang::prelude::*;

use crate::error::AmmError;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use super::dex_buyback::{execute_swap, ratchet_within_band, SwapInfos, MAX_SLIPPAGE_BPS};

#[derive(Accounts)]
pub struct DistributeStakerRewards<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"amm_state", amm_state.afho_mint.as_ref()], bump = amm_state.bump,)]
    pub amm_state: Box<Account<'info, AmmState>>,

    /// CHECK: market status PDA (state byte + day index)
    #[account(
        seeds = [b"market_status"],
        seeds::program = amm_state.crank_program,
        bump
    )]
    pub market_status: UncheckedAccount<'info>,

    /// Staker-rewards holding vault (the 10% USDC claim share)
    #[account(mut, address = amm_state.usdc_rewards)]
    pub usdc_rewards: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Swap out-leg destination + deposit source
    #[account(mut, address = amm_state.afho_vault)]
    pub afho_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub afho_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = amm_state.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,

    // --- Raydium CPMM — the ONLY swap venue and price source. The pool pins
    // live in AmmState (set_cpmm_pool); the handler hard-errors when unset
    // and validates every account against the pool's derived PDAs (H1). ---
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

    // --- staking CPI ---
    pub staking_program: Program<'info, staking::program::Staking>,
    #[account(mut, address = amm_state.staking_pool)]
    pub staking_pool: Box<Account<'info, staking::StakePool>>,
    #[account(mut, address = staking_pool.reward_vault)]
    pub staking_reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// Classic SPL (USDC in-leg)
    pub token_program: Interface<'info, TokenInterface>,
    /// Token-2022 (AFHO out-leg + staking deposit)
    pub token_2022_program: Interface<'info, TokenInterface>,
}

pub(crate) fn handler(ctx: Context<DistributeStakerRewards>) -> Result<()> {
    // AccountInfo clones for the swap adapter, collected before amm_state is
    // mutably borrowed (same pattern as dex_buyback). The vault slots hold
    // the staker-rewards HOLDING vaults here (not the buyback vaults).
    let swap = SwapInfos {
        amm_state: ctx.accounts.amm_state.to_account_info(),
        usdc_vault: ctx.accounts.usdc_rewards.to_account_info(),
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
    let current_day = u64::from_le_bytes(market_data[17..25].try_into().unwrap());
    // Distribute at the start of the trading day (market open).
    require!(current_state == 0, AmmError::MarketNotOpen);
    // Once per trading day.
    require!(
        amm_state.rewards_day_index != current_day,
        AmmError::AlreadyDistributed
    );

    let usdc_in = ctx.accounts.usdc_rewards.amount;
    if usdc_in == 0 {
        // Nothing collected last night — mark the day and move on.
        amm_state.rewards_day_index = current_day;
        return Ok(());
    }
    // No stakers → nothing to distribute to; leave funds for tomorrow.
    if ctx.accounts.staking_pool.total_weighted_stake == 0 {
        msg!("no stakers — rewards stay in the holding vaults");
        return Ok(());
    }

    let mint_key = amm_state.afho_mint;
    let state_bump = amm_state.bump;

    let mut total_out: u64 = 0;

    // ── USDC leg ──
    if usdc_in > 0 {
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
        let before = ctx.accounts.afho_vault.amount;
        // Reserves-preview min-out (see dex_buyback): the TWAP-anchored floor
        // fails into a climbing pool; the pool's own vaults are the truth.
        let min_out = super::raydium::cpmm_swap_min_out_from_vaults(
            &swap.cpmm_input_vault,  // pool USDC (input) vault
            &swap.cpmm_output_vault, // pool AFHO (output) vault
            usdc_in,
            MAX_SLIPPAGE_BPS,
        )
        .unwrap_or_else(|| {
            if spot > 0 {
                (usdc_in as u128 * 1_000_000_000_000u128 * 10_000u128
                    / (spot as u128 * (10_000 + MAX_SLIPPAGE_BPS) as u128)) as u64
            } else {
                0
            }
        });
        execute_swap(
            &swap,
            mint_key,
            state_bump,
            usdc_in,
            min_out,
            amm_state.cpmm_program,
        )?;
        ctx.accounts.afho_vault.reload()?;
        let out = ctx.accounts.afho_vault.amount.saturating_sub(before);
        if out > 0 {
            // USDC leg: (usdc_raw × 1e12) / afho_raw — already floor units.
            // M3: band-checked against the spot oracle.
            ratchet_within_band(
                amm_state,
                (usdc_in as u128 * 1_000_000_000_000 / out as u128) as u64,
                spot,
            )?;
        }
        total_out = total_out.saturating_add(out);
    }

    require!(total_out > 0, AmmError::SwapReturnedNothing);
    amm_state.rewards_day_index = current_day;

    // ── Deposit the AFHO into the staking reward vault ──
    let seeds: &[&[u8]] = &[b"amm_state", mint_key.as_ref(), &[state_bump]];
    staking::cpi::deposit_rewards_from_amm(
        CpiContext::new_with_signer(
            ctx.accounts.staking_program.to_account_info(),
            staking::cpi::accounts::DepositRewardsFromAmm {
                mint: ctx.accounts.afho_mint.to_account_info(),
                pool: ctx.accounts.staking_pool.to_account_info(),
                amm_state: ctx.accounts.amm_state.to_account_info(),
                amm_afho_vault: ctx.accounts.afho_vault.to_account_info(),
                reward_vault: ctx.accounts.staking_reward_vault.to_account_info(),
                token_program: ctx.accounts.token_2022_program.to_account_info(),
            },
            &[seeds],
        ),
        total_out,
    )?;

    msg!(
        "day {}: distributed {} usdc -> {} AFHO to stakers",
        current_day,
        usdc_in,
        total_out
    );
    Ok(())
}
