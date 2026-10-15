use crate::state::offers_state::AmmState;
use anchor_lang::prelude::*;

// Rotate the protocol authority — the key that can re-pin the swap pools and
// rotate the keeper. Authority-only (the outgoing authority signs the handover),
// single-step to match crank-oracle's set_authority. Used to move control onto
// a multisig (e.g. a Squads vault PDA) post-launch; the destination is a
// Pubkey, so it can be a PDA authority that never signs a plain tx itself.
#[derive(Accounts)]
pub struct SetAuthority<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"amm_state", amm_state.afho_mint.as_ref()],
        bump = amm_state.bump,
        has_one = authority,
    )]
    pub amm_state: Box<Account<'info, AmmState>>,
}

pub(crate) fn handler(ctx: Context<SetAuthority>, new_authority: Pubkey) -> Result<()> {
    ctx.accounts.amm_state.authority = new_authority;
    msg!("authority rotated to {}", new_authority);
    Ok(())
}
