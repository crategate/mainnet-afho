use crate::state::offers_state::AmmState;
use anchor_lang::prelude::*;

use crate::error::AmmError;
use crate::{ CPMM_PROGRAM_MAINNET, PoolPinned };

// Pin the Raydium CPMM pool the swap adapter routes through. Authority-only
// (the pool only becomes real at launch, so this is set after the one-off
// createPool; a re-pin is the Raydium-rotation maintenance path).
//
// OWNERSHIP VALIDATION: the pool account is passed in and must (1) be the
// account named by the pool_state arg and (2) be owned by the program being
// pinned, which itself must be a known Raydium cp-swap program. This is a
// layout-independent check (no Raydium state parsing — survives a program
// rotation) that refuses dead addresses, typos, and — critically — a
// non-Raydium program, since a hostile program pin would turn the swap CPI
// into attacker code holding the program vaults.
#[derive(Accounts)]
pub struct SetCpmmPool<'info> {
    pub cranker: Signer<'info>,
    #[account(
        mut,
        seeds = [b"amm_state", amm_state.afho_mint.as_ref()],
        bump = amm_state.bump,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,
    /// CHECK: validated in the handler — key == pool_state arg and owner ==
    /// cpmm_program arg (a real cp-swap pool account).
    pub pool_state_acc: AccountInfo<'info>,
}

pub(crate) fn handler(
    ctx: Context<SetCpmmPool>,
    cpmm_program: Pubkey,
    pool_state: Pubkey,
    amm_config: Pubkey,
) -> Result<()> {
    let caller = ctx.accounts.cranker.key();
    // Authority-only: pool pinning decides where every swap routes, so the
    // hot-wallet keeper must not be able to re-pin it to a pool it controls.
    require!(
        caller == ctx.accounts.amm_state.authority,
        AmmError::UnauthorizedCaller
    );
    let pool = &ctx.accounts.pool_state_acc;
    require!(pool.key().as_ref() == pool_state.as_ref(), AmmError::InvalidPoolPin);
    require!(pool.owner == &cpmm_program, AmmError::InvalidPoolPin);
    require!(
        cpmm_program == CPMM_PROGRAM_MAINNET,
        AmmError::InvalidPoolPin
    );
    ctx.accounts.amm_state.cpmm_program = cpmm_program;
    ctx.accounts.amm_state.cpmm_pool_state = pool_state;
    ctx.accounts.amm_state.cpmm_amm_config = amm_config;
    emit!(PoolPinned {
        which: 0,
        program: cpmm_program,
        pool: pool_state,
        amm_config,
    });
    msg!(
        "CPMM pool pinned: program {} pool {} amm_config {}",
        cpmm_program,
        pool_state,
        amm_config
    );
    Ok(())
}
