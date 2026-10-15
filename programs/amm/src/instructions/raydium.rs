//! Raw Raydium CPMM integration — the modern CPMM CPI crate pins an
//! incompatible anchor-lang, so `swap_base_input` is built by hand and
//! invoked with `invoke_signed`.
//!
//! Reference: https://github.com/raydium-io/raydium-cpi (`programs/cpmm-cpi`)
//!   mainnet CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
//!   devnet  DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};

/// Pool authority / vault / LP-mint authority PDA seed.
pub const AUTH_SEED: &[u8] = b"vault_and_lp_mint_auth_seed";
pub const POOL_VAULT_SEED: &[u8] = b"pool_vault";
pub const POOL_LP_MINT_SEED: &[u8] = b"pool_lp_mint";
pub const OBSERVATION_SEED: &[u8] = b"observation";

/// 8-byte anchor discriminator = sha256("global:swap_base_input")[..8].
pub const SWAP_BASE_INPUT_DISCRIMINATOR: [u8; 8] =
    [0x8f, 0xbe, 0x5a, 0xda, 0xc4, 0x1e, 0x33, 0xde];

pub const OBSERVATION_NUM: usize = 100;
/// Q32.32 scale used by the cumulative price accumulators.
pub const Q32: u128 = 1 << 32;

// ────────────────────────────── PDA derivation ──────────────────────────────

/// `["pool_vault", pool_state, mint]`.
pub fn pool_vault_pda(program: &Pubkey, pool_state: Pubkey, mint: Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[POOL_VAULT_SEED, pool_state.as_ref(), mint.as_ref()], program)
}

/// `["observation", pool_state]`.
pub fn observation_pda(program: &Pubkey, pool_state: Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[OBSERVATION_SEED, pool_state.as_ref()], program)
}

/// `["vault_and_lp_mint_auth_seed"]`.
pub fn pool_authority_pda(program: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[AUTH_SEED], program)
}

// ────────────────────────────── state layouts ───────────────────────────────

/// One element of the CPMM oracle ring. `#[repr(C, packed)]`, no anchor
/// discriminator (zero-copy account).
#[repr(C, packed)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
pub struct Observation {
    pub block_timestamp: u64,
    /// cumulative `token_1 per token_0` price, Q32.32 (×2^32), time-integrated.
    pub cumulative_token_0_price_x32: u128,
    /// cumulative `token_0 per token_1` price, Q32.32 (×2^32), time-integrated.
    pub cumulative_token_1_price_x32: u128,
}

/// The on-chain oracle account (`["observation", pool_state]`), an anchor
/// `#[account(zero_copy)]` account. On-chain layout (verified against devnet):
///   discriminator: [u8;8] (= sha256("account:ObservationState")[..8]),
///   initialized: u8, observation_index: u16, pool_id: [u8;32],
///   observations: [Observation; 100], padding: [u64; 4].
/// The 8-byte discriminator IS present in the raw account data, unlike the
/// struct's own fields.
pub const OBSERVATION_STATE_DISCRIMINATOR_LEN: usize = 8;
pub const OBSERVATION_STATE_HEADER_LEN: usize = 8 + 1 + 2 + 32;

// ────────────────────────────── swap CPI ────────────────────────────────────

