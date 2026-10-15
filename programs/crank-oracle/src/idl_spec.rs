//! Anchor IDL-generation shim — the wire-contract spec. Never deployed: the
//! anchor CLI extracts target/idl/crank_oracle.json from this module under
//! `--features idl-build`; the native modules are the only deployed code.
//! Keep the two in sync — the `idl_discriminators_match` test fails on drift.

use anchor_lang::prelude::*;

declare_id!("D97EMFzMLrszt5FGz2b1NpQ6SQUuQrWpxthAereV4j82");

const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
const POOL_VAULT_SEED: &[u8] = b"pool_vault";

#[error_code]
pub enum CrankError {
    #[msg("Reserved (was: no feeds in the Switchboard quote)")]
    NoFeeds,
    #[msg("Reserved (was: Switchboard feed value decode)")]
    InvalidFeedValue,
    #[msg("Market state must be 0-3 (open/after-hours/closed/halted)")]
    InvalidMarketState,
    #[msg("Wrong authority for this instruction")]
    InvalidAuthority,
    #[msg("Reserved (was: Switchboard quote staleness)")]
    QuoteTooStale,
    #[msg("Crank slot not newer than the last consumed slot")]
    StaleQuote,
    #[msg("Bounty vault is empty")]
    BountyExhausted,
    #[msg("SOL/USDC price could not be read")]
    InvalidSolPrice,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Reserved (was: Switchboard queue/feed pinning)")]
    UnpinnedOracleConfig,
    #[msg("Reserved (was: Switchboard queue pinning)")]
    QueueMismatch,
    #[msg("Reserved (was: Switchboard feed pinning)")]
    FeedNotPinned,
    #[msg("Calendar session rule invalid (state/sort/overlap/bounds)")]
    InvalidCalendarRule,
    #[msg("A pending calendar update of this part already awaits the next bell")]
    CalendarPendingExists,
    #[msg("Calendar data malformed (override dates/kinds, DST window)")]
    InvalidCalendarData,
    #[msg("Both halt pool accounts are required on every open-session crank while pools are pinned")]
    HaltPoolsRequired,
    #[msg("A halt pool account failed validation (owner/size/decimals/mint pair)")]
    HaltPoolLayout,
    #[msg("A halt pool account is not the pool pinned in bounty_config")]
    HaltPoolMismatch,
    #[msg("The halt pool price decoded outside the representable range")]
    InvalidHaltPoolPrice,
    #[msg("Halt pools must be two distinct pool ids, or both zero to disable")]
    InvalidHaltPins,
}

#[program]
pub mod crank_oracle {
    use super::*;

    pub fn initialize_bounty(
        ctx: Context<InitializeBounty>,
        bounty_amount: u64,
        bounty_usd_raw: u64,
        base_year: u16,
        annual_inflation_bps: u16,
        sol_usdc_pool: Pubkey,
        cpmm_program: Pubkey,
        usdc_mint: Pubkey,
    ) -> Result<()> {
        // The deployed native build additionally upgrades legacy (165-/229-
        // byte) configs in place for their recorded authority; this anchor
        // spec describes the fresh-create wire contract for IDL generation.
        ctx.accounts.bounty_config.set_inner(BountyConfig {
            authority: ctx.accounts.payer.key(),
            bounty_amount,
            bounty_usd_raw,
            base_year,
            annual_inflation_bps,
            last_crank_slot: 0,
            sol_usdc_pool,
            cpmm_program,
            usdc_mint,
            bump: ctx.bumps.bounty_config,
            halt_pool_a: Pubkey::default(),
            halt_pool_b: Pubkey::default(),
        });
        Ok(())
    }

