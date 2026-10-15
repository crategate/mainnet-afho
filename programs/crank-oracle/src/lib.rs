//! AFHO market-status crank oracle (native solana-program build; the anchor
//! IDL shim in `idl_spec.rs` is never deployed).
//!
//! Three trust sources, zero signers of opinions:
//!   1. **Calendar** (`market_calendar` PDA) — the published NYSE schedule,
//!      evaluated against Solana's clock. Session times are FROZEN at init;
//!      the calendar authority holds only the mutable data (tz/DST, holidays,
//!      breaker venue re-pins), queued as pending and activated at the next
//!      bell.
//!   2. **Circuit breaker** (`halt.rs`) — NYSE Rule 7.12 computed from two
//!      pinned SPYx/USDC Raydium CLMM pools; detected from market state,
//!      never declared by a signer.
//!   3. **Bounty** (`bounty.rs`) — the permissionless transition race.

#[cfg(not(feature = "idl-build"))]
mod bounty;
#[cfg(not(feature = "idl-build"))]
mod calendar;
mod constants;
#[cfg(not(feature = "idl-build"))]
mod halt;
#[cfg(not(feature = "idl-build"))]
mod handlers;
#[cfg(not(feature = "idl-build"))]
mod state;

#[cfg(not(feature = "idl-build"))]
use constants::*;
// idl_spec's `#[derive(Accounts)]` references `crate::ID`.
#[allow(unused_imports)]
pub use constants::ID;

// The anchor entrypoint for the IDL-generation shim (idl_spec) lives in its
// own module, but its `#[no_mangle] entrypoint` symbol would collide with
// this one under `--features idl-build`, so the native entrypoint is gated
// out there. The idl-build variant is never deployed — it only regenerates
// target/idl/crank_oracle.json.
#[cfg(not(feature = "idl-build"))]
solana_program::entrypoint!(process_instruction);

#[cfg(not(feature = "idl-build"))]
pub fn process_instruction(
    program_id: &solana_program::pubkey::Pubkey,
    accounts: &[solana_program::account_info::AccountInfo],
    ix_data: &[u8],
) -> solana_program::entrypoint::ProgramResult {
    use handlers::*;
    if program_id != &ID {
        return Err(solana_program::program_error::ProgramError::IncorrectProgramId);
    }
    let disc: [u8; 8] = ix_data
        .get(..8)
        .ok_or(solana_program::program_error::ProgramError::InvalidInstructionData)?
        .try_into()
        .unwrap();
    match disc {
        DISC_INITIALIZE_BOUNTY => initialize_bounty(accounts, &ix_data[8..]),
        DISC_FUND_BOUNTY => fund_bounty(accounts, &ix_data[8..]),
        DISC_PERMISSIONLESS_CRANK => permissionless_crank(accounts, &ix_data[8..]),
        DISC_READ_ORACLE_DATA => read_oracle_data(accounts, &ix_data[8..]),
        DISC_INITIALIZE_STATE => initialize_state(accounts, &ix_data[8..]),
        DISC_SET_AUTHORITY => set_authority(accounts, &ix_data[8..]),
        DISC_SET_BOUNTY_AMOUNT => set_bounty_amount(accounts, &ix_data[8..]),
        DISC_SET_BOUNTY_USD => set_bounty_usd(accounts, &ix_data[8..]),
        DISC_INITIALIZE_CALENDAR => initialize_calendar(accounts, &ix_data[8..]),
        DISC_SET_TIMEZONE => set_timezone(accounts, &ix_data[8..]),
        DISC_SET_HOLIDAYS => set_holidays(accounts, &ix_data[8..]),
        DISC_SET_CALENDAR_AUTHORITY => set_calendar_authority(accounts, &ix_data[8..]),
        DISC_SET_HALT_POOLS => set_halt_pools(accounts, &ix_data[8..]),
        _ => Err(solana_program::program_error::ProgramError::InvalidInstructionData),
    }
}

// ─────────────────── IDL-generation spec (anchor, idl-build only) ─────────────
#[cfg(feature = "idl-build")]
mod idl_spec;

#[cfg(feature = "idl-build")]
pub(crate) use idl_spec::instruction;

#[cfg(feature = "idl-build")]
pub(crate) use idl_spec::{
    __client_accounts_fund_bounty, __client_accounts_initialize_bounty,
    __client_accounts_initialize_calendar, __client_accounts_initialize_state,
    __client_accounts_permissionless_crank, __client_accounts_read_oracle_data,
    __client_accounts_set_calendar_authority, __client_accounts_set_timezone,
    __client_accounts_set_holidays, __client_accounts_set_halt_pools,
    __client_accounts_update_bounty,
};

#[cfg(all(test, not(feature = "idl-build")))]
mod tests;
