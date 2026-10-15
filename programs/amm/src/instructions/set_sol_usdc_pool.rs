use crate::state::offers_state::AmmState;
use anchor_lang::prelude::*;

use crate::error::AmmError;
use crate::{ CPMM_PROGRAM_MAINNET, PoolPinned };

// Pin the Raydium SOL/USDC CPMM pool used to convert SOL bond payments to USDC
// at claim time (All-USDC route). Authority-only.
//
// OWNERSHIP VALIDATION: same shape as set_cpmm_pool — the pool account is
// passed in and must be owned by a known Raydium cp-swap program
// (layout-independent; refuses dead addresses and non-Raydium programs).
#[derive(Accounts)]
pub struct SetSolUsdcPool<'info> {
    pub cranker: Signer<'info>,
    #[account(
        mut,
        seeds = [b"amm_state", amm_state.afho_mint.as_ref()],
        bump = amm_state.bump,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,
    /// CHECK: validated in the handler — key == pool_state arg and owner is
    /// a known Raydium cp-swap program.
    pub pool_state_acc: AccountInfo<'info>,
}

pub(crate) fn handler(ctx: Context<SetSolUsdcPool>, pool_state: Pubkey, amm_config: Pubkey) -> Result<()> {
    let caller = ctx.accounts.cranker.key();
    // Authority-only: same rationale as set_cpmm_pool — the SOL/USDC pool
    // decides offer_claim_sol pricing and the bounty top-up route.
    require!(
        caller == ctx.accounts.amm_state.authority,
        AmmError::UnauthorizedCaller
    );
    let pool = &ctx.accounts.pool_state_acc;
    require!(pool.key().as_ref() == pool_state.as_ref(), AmmError::InvalidPoolPin);
    require!(
        pool.owner == &CPMM_PROGRAM_MAINNET,
        AmmError::InvalidPoolPin
    );
    let program = *pool.owner;
    ctx.accounts.amm_state.cpmm_sol_usdc_pool = pool_state;
    ctx.accounts.amm_state.cpmm_sol_usdc_config = amm_config;
    emit!(PoolPinned {
        which: 1,
        program,
        pool: pool_state,
        amm_config,
    });
    msg!("SOL/USDC pool pinned: pool {} amm_config {}", pool_state, amm_config);
    Ok(())
}