    pub fn fund_bounty(ctx: Context<FundBounty>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.payer.key() == ctx.accounts.bounty_config.authority,
            CrankError::InvalidAuthority
        );
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.bounty_vault.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_ctx, amount)?;
        Ok(())
    }

    /// Permissionless transition crank. The expected state is DERIVED from
    /// the `market_calendar` PDA + Clock, with the NYSE Rule 7.12 circuit
    /// breaker overlaid from the two pinned SPYx/USDC Raydium CLMM pools.
    /// Pays the bounty only on a real state transition (first cranker to
    /// land the bell wins).
    pub fn permissionless_crank(ctx: Context<PermissionlessCrank>) -> Result<()> {
        let clock = &ctx.accounts.clock;
        require!(
            clock.slot > ctx.accounts.bounty_config.last_crank_slot,
            CrankError::StaleQuote
        );
        // The deployed native build evaluates the calendar + breaker and
        // computes the exact bell timestamp (src/handlers.rs apply_crank);
        // this spec mirrors the wire contract only.
        let _ = clock;
        Ok(())
    }

    /// No-pay variant (calendar-only; never touches halt state).
    pub fn read_oracle_data(ctx: Context<ReadOracleData>) -> Result<()> {
        require!(
            ctx.accounts.clock.slot > ctx.accounts.bounty_config.last_crank_slot,
            CrankError::StaleQuote
        );
        Ok(())
    }

    pub fn initialize_state(ctx: Context<InitializeState>) -> Result<()> {
        let state = &mut ctx.accounts.market_status;
        state.current_state = 99;
        state.trading_day_index = 0;
        state.last_updated_timestamp = 0;
        Ok(())
    }

    pub fn initialize_calendar(
        ctx: Context<InitializeCalendar>,
        data: CalendarData,
    ) -> Result<()> {
        let mut data = data;
        data.version = 1;
        ctx.accounts.market_calendar.set_inner(MarketCalendar {
            calendar_authority: ctx.accounts.payer.key(),
            active: data,
            has_pending: false,
            pending_schedule: false,
            pending_holidays: false,
            pending: CalendarData::default(),
        });
        msg!("market_calendar initialized (v1)");
        Ok(())
    }

    /// THE TIMEZONE KNOB: ET offset + DST rule only. Session times are
    /// frozen. Queued; activates at the next bell.
    pub fn set_timezone(ctx: Context<SetTimezone>, data: TimezoneSpec) -> Result<()> {
        let cal = &mut ctx.accounts.market_calendar;
        require!(!cal.pending_schedule, CrankError::CalendarPendingExists);
        let mut base = if cal.has_pending { cal.pending } else { cal.active };
        base.utc_offset_winter = data.utc_offset_winter;
        base.dst_delta_sec = data.dst_delta_sec;
        base.dst_start = data.dst_start;
        base.dst_end = data.dst_end;
        base.version = cal.active.version.wrapping_add(1);
        base.updated_at = Clock::get()?.unix_timestamp;
        cal.pending = base;
        cal.has_pending = true;
        cal.pending_schedule = true;
        msg!("calendar v{} queued (timezone) — activates at the next bell", cal.pending.version);
        Ok(())
    }

    /// THE CALENDAR KNOB: holiday closures + half-days — fail-safe-only
    /// data (can close/shorten a session, never open one off-schedule).
    pub fn set_holidays(ctx: Context<SetHolidays>, data: HolidaysSpec) -> Result<()> {
        let cal = &mut ctx.accounts.market_calendar;
        require!(!cal.pending_holidays, CrankError::CalendarPendingExists);
        let mut base = if cal.has_pending { cal.pending } else { cal.active };
        base.overrides = data.overrides;
        base.override_count = data.override_count;
        base.version = cal.active.version.wrapping_add(1);
        base.updated_at = Clock::get()?.unix_timestamp;
        cal.pending = base;
        cal.has_pending = true;
        cal.pending_holidays = true;
        msg!("calendar v{} queued (holidays) — activates at the next bell", cal.pending.version);
        Ok(())
    }

    /// Rotate the calendar authority (the Squads multisig that owns the
    /// tz/DST and holiday knobs). Rotating to
    /// 11111111111111111111111111111111 freezes that mutable data permanently
    /// — see docs/AUTHORITY-PLAYBOOK.md.
    pub fn set_calendar_authority(
        ctx: Context<SetCalendarAuthority>,
        new_authority: Pubkey,
    ) -> Result<()> {
        ctx.accounts.market_calendar.calendar_authority = new_authority;
        msg!("market_calendar authority rotated to: {}", new_authority);
        Ok(())
    }

    /// Re-point the circuit-breaker venues (calendar-authority maintenance
    /// knob; never a halt override).
    pub fn set_halt_pools(ctx: Context<SetHaltPools>, pool_a: Pubkey, pool_b: Pubkey) -> Result<()> {
        ctx.accounts.bounty_config.halt_pool_a = pool_a;
        ctx.accounts.bounty_config.halt_pool_b = pool_b;
        msg!("circuit-breaker venues re-pointed");
        Ok(())
    }

    pub fn set_bounty_amount(ctx: Context<UpdateBounty>, new_amount: u64) -> Result<()> {
        ctx.accounts.bounty_config.bounty_amount = new_amount;
        msg!("Bounty fallback amount set to: {}", new_amount);
        Ok(())
    }

    pub fn set_bounty_usd(ctx: Context<UpdateBounty>, new_usd_raw: u64) -> Result<()> {
        ctx.accounts.bounty_config.bounty_usd_raw = new_usd_raw;
        msg!("USD bounty set to {} usdc raw", new_usd_raw);
        Ok(())
    }

    pub fn set_authority(ctx: Context<UpdateBounty>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.bounty_config.authority = new_authority;
        msg!("Bounty authority rotated to: {}", new_authority);
        Ok(())
    }
}