/// Build the raw `swap_base_input` instruction. The caller must assemble the
/// matching `&[AccountInfo]` (same order as the accounts below) and call
/// `invoke_signed` with the AMM PDA's seeds, because `payer` signs the swap.
#[allow(clippy::too_many_arguments)]
pub fn cpmm_swap_base_input_ix(
    program: Pubkey,
    // payer is the authority of the input/output token accounts (our PDA signs)
    payer: Pubkey,
    authority: Pubkey,
    amm_config: Pubkey,
    pool_state: Pubkey,
    input_token_account: Pubkey,
    output_token_account: Pubkey,
    input_vault: Pubkey,
    output_vault: Pubkey,
    input_token_program: Pubkey,
    output_token_program: Pubkey,
    input_token_mint: Pubkey,
    output_token_mint: Pubkey,
    observation_state: Pubkey,
    amount_in: u64,
    minimum_amount_out: u64,
) -> Instruction {
    let mut data = Vec::with_capacity(8 + 8 + 8);
    data.extend_from_slice(&SWAP_BASE_INPUT_DISCRIMINATOR);
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&minimum_amount_out.to_le_bytes());

    Instruction {
        program_id: program,
        accounts: vec![
            // payer — signer, read-only
            AccountMeta::new_readonly(payer, true),
            // authority (pool vault/LP-mint authority PDA) — read-only
            AccountMeta::new_readonly(authority, false),
            // amm_config — read-only
            AccountMeta::new_readonly(amm_config, false),
            // pool_state — writable
            AccountMeta::new(pool_state, false),
            // input_token_account — writable
            AccountMeta::new(input_token_account, false),
            // output_token_account — writable
            AccountMeta::new(output_token_account, false),
            // input_vault — writable
            AccountMeta::new(input_vault, false),
            // output_vault — writable
            AccountMeta::new(output_vault, false),
            // input_token_program — read-only
            AccountMeta::new_readonly(input_token_program, false),
            // output_token_program — read-only
            AccountMeta::new_readonly(output_token_program, false),
            // input_token_mint — read-only
            AccountMeta::new_readonly(input_token_mint, false),
            // output_token_mint — read-only
            AccountMeta::new_readonly(output_token_mint, false),
            // observation_state — writable
            AccountMeta::new(observation_state, false),
        ],
        data,
    }
}

/// The account-metas order the CPI expects (exposed so callers can build the
/// matching `&[AccountInfo]` without re-deriving the ordering).
pub const SWAP_ACCOUNT_KEYS: usize = 13;

// ────────────────────────────── oracle (TWAP) ───────────────────────────────

/// Time-weighted sample of `token_0` denominated in `token_1` over the last
/// `window_seconds`. Returns the accumulated (delta_cumulative_price_x32, dt)
/// pair WITHOUT dividing — callers convert straight to floor units from the
/// accumulated form so tiny per-second ratios (a sub-penny token against USDC
/// can have a Q32 TWAP of ~10, where one integer ulp is ~7% of the price)
/// don't lose precision to integer truncation.
///
/// Returns `None` when the oracle isn't initialized or there aren't two
/// observations spanning the window. `cumulative_token_0_price_x32` accrues
/// "token_1 per token_0", so the sample is the price a unit of token_0 fetches
/// in token_1 (for an AFHO/USDC pool with AFHO as token_0, USDC per AFHO).
pub fn read_twap_sample(
    observation_data: &[u8],
    now: u64,
    window_seconds: u64,
) -> Option<(u128, u64)> {
    const HEADER: usize = OBSERVATION_STATE_HEADER_LEN;
    const DISC: usize = OBSERVATION_STATE_DISCRIMINATOR_LEN;
    if observation_data.len() < HEADER + OBSERVATION_NUM * size_of_observation() {
        return None;
    }
    if observation_data[DISC] == 0 {
        return None; // oracle not initialized
    }
    let observation_index =
        u16::from_le_bytes(observation_data[DISC + 1..DISC + 3].try_into().ok()?) as usize;
    let obs = &observation_data[HEADER..HEADER + OBSERVATION_NUM * size_of_observation()];

    let read = |idx: usize| -> Observation {
        let s = (idx % OBSERVATION_NUM) * size_of_observation();
        *bytemuck::from_bytes::<Observation>(&obs[s..s + size_of_observation()])
    };

    let latest = read(observation_index);
    if latest.block_timestamp == 0 {
        return None;
    }
    // Walk backwards to the newest observation at or before (now - window).
    let mut oldest: Option<Observation> = None;
    for step in 0..OBSERVATION_NUM {
        let idx = (observation_index + OBSERVATION_NUM - step) % OBSERVATION_NUM;
        let o = read(idx);
        if o.block_timestamp == 0 {
            break;
        }
        oldest = Some(o);
        if o.block_timestamp <= now.saturating_sub(window_seconds)
            || o.block_timestamp <= latest.block_timestamp.saturating_sub(window_seconds)
        {
            break;
        }
    }
    let oldest = oldest?;
    let dt = latest.block_timestamp.saturating_sub(oldest.block_timestamp);
    if dt == 0 {
        return None;
    }
    // The ring must be dense enough to actually span the requested window — a
    // sparse ring (a long gap between trades) would otherwise return a stale
    // TWAP over a much longer interval than the caller asked for.
    if dt > window_seconds.saturating_mul(2) {
        return None;
    }
    let dcum = latest
        .cumulative_token_0_price_x32
        .saturating_sub(oldest.cumulative_token_0_price_x32);
    Some((dcum, dt))
}

