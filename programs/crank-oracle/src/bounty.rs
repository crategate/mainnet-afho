//! USD-denominated transition bounty pricing.
//!
//! `lamports = effective_usd_raw × 1e6 / sol_price_floor` where the USD
//! amount compounds `annual_inflation_bps` per year since `base_year`, and
//! the SOL price is read from the vault ratios of the pinned Raydium
//! SOL/USDC CPMM pool (pinned to its derived PDAs — never caller-chosen).
//! Falls back to the fixed lamport amount when no pool is pinned.

use solana_program::{
    account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey, rent::Rent,
    sysvar::Sysvar,
};

use crate::calendar::civil_from_days;
use crate::constants::*;
use crate::state::BountyConfig;

/// Calendar year from a unix timestamp (exact integer civil-date algorithm).
pub fn year_from_unix(ts: i64) -> u16 {
    civil_from_days(ts.div_euclid(86_400)).0 as u16
}

/// Base USD bounty compounded by `annual_inflation_bps` per calendar year
/// since `base_year`.
pub fn effective_bounty_usd(cfg: &BountyConfig, year: u16) -> Result<u64, ProgramError> {
    let years = (year as u32).saturating_sub(cfg.base_year as u32);
    let mut usd = cfg.bounty_usd_raw as u128;
    let scale = 10_000u128 + cfg.annual_inflation_bps as u128;
    for _ in 0..years {
        usd = usd.checked_mul(scale).ok_or(ProgramError::Custom(ERR_MATH_OVERFLOW))? / 10_000;
    }
    Ok(usd as u64)
}

/// SPL/Token-2022 token-account `amount` (u64 LE at offset 64).
fn token_account_amount(account: &AccountInfo) -> Result<u64, ProgramError> {
    let data = account.try_borrow_data()?;
    if data.len() < 72 {
        return Err(ProgramError::Custom(ERR_INVALID_SOL_PRICE));
    }
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

/// SOL/USDC price in floor units — `(usdc_raw × 1e6) / wsol_raw` — from the
/// two pool vault token accounts.
fn read_sol_usdc_price(wsol_vault: &AccountInfo, usdc_vault: &AccountInfo) -> Result<u64, ProgramError> {
    let wsol_raw = token_account_amount(wsol_vault)?;
    let usdc_raw = token_account_amount(usdc_vault)?;
    if wsol_raw == 0 {
        return Err(ProgramError::Custom(ERR_INVALID_SOL_PRICE));
    }
    Ok((usdc_raw as u128 * 1_000_000u128 / wsol_raw as u128) as u64)
}

/// Bounty in lamports for this crank (see the module docs). Both optional
/// vault accounts are pinned to the pool's derived PDAs before pricing.
pub fn bounty_lamports<'a>(
    cfg: &BountyConfig,
    wsol_vault: Option<&AccountInfo<'a>>,
    usdc_vault: Option<&AccountInfo<'a>>,
    now: i64,
) -> Result<u64, ProgramError> {
    if cfg.sol_usdc_pool == Pubkey::default() {
        return Ok(cfg.bounty_amount);
    }
    let wsol_vault = wsol_vault.ok_or(ProgramError::Custom(ERR_INVALID_SOL_PRICE))?;
    let usdc_vault = usdc_vault.ok_or(ProgramError::Custom(ERR_INVALID_SOL_PRICE))?;
    let (expected_wsol, _) = Pubkey::find_program_address(
        &[POOL_VAULT_SEED, cfg.sol_usdc_pool.as_ref(), WSOL_MINT.as_ref()],
        &cfg.cpmm_program,
    );
    let (expected_usdc, _) = Pubkey::find_program_address(
        &[POOL_VAULT_SEED, cfg.sol_usdc_pool.as_ref(), cfg.usdc_mint.as_ref()],
        &cfg.cpmm_program,
    );
    if wsol_vault.key != &expected_wsol || usdc_vault.key != &expected_usdc {
        return Err(ProgramError::Custom(ERR_INVALID_SOL_PRICE));
    }
    let sol_price = read_sol_usdc_price(wsol_vault, usdc_vault)?;
    if sol_price == 0 {
        return Err(ProgramError::Custom(ERR_INVALID_SOL_PRICE));
    }
    let usd_raw = effective_bounty_usd(cfg, year_from_unix(now))?;
    Ok((usd_raw as u128 * 1_000_000u128 / sol_price as u128) as u64)
}

/// Direct lamport transfer from the program-owned bounty PDA to the cranker
/// (the vault is program-owned, so plain lamport arithmetic — no CPI).
pub fn pay_bounty(
    vault: &AccountInfo,
    cranker: &AccountInfo,
    bounty: u64,
) -> Result<(), ProgramError> {
    let mut vault_lamports = vault.try_borrow_mut_lamports()?;
    let mut cranker_lamports = cranker.try_borrow_mut_lamports()?;
    **vault_lamports = vault_lamports
        .checked_sub(bounty)
        .ok_or(ProgramError::Custom(ERR_BOUNTY_EXHAUSTED))?;
    **cranker_lamports = cranker_lamports
        .checked_add(bounty)
        .ok_or(ProgramError::Custom(ERR_MATH_OVERFLOW))?;
    Ok(())
}

/// Rent floor the vault must retain above any payout.
pub fn vault_rent_floor() -> Result<u64, ProgramError> {
    Ok(Rent::get()?.minimum_balance(1))
}