// ─────────────────────────────── contexts ───────────────────────────────────

#[derive(Accounts)]
pub struct FundBounty<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"bounty_config"], bump = bounty_config.bump)]
    pub bounty_config: Account<'info, BountyConfig>,
    /// CHECK: Lamport holding account for bounty payouts
    #[account(mut, seeds = [b"bounty_vault"], bump)]
    pub bounty_vault: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeBounty<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + 32 + 8 + 8 + 2 + 2 + 8 + 32 + 32 + 32 + 1 + 32 + 32, seeds = [b"bounty_config"], bump)]
    pub bounty_config: Account<'info, BountyConfig>,
    /// CHECK: Lamport holding account for bounty payouts
    #[account(init, payer = payer, space = 1, seeds = [b"bounty_vault"], bump)]
    pub bounty_vault: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PermissionlessCrank<'info> {
    #[account(mut)]
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"bounty_config"], bump = bounty_config.bump)]
    pub bounty_config: Account<'info, BountyConfig>,
    /// CHECK: Lamport holding account for bounty payouts
    #[account(mut, seeds = [b"bounty_vault"], bump)]
    pub bounty_vault: AccountInfo<'info>,
    pub clock: Sysvar<'info, Clock>,
    #[account(mut, seeds = [b"market_status"], bump)]
    pub market_status: Account<'info, MarketStatus>,
    /// The schedule-as-data PDA the state is derived from. MUTABLE: a crank
    /// that observes a bell activates a queued pending calendar in place.
    #[account(mut, seeds = [b"market_calendar"], bump)]
    pub market_calendar: Account<'info, MarketCalendar>,
    /// Circuit-breaker bookkeeping (lazily initialized by the crank).
    #[account(mut, seeds = [b"halt_state"], bump)]
    pub halt_state: Account<'info, HaltState>,
    /// CHECK: Raydium CLMM pool A for the pinned SPYx/USDC pair — verified
    /// against the CLMM program owner, the pinned key, the 1544-byte layout,
    /// and the mint-pair canary inside the handler. Optional (system
    /// program = not provided; both pools or neither).
    pub halt_pool_a: Option<AccountInfo<'info>>,
    /// CHECK: Raydium CLMM pool B. See halt_pool_a.
    pub halt_pool_b: Option<AccountInfo<'info>>,
    /// CHECK: SOL/USDC pool wSOL vault (vault-ratio price read). Optional.
    pub sol_usdc_wsol_vault: Option<AccountInfo<'info>>,
    /// CHECK: SOL/USDC pool USDC vault. See above.
    pub sol_usdc_usdc_vault: Option<AccountInfo<'info>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReadOracleData<'info> {
    pub cranker: Signer<'info>,
    #[account(mut, seeds = [b"bounty_config"], bump = bounty_config.bump)]
    pub bounty_config: Account<'info, BountyConfig>,
    pub clock: Sysvar<'info, Clock>,
    #[account(mut, seeds = [b"market_status"], bump)]
    pub market_status: Account<'info, MarketStatus>,
    /// MUTABLE for the same reason as permissionless_crank: bell-activated
    /// pending swaps write the calendar in place.
    #[account(mut, seeds = [b"market_calendar"], bump)]
    pub market_calendar: Account<'info, MarketCalendar>,
}

#[derive(Accounts)]
pub struct UpdateBounty<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"bounty_config"],
        bump = bounty_config.bump,
        has_one = authority @ CrankError::InvalidAuthority,
    )]
    pub bounty_config: Account<'info, BountyConfig>,
}

#[derive(Accounts)]
pub struct InitializeState<'info> {
    #[account(init, payer = payer, space = 8 + 32, seeds = [b"market_status"], bump)]
    pub market_status: Account<'info, MarketStatus>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeCalendar<'info> {
    #[account(init, payer = payer, space = 8 + 32 + 278 + 1 + 1 + 1 + 278, seeds = [b"market_calendar"], bump)]
    pub market_calendar: Account<'info, MarketCalendar>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetTimezone<'info> {
    pub calendar_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"market_calendar"],
        bump,
        has_one = calendar_authority @ CrankError::InvalidAuthority,
    )]
    pub market_calendar: Account<'info, MarketCalendar>,
}