/// Verify a full pinned SOL/USDC CPMM account set (wSOL in, USDC out). No-op
/// when the pool isn't pinned.
#[allow(clippy::too_many_arguments)]
pub fn pinned_sol_usdc_accounts_valid(
    cpmm_program: Pubkey,
    pool_state: Pubkey,
    amm_config: Pubkey,
    wrapped_sol_mint: Pubkey,
    usdc_mint: Pubkey,
    acct_pool_state: &AccountInfo,
    acct_amm_config: &AccountInfo,
    acct_wrapped_sol_vault: &AccountInfo,
    acct_usdc_vault: &AccountInfo,
    acct_observation: &AccountInfo,
    acct_authority: &AccountInfo,
) -> bool {
    let (obs, _) = observation_pda(&cpmm_program, pool_state);
    let (wsol_vault, _) = pool_vault_pda(&cpmm_program, pool_state, wrapped_sol_mint);
    let (usdc_vault, _) = pool_vault_pda(&cpmm_program, pool_state, usdc_mint);
    let (authority, _) = pool_authority_pda(&cpmm_program);
    let ok = acct_pool_state.key() == pool_state
        && acct_amm_config.key() == amm_config
        && acct_wrapped_sol_vault.key() == wsol_vault
        && acct_usdc_vault.key() == usdc_vault
        && acct_observation.key() == obs
        && acct_authority.key() == authority;
    if !ok {
        msg!(
            "SOL/USDC CPMM account pin mismatch: pool {} amm_config {} wsol_vault {} usdc_vault {} observation {} authority {}",
            acct_pool_state.key(),
            acct_amm_config.key(),
            acct_wrapped_sol_vault.key(),
            acct_usdc_vault.key(),
            acct_observation.key(),
            acct_authority.key(),
        );
    }
    ok
}

const fn size_of_observation() -> usize {
    std::mem::size_of::<Observation>()
}

// ────────────────────────────── floor-units pricing ─────────────────────────

/// TWAP lookback window. Long enough to be manipulation-resistant, short
/// enough that a freshly-created protocol pool arms quickly once the keeper's
/// swap slices begin writing observations.
pub const TWAP_WINDOW_SECONDS: u64 = 600;

/// Maximum age of the LATEST observation for the TWAP to be considered fresh.
/// Set to one window (600s): if the pool hasn't traded in the last 10 minutes
/// the TWAP is treated as stale and we use the instantaneous vault ratio
/// instead (which is always current, not stale).
pub const TWAP_MAX_AGE_SECONDS: u64 = 600;

/// Conversion factor from a Q32.32 raw-ratio TWAP to floor units. The TWAP
/// accrues the RAW token_1-per-token_0 ratio × 2^32; floor units = USDC price
/// per whole token × 1e9, and every protocol pool pairs a 6-dp quote (USDC)
/// with a 9-dp base (AFHO or wSOL), so floor = raw_ratio × 1e12. This must
/// move together with the ×1e12 numerators in the vault-ratio fallback, the
/// claim cost divisor, and the min-out/exec-price math.
pub const FLOOR_UNITS_PER_Q32: u128 = 1_000_000_000_000;

/// Latest observation timestamp (the ring's `observation_index` points at the
/// most recently written entry).
pub fn observation_latest_timestamp(observation_data: &[u8]) -> Option<u64> {
    const DISC: usize = OBSERVATION_STATE_DISCRIMINATOR_LEN;
    const HEADER: usize = OBSERVATION_STATE_HEADER_LEN;
    if observation_data.len() < HEADER + size_of_observation() {
        return None;
    }
    if observation_data[DISC] == 0 {
        return None;
    }
    let index = u16::from_le_bytes(observation_data[DISC + 1..DISC + 3].try_into().ok()?) as usize;
    let s = HEADER + (index % OBSERVATION_NUM) * size_of_observation();
    Some(u64::from_le_bytes(observation_data[s..s + 8].try_into().ok()?))
}

