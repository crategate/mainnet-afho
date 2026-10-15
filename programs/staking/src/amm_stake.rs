use crate::{
    calculate_multiplier, get_trading_day_index, StakeError, StakePool, StakePosition,
    UserStakeIndex,
};
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};

// AMM CPI GATE PATTERN
//
// A program ID can never sign (it is an on-curve keypair, not a PDA), so the
// old `amm_program.is_signer` check could never pass. Instead, the AMM's STATE
// PDA signs the CPI (the AMM program produces that signature via
// invoke_signed). The seeds constraint with seeds::program = pool.amm_program
// proves the signer PDA belongs to the authorized AMM program — only that
// program can make it sign.

pub fn create_amm_position(
    ctx: Context<CreateAmmPosition>,
    amount: u64,
    index: u64,
    days_to_unlock: u8,
) -> Result<()> {
    // The amm_state PDA signer + seeds constraint in the accounts struct is
    // the authorization check (see header comment).

    require!(amount > 0, StakeError::ZeroAmount);
    require!(amount >= 100, StakeError::MinStake);
    require!(days_to_unlock > 0, CpiError::InvalidVestingPeriod); // AMM positions MUST vest

    let pool = &mut ctx.accounts.pool;
    let position = &mut ctx.accounts.position;
    let user_index = &mut ctx.accounts.user_index;
    let clock = Clock::get()?;

    // Parity with stake(): positions are only created sequentially at the
    // next free index — an arbitrary index can collide with a future PDA or
    // overflow the next_index increment (index = u64::MAX panics). The AMM
    // already validates this pre-CPI (offer_claim::validate_user_index);
    // enforce it at the staking trust boundary too.
    require!(index == user_index.next_index, StakeError::InvalidIndex);

    let trading_day_index = get_trading_day_index(&ctx.accounts.market_status)?;

    position.owner = ctx.accounts.owner.key();
    position.pool = pool.key();
    position.amount = amount;
    position.entry_trading_day = trading_day_index;
    position.last_claim_timestamp = clock.unix_timestamp;
    position.index = index;
    position.days_to_unlock = days_to_unlock;
    position.bump = ctx.bumps.position;

    user_index.next_index = user_index.next_index.max(index + 1);

    let current_multiplier = calculate_multiplier(0, pool.max_multiplier_bps);
    let weight = (amount as u128 * current_multiplier as u128) / 10_000u128;
    position.current_weight = weight;

    pool.total_staked = pool.total_staked.saturating_add(amount);
    pool.total_weighted_stake = pool.total_weighted_stake.saturating_add(weight);

    // Reward debt prevents claiming rewards distributed before this position
    // existed.
    position.reward_debt = (weight * pool.accrued_reward_per_share) / 1_000_000_000_000u128;

    // Transfer tokens from the AMM vault (authority = amm_state PDA, which
    // signed this CPI) to the pool vault.
    let cpi_accounts = TransferChecked {
        from: ctx.accounts.source_token.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.amm_state.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

    msg!(
        "Staked {} tokens, weight: {}, index: {}",
        amount,
        weight,
        index
    );
    Ok(())
}

// The AMM's daily staker-distribution: AFHO (converted from the 10% USDC
// share by the AMM's swap adapter) moves from the AMM's AFHO vault into the
// reward_vault, and the MasterChef index is bumped so it is immediately
// claimable pro-rata by current stakers.
pub fn deposit_rewards_from_amm(ctx: Context<DepositRewardsFromAmm>, amount: u64) -> Result<()> {
    require!(amount > 0, StakeError::ZeroAmount);

    let pool = &mut ctx.accounts.pool;
    // Without stakers the deposit would strand in reward_vault (the index can
    // never be back-distributed). The AMM skips the call in that case; treat a
    // direct hit as an error rather than burning the tokens.
    require!(pool.total_weighted_stake > 0, StakeError::NoStakers);

    pool.accrued_reward_per_share +=
        (amount as u128 * 1_000_000_000_000u128) / pool.total_weighted_stake;

    let cpi_accounts = TransferChecked {
        from: ctx.accounts.amm_afho_vault.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.reward_vault.to_account_info(),
        authority: ctx.accounts.amm_state.to_account_info(),
    };
    let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    transfer_checked(cpi_ctx, amount, ctx.accounts.mint.decimals)?;

    msg!("AMM deposited {} reward tokens", amount);
    Ok(())
}

#[derive(Accounts)]
#[instruction(amount: u64, index: u64, days_to_unlock: u8)]
pub struct CreateAmmPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>, // The buyer (ultimately receives the position); pays rent

    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"pool", mint.key().as_ref()],
        bump = pool.bump,
        has_one = mint,
    )]
    pub pool: Box<Account<'info, StakePool>>,

    /// AMM state PDA. Its signature proves the caller is the AMM program
    /// stored on the pool (only that program can sign for this PDA).
    /// CHECK: PDA verified by seeds against pool.amm_program
    #[account(
        seeds = [b"amm_state", mint.key().as_ref()],
        bump,
        seeds::program = pool.amm_program,
    )]
    pub amm_state: Signer<'info>,

    #[account(
        init_if_needed,
        payer = owner,
        seeds = [b"user_index", owner.key().as_ref()],
        bump,
        space = 8 + 8
    )]
    pub user_index: Box<Account<'info, UserStakeIndex>>,

    #[account(
        init,
        payer = owner,
        seeds = [
            b"position",
            pool.key().as_ref(),
            owner.key().as_ref(),
            &index.to_le_bytes(),
        ],
        bump,
        space = 8 + StakePosition::INIT_SPACE
    )]
    pub position: Box<Account<'info, StakePosition>>,

    /// AMM's AFHO vault — authority is the amm_state PDA signing this CPI
    #[account(mut, token::mint = mint, token::authority = amm_state)]
    pub source_token: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, address = pool.vault)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: Address verified by pool.market_status_pda constraint
    #[account(address = pool.market_status_pda)]
    pub market_status: UncheckedAccount<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositRewardsFromAmm<'info> {
    pub mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        seeds = [b"pool", mint.key().as_ref()],
        bump = pool.bump,
        has_one = mint,
    )]
    pub pool: Box<Account<'info, StakePool>>,

    /// AMM state PDA — same CPI gate as create_amm_position.
    /// CHECK: PDA verified by seeds against pool.amm_program
    #[account(
        seeds = [b"amm_state", mint.key().as_ref()],
        bump,
        seeds::program = pool.amm_program,
    )]
    pub amm_state: Signer<'info>,

    /// Source: AMM's AFHO vault (authority = amm_state PDA)
    #[account(mut, token::mint = mint, token::authority = amm_state)]
    pub amm_afho_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(mut, address = pool.reward_vault)]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[error_code]
pub enum CpiError {
    #[msg("unauthorized vested amm stake...")]
    UnauthorizedAmm,
    #[msg("positions must vest for at least 1 trading day")]
    InvalidVestingPeriod,
}