#[derive(Accounts)]
pub struct SetHolidays<'info> {
    pub calendar_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"market_calendar"],
        bump,
        has_one = calendar_authority @ CrankError::InvalidAuthority,
    )]
    pub market_calendar: Account<'info, MarketCalendar>,
}

#[derive(Accounts)]
pub struct SetCalendarAuthority<'info> {
    pub calendar_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"market_calendar"],
        bump,
        has_one = calendar_authority @ CrankError::InvalidAuthority,
    )]
    pub market_calendar: Account<'info, MarketCalendar>,
}

#[derive(Accounts)]
pub struct SetHaltPools<'info> {
    pub calendar_authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"market_calendar"],
        bump,
        has_one = calendar_authority @ CrankError::InvalidAuthority,
    )]
    pub market_calendar: Account<'info, MarketCalendar>,
    #[account(mut, seeds = [b"bounty_config"], bump = bounty_config.bump)]
    pub bounty_config: Account<'info, BountyConfig>,
    /// CHECK: ownership-validated in the deployed handler — key must match
    /// the pool_a arg and owner must be a Raydium CLMM program (filler when
    /// disabling with the zero-pubkey pair).
    pub pool_a_acc: AccountInfo<'info>,
    /// CHECK: same — pool_b arg / CLMM-owned (filler when disabling).
    pub pool_b_acc: AccountInfo<'info>,
}

// ──────────────────────────── account types ─────────────────────────────────

#[account]
pub struct BountyConfig {
    pub authority: Pubkey,
    /// Fallback lamport payout used when the SOL/USDC pool isn't configured.
    pub bounty_amount: u64,
    /// USD-denominated payout in USDC raw units (6 dp). $0.75 = 750_000.
    pub bounty_usd_raw: u64,
    /// Calendar year the USD bounty is denominated in (inflation baseline).
    pub base_year: u16,
    /// Annual inflation in bps (500 = +5%/yr) applied each year after base_year.
    pub annual_inflation_bps: u16,
    pub last_crank_slot: u64,
    /// Pinned Raydium SOL/USDC CPMM pool + program + USDC mint for the
    /// USD→SOL conversion at payout time.
    pub sol_usdc_pool: Pubkey,
    pub cpmm_program: Pubkey,
    pub usdc_mint: Pubkey,
    pub bump: u8,
    /// Circuit-breaker SPYx/USDC venue pair (defaults to HALT_POOL_*_MAINNET;
    /// re-pointed by the calendar authority via set_halt_pools).
    pub halt_pool_a: Pubkey,
    pub halt_pool_b: Pubkey,
}

#[account]
pub struct MarketStatus {
    pub current_state: u8,
    pub last_updated_timestamp: i64,
    pub trading_day_index: u64,
}

#[account]
pub struct HaltState {
    /// SPYx prior-close price (raw pool ratio from pool A), captured at the
    /// close bell.
    pub ref_price: i64,
    /// Local day of the capture (days since epoch).
    pub ref_day: u32,
    /// Level-1/2 halt overlay expiry (0 = no active overlay).
    pub halt_until: i64,
    /// Local day closed early by a Level-3 breaker (0 = never).
    pub l3_day: u32,
    /// First-sighting timestamp of the pending breach (0 = none armed).
    pub pending_since: i64,
    /// Deepest severity seen since arming (1 = halt, 2 = close-for-day).
    pub pending_level: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Default)]
pub struct CalendarDateRule {
    pub month: u8,
    pub week: u8,
    pub weekday: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Default)]
pub struct SessionRule {
    pub days_mask: u8,
    pub start_min: u16,
    pub end_min: u16,
    pub state: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Default)]