/// Token-account `amount` field (u64 LE at offset 64), identical for classic
/// SPL and Token-2022.
pub fn token_account_amount(account: &AccountInfo) -> Option<u64> {
    let data = account.try_borrow_data().ok()?;
    Some(u64::from_le_bytes(data.get(64..72)?.try_into().ok()?))
}

/// Constant-product preview of a Raydium CPMM `swap_base_input`: the output
/// the pool will actually produce for `amount_in` against reserves
/// (r_in, r_out), before the pool's ~0.25% input-leg trade fee, discounted
/// by `slippage_bps` of residual tolerance.
///
/// A flat `amount_in × spot × (1 − tol)` floor ignores the trade's own price
/// impact (`amount_in / (r_in + amount_in)`), so any input larger than the
/// tolerance fails the CPI on a thin pool — the pool's real output is always
/// below spot×input for a non-dust trade.
pub fn cpmm_swap_min_out(r_in: u64, r_out: u64, amount_in: u64, slippage_bps: u64) -> Option<u64> {
    if r_in == 0 || r_out == 0 || amount_in == 0 {
        return None;
    }
    let expected_out = (amount_in as u128)
        .checked_mul(r_out as u128)?
        .checked_div((r_in as u128).checked_add(amount_in as u128)?)?;
    let min_out = expected_out
        .checked_mul(10_000u128)?
        .checked_div(10_000u128.checked_add(slippage_bps as u128)?)?;
    u64::try_from(min_out).ok().filter(|m| *m > 0)
}

/// `cpmm_swap_min_out` against the pool's two vault accounts: pass the swap's
/// INPUT vault first, OUTPUT vault second (caller's swap orientation, not
/// mint order). Returns `None` when either vault is unreadable or empty so
/// callers can fall back to their flat floor-price min-out.
pub fn cpmm_swap_min_out_from_vaults(
    input_vault: &AccountInfo,
    output_vault: &AccountInfo,
    amount_in: u64,
    slippage_bps: u64,
) -> Option<u64> {
    let r_in = token_account_amount(input_vault)?;
    let r_out = token_account_amount(output_vault)?;
    cpmm_swap_min_out(r_in, r_out, amount_in, slippage_bps)
}

/// Constant-product solve: the gross `swap_base_input` input (including the
/// pool's `fee_bps` input-leg trade fee) needed for the pool to net at least
/// `min_out` against reserves (r_in, r_out). Ceil-rounded so the pool's own
/// integer math still reaches the target. Returns `None` when `min_out` is 0
/// or `min_out >= r_out` — no input can net more than the pool's entire
/// output side holds.
///
/// Inverse of the pool math behind `cpmm_swap_min_out`:
///   out = r_out × net/(r_in + net) ≥ min_out, net = in × (10000 − fee_bps)/10000
///   ⇒ net_req = ceil(min_out × r_in/(r_out − min_out)), in = ceil(net_req × 10000/(10000 − fee_bps))
pub fn cpmm_swap_input_for_out(r_in: u64, r_out: u64, min_out: u64, fee_bps: u64) -> Option<u64> {
    if r_in == 0 || r_out == 0 || min_out == 0 || min_out >= r_out || fee_bps >= 10_000 {
        return None;
    }
    let (r_in, r_out, min_out) = (r_in as u128, r_out as u128, min_out as u128);
    let num = min_out.checked_mul(r_in)?;
    let den = r_out.checked_sub(min_out)?; // > 0 by the guard above
    let net_req = (num.checked_add(den)?.checked_sub(1)?) / den; // ceil(num/den)
    let gross = net_req
        .checked_mul(10_000u128)?
        .checked_div(10_000u128.checked_sub(fee_bps as u128)?)?;
    u64::try_from(gross).ok()
}

#[cfg(test)]
mod cpmm_min_out_tests {
    use super::*;

    #[test]
    fn min_out_reproduces_observed_0x1775_fill() {
        // Devnet SOL/USDC pool at the time of the failure: ~1.1 wSOL vs
        // ~158 USDC reserves. A 0.0675-SOL claim input (~9.696 USDC cost at
        // sol_price 144.01) actually produced 9,138,841 raw USDC out, while
        // the old flat floor (cost × 0.98 = 9,502,080) failed the CPI.
        let min = cpmm_swap_min_out(1_100_000_000, 158_000_000, 67_503_000, 500).unwrap();
        // expected out ≈ 9.136e6, min = expected × 10000/10500 ≈ 8.701e6.
        assert!((8_690_000..=8_710_000).contains(&min));
        // The old spot-priced floor is strictly above what the pool pays out:
        assert!(9_502_080u64 > 9_136_000);
        assert!(min < 9_502_080);
    }

    #[test]
    fn min_out_needs_liquidity_on_both_sides() {
        assert!(cpmm_swap_min_out(0, 158_000_000, 67_503_000, 500).is_none());
        assert!(cpmm_swap_min_out(1_100_000_000, 0, 67_503_000, 500).is_none());
        assert!(cpmm_swap_min_out(1_100_000_000, 158_000_000, 0, 500).is_none());
    }

    #[test]
    fn min_out_converges_to_spot_for_dust() {
        // Dust input: no impact, so min = fair × 10000/10500 exactly.
        let (r_in, r_out, amount) = (1_100_000_000u64, 158_000_000u64, 1_000u64);
        let min = cpmm_swap_min_out(r_in, r_out, amount, 500).unwrap() as u128;
        let fair = amount as u128 * r_out as u128 / r_in as u128;
        assert!(min <= fair);
        assert!(min >= fair * 9_500 / 10_000);
    }

    #[test]
    fn input_for_out_nets_target_after_fee() {
        // Solve, then replay the pool's integer math (fee floor, output
        // floor): the net must reach the target.
        let (r_in, r_out, target) = (1_100_000_000u64, 158_000_000u64, 9_696_000u64);
        let input = cpmm_swap_input_for_out(r_in, r_out, target, 25).unwrap() as u128;
        let net = input - input * 25 / 10_000;
        let out = (r_out as u128) * net / ((r_in as u128) + net);
        assert!(out >= target as u128);
        // Targets the pool can never serve fail cleanly.
        assert!(cpmm_swap_input_for_out(r_in, r_out, r_out, 25).is_none());
        assert!(cpmm_swap_input_for_out(r_in, r_out, r_out + 1, 25).is_none());
        assert!(cpmm_swap_input_for_out(r_in, 0, 1, 25).is_none());
        assert!(cpmm_swap_input_for_out(0, r_out, 1, 25).is_none());
        assert!(cpmm_swap_input_for_out(r_in, r_out, 0, 25).is_none());
    }

    #[test]
    fn input_for_out_dust_is_spot_plus_fee() {
        // Dust: input ≈ target × r_in/r_out × (1 + fee) + rounding.
        let (r_in, r_out, target) = (1_100_000_000u64, 158_000_000u64, 1_000u64);
        let input = cpmm_swap_input_for_out(r_in, r_out, target, 25).unwrap() as u128;
        let fair = target as u128 * r_in as u128 / r_out as u128;
        assert!(input > fair);
        assert!(input <= fair * 10_050 / 10_000 + 2);
    }
}

/// CPMM pool-state mints: token_0 at offset 168, token_1 at offset 200
/// (after the 8-byte discriminator + config_id/pool_creator/vaults/lp_mint).
pub fn pool_state_mints(pool_state: &AccountInfo) -> Option<(Pubkey, Pubkey)> {
    let data = pool_state.try_borrow_data().ok()?;
    let token_0 = Pubkey::try_from(data.get(168..200)?).ok()?;
    let token_1 = Pubkey::try_from(data.get(200..232)?).ok()?;
    Some((token_0, token_1))
}