pub struct CalendarOverride {
    pub date: u32,
    pub kind: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub struct CalendarData {
    pub version: u32,
    pub updated_at: i64,
    pub utc_offset_winter: i32,
    pub dst_delta_sec: i32,
    pub dst_start: CalendarDateRule,
    pub dst_end: CalendarDateRule,
    pub half_day_close_min: u16,
    pub rules: [SessionRule; 8],
    pub rule_count: u8,
    pub overrides: [CalendarOverride; 40],
    pub override_count: u8,
}

// Manual Default: [T; 40] is beyond the std derive's array-size limit.
impl Default for CalendarData {
    fn default() -> Self {
        CalendarData {
            version: 0,
            updated_at: 0,
            utc_offset_winter: 0,
            dst_delta_sec: 0,
            dst_start: CalendarDateRule::default(),
            dst_end: CalendarDateRule::default(),
            half_day_close_min: 0,
            rules: [SessionRule::default(); 8],
            rule_count: 0,
            overrides: [CalendarOverride::default(); 40],
            override_count: 0,
        }
    }
}

#[account]
pub struct MarketCalendar {
    /// The Squads multisig that owns the mutable calendar data (tz/DST +
    /// holidays). Session times are frozen and have no setter.
    pub calendar_authority: Pubkey,
    pub active: CalendarData,
    pub has_pending: bool,
    pub pending_schedule: bool,
    pub pending_holidays: bool,
    pub pending: CalendarData,
}

/// The tz/DST instruction arg — 14 bytes on the wire.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub struct TimezoneSpec {
    pub utc_offset_winter: i32,
    pub dst_delta_sec: i32,
    pub dst_start: CalendarDateRule,
    pub dst_end: CalendarDateRule,
}

/// The holidays (overrides) instruction arg — 201 bytes on the wire.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub struct HolidaysSpec {
    pub overrides: [CalendarOverride; 40],
    pub override_count: u8,
}

// ────────────────────────── USD bounty helpers ──────────────────────────────

fn year_from_unix(ts: i64) -> u16 {
    let days = ts.div_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = mp + if mp < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    year as u16
}

fn effective_bounty_usd(cfg: &BountyConfig, year: u16) -> Result<u64> {
    let years = (year as u32).saturating_sub(cfg.base_year as u32);
    let mut usd = cfg.bounty_usd_raw as u128;
    let scale = 10_000u128 + cfg.annual_inflation_bps as u128;
    for _ in 0..years {
        usd = usd.checked_mul(scale).ok_or(CrankError::MathOverflow)? / 10_000;
    }
    Ok(usd as u64)
}

fn read_sol_usdc_price(wsol_vault: &AccountInfo, usdc_vault: &AccountInfo) -> Result<u64> {
    let wsol_raw = token_account_amount(wsol_vault)?;
    let usdc_raw = token_account_amount(usdc_vault)?;
    require!(wsol_raw > 0, CrankError::InvalidSolPrice);
    Ok((usdc_raw as u128 * 1_000_000u128 / wsol_raw as u128) as u64)
}

fn token_account_amount(account: &AccountInfo) -> Result<u64> {
    let data = account.try_borrow_data()?;
    require!(data.len() >= 72, CrankError::InvalidSolPrice);
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

fn bounty_lamports(
    cfg: &BountyConfig,
    wsol_vault: &Option<AccountInfo>,
    usdc_vault: &Option<AccountInfo>,
    now: i64,
) -> Result<u64> {
    if cfg.sol_usdc_pool == Pubkey::default() {
        return Ok(cfg.bounty_amount);
    }
    let wsol_vault = wsol_vault.as_ref().ok_or(CrankError::InvalidSolPrice)?;
    let usdc_vault = usdc_vault.as_ref().ok_or(CrankError::InvalidSolPrice)?;
    let (expected_wsol, _) = Pubkey::find_program_address(
        &[POOL_VAULT_SEED, cfg.sol_usdc_pool.as_ref(), WSOL_MINT.as_ref()],
        &cfg.cpmm_program,
    );
    let (expected_usdc, _) = Pubkey::find_program_address(
        &[POOL_VAULT_SEED, cfg.sol_usdc_pool.as_ref(), cfg.usdc_mint.as_ref()],
        &cfg.cpmm_program,
    );
    require!(
        wsol_vault.key() == expected_wsol && usdc_vault.key() == expected_usdc,
        CrankError::InvalidSolPrice
    );
    let sol_price = read_sol_usdc_price(wsol_vault, usdc_vault)?;
    require!(sol_price > 0, CrankError::InvalidSolPrice);
    let usd_raw = effective_bounty_usd(cfg, year_from_unix(now))?;
    Ok((usd_raw as u128 * 1_000_000u128 / sol_price as u128) as u64)
}

fn pay_bounty(vault: &AccountInfo, cranker: &AccountInfo, bounty: u64) -> Result<()> {
    let mut vault_lamports = vault.try_borrow_mut_lamports()?;
    let mut cranker_lamports = cranker.try_borrow_mut_lamports()?;
    **vault_lamports = vault_lamports
        .checked_sub(bounty)
        .ok_or(CrankError::BountyExhausted)?;
    **cranker_lamports = cranker_lamports
        .checked_add(bounty)
        .ok_or(CrankError::MathOverflow)?;
    Ok(())
}