/// Convert a TWAP sample (delta cumulative Q32 price, dt seconds) to floor
/// units for the requested base/quote pair, doing the ×FLOOR_UNITS_PER_Q32
/// scaling BEFORE the /dt and /Q32 divisions so tiny ratios keep full
/// precision (a sub-penny base token can have a Q32 TWAP of ~10, where one
/// integer ulp is ~7% of the price). Handles the pool listing the pair in
/// either order. Floor units = price per whole token × 1e9 (nano-USD); with
/// the protocol's 6-dp quote / 9-dp base pairs, floor = raw_ratio × 1e12.
fn q32_to_floor(
    dcum: u128,
    dt: u64,
    token_0: Pubkey,
    token_1: Pubkey,
    base: Pubkey,
    quote: Pubkey,
) -> Option<u64> {
    let floor = if token_0 == base && token_1 == quote {
        // Direct: twap = dcum/dt is quote_raw/base_raw × Q32.
        dcum.checked_mul(FLOOR_UNITS_PER_Q32)?
            .checked_div(dt as u128)?
            .checked_div(Q32)?
    } else if token_0 == quote && token_1 == base {
        // Inverted: 1/twap = dt/dcum × Q32.
        if dcum == 0 {
            return None;
        }
        (dt as u128)
            .checked_mul(Q32)?
            .checked_mul(FLOOR_UNITS_PER_Q32)?
            .checked_div(dcum)?
    } else {
        return None; // pool does not contain this pair
    };
    u64::try_from(floor).ok()
}

/// Floor-units price of `base_mint` quoted in `quote_mint` from a pinned CPMM
/// pool. Primary: observation-ring TWAP over `TWAP_WINDOW_SECONDS`. Fallback:
/// the pool's instantaneous constant-product ratio (quote_vault.amount /
/// base_vault.amount) — used while the ring is still warming up.
/// Returns `None` when the pool is unreadable or the pair doesn't match.
pub fn read_cpmm_price_floor(
    pool_state: &AccountInfo,
    observation: &AccountInfo,
    base_vault: &AccountInfo,
    quote_vault: &AccountInfo,
    base_mint: &Pubkey,
    quote_mint: &Pubkey,
    now: u64,
) -> Option<u64> {
    let (token_0, token_1) = pool_state_mints(pool_state)?;
    if let Ok(obs) = observation.try_borrow_data() {
        // Only trust the TWAP when the latest observation is fresh — a stale
        // ring can encode a long-gone price (e.g. a pool that was repriced
        // after a quiet period).
        if let Some(latest_ts) = observation_latest_timestamp(&obs) {
            let fresh = now.saturating_sub(latest_ts) <= TWAP_MAX_AGE_SECONDS;
            if fresh {
                if let Some((dcum, dt)) = read_twap_sample(&obs, now, TWAP_WINDOW_SECONDS) {
                    if let Some(floor) = q32_to_floor(dcum, dt, token_0, token_1, *base_mint, *quote_mint) {
                        if floor > 0 {
                            return Some(floor);
                        }
                    }
                }
            }
        }
    }
    // Instant spot fallback from the pool's two token vaults.
    let base_raw = token_account_amount(base_vault)?;
    let quote_raw = token_account_amount(quote_vault)?;
    if base_raw == 0 {
        return None;
    }
    u64::try_from(quote_raw as u128 * 1_000_000_000_000u128 / base_raw as u128).ok()
}

/// Unified price reader for the whole AMM: the pinned CPMM pool's TWAP,
/// with the pool's own instantaneous vault-ratio as the in-pool fallback.
/// Returns `None` when no price is available — callers fail closed on it.
/// The legacy raw-u64 mock oracle is gone: an unpinned pool is a hard error
/// at the instruction level, never a stub price.
#[allow(clippy::too_many_arguments)]
pub fn read_price(
    pool_state: &AccountInfo,
    observation: &AccountInfo,
    base_vault: &AccountInfo,
    quote_vault: &AccountInfo,
    base_mint: &Pubkey,
    quote_mint: &Pubkey,
    now: u64,
) -> Option<u64> {
    read_cpmm_price_floor(
        pool_state,
        observation,
        base_vault,
        quote_vault,
        base_mint,
        quote_mint,
        now,
    )
}

/// Verify a full pinned-CPMM account set against the addresses derived from
/// `amm_state` (H1 re-pin: a compromised keeper can't redirect the pricing
/// reads or the swap in/out vaults). The pool is REQUIRED to be pinned —
/// callers check `cpmm_pool_state != default` before calling. Returns false
/// with a `msg!` on any mismatch.
#[allow(clippy::too_many_arguments)]
pub fn pinned_pool_accounts_valid(
    cpmm_program: Pubkey,
    pool_state: Pubkey,
    amm_config: Pubkey,
    afho_mint: Pubkey,
    usdc_mint: Pubkey,
    acct_pool_state: &AccountInfo,
    acct_amm_config: &AccountInfo,
    acct_afho_vault: &AccountInfo,
    acct_usdc_vault: &AccountInfo,
    acct_observation: &AccountInfo,
    acct_authority: &AccountInfo,
) -> bool {
    let (obs, _) = observation_pda(&cpmm_program, pool_state);
    let (afho_vault, _) = pool_vault_pda(&cpmm_program, pool_state, afho_mint);
    let (usdc_vault, _) = pool_vault_pda(&cpmm_program, pool_state, usdc_mint);
    let (authority, _) = pool_authority_pda(&cpmm_program);
    let ok = acct_pool_state.key() == pool_state
        && acct_amm_config.key() == amm_config
        && acct_afho_vault.key() == afho_vault
        && acct_usdc_vault.key() == usdc_vault
        && acct_observation.key() == obs
        && acct_authority.key() == authority;
    if !ok {
        msg!(
            "CPMM account pin mismatch: pool {} amm_config {} afho_vault {} usdc_vault {} observation {} authority {}",
            acct_pool_state.key(),
            acct_amm_config.key(),
            acct_afho_vault.key(),
            acct_usdc_vault.key(),
            acct_observation.key(),
            acct_authority.key(),
        );
    }
    ok
}

#[cfg(test)]
mod tests {
    use super::*;

    // 6/9-dec pair shaped like the live devnet pool: 250M AFHO (9 dp) against
    // 625 USDC (6 dp) → price 2.5e-6 USDC/AFHO → floor 2500.
    const AFHO_RAW: u128 = 250_000_000_000_000_000;
    const USDC_RAW: u128 = 625_000_000;
    const DT: u64 = 600;
    const AFHO: Pubkey = Pubkey::new_from_array([1u8; 32]);
    const USDC: Pubkey = Pubkey::new_from_array([2u8; 32]);

    #[test]
    fn q32_floor_direct_orientation() {
        // token_0 = AFHO (base), token_1 = USDC (quote): dcum accumulates
        // USDC_raw/AFHO_raw × Q32 × dt.
        let dcum = USDC_RAW.checked_mul(Q32).unwrap().checked_mul(DT as u128).unwrap() / AFHO_RAW;
        let floor = q32_to_floor(dcum, DT, AFHO, USDC, AFHO, USDC).unwrap();
        // Ideal 2500; scaling before the divisions keeps truncation <0.05%.
        assert!(floor > 0);
        assert!(floor.abs_diff(2500) <= 2, "floor {floor} too far from 2500");
    }

    #[test]
    fn q32_floor_inverted_orientation() {
        // Live pool's actual mint order: token_0 = USDC (quote), token_1 = AFHO
        // (base). The reader must invert the TWAP; the floor must still be the
        // USDC-per-AFHO price (~2500), not Q32/raw_ratio-scaled garbage.
        let dcum = AFHO_RAW.checked_mul(Q32).unwrap().checked_mul(DT as u128).unwrap() / USDC_RAW;
        let floor = q32_to_floor(dcum, DT, USDC, AFHO, AFHO, USDC).unwrap();
        assert!(floor > 0);
        assert!(floor.abs_diff(2500) <= 2, "floor {floor} too far from 2500");
        // Sanity: the old path (1e9 scale on a pre-divided twap) produced 2 —
        // under the band the min-out math then fails the swap as ExceededSlippage.
        assert!(floor > 100);
    }

    #[test]
    fn q32_floor_rejects_foreign_pair() {
        assert!(q32_to_floor(1_000u128, DT, AFHO, USDC, AFHO, AFHO).is_none());
        assert!(q32_to_floor(1_000u128, DT, AFHO, USDC, USDC, USDC).is_none());
    }

    #[test]
    fn q32_floor_inverted_zero_cumulative() {
        assert!(q32_to_floor(0u128, DT, USDC, AFHO, AFHO, USDC).is_none());
    }
}
