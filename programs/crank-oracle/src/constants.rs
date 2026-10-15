//! Wire-contract constants: program id, PDA seeds, instruction/account
//! discriminators, and the append-only error-code registry.
//!
//! Instruction discriminators are sha256("global:<name>")[..8] (anchor 0.31
//! convention — the TS clients use these raw bytes); account discriminators
//! are sha256("account:<Name>")[..8]. DO NOT reorder or rename without
//! regenerating the IDL.
use solana_program::pubkey::Pubkey;

pub const ID: Pubkey = solana_program::pubkey!("D97EMFzMLrszt5FGz2b1NpQ6SQUuQrWpxthAereV4j82");

pub const SEED_BOUNTY_CONFIG: &[u8] = b"bounty_config";
pub const SEED_BOUNTY_VAULT: &[u8] = b"bounty_vault";
pub const SEED_MARKET_STATUS: &[u8] = b"market_status";
pub const SEED_MARKET_CALENDAR: &[u8] = b"market_calendar";
pub const SEED_HALT_STATE: &[u8] = b"halt_state";
pub const POOL_VAULT_SEED: &[u8] = b"pool_vault";
pub const WSOL_MINT: Pubkey =
    solana_program::pubkey!("So11111111111111111111111111111111111111112");

// ─────────────────────────── discriminators ────────────────────────────────
pub const DISC_INITIALIZE_BOUNTY: [u8; 8] = [0x96, 0x25, 0xf9, 0xf6, 0x55, 0xa4, 0xfd, 0xe5];
pub const DISC_FUND_BOUNTY: [u8; 8] = [0x24, 0x94, 0x8b, 0xef, 0xac, 0x25, 0x3a, 0xff];
pub const DISC_PERMISSIONLESS_CRANK: [u8; 8] = [0xf1, 0x23, 0x44, 0x48, 0x15, 0xaa, 0x59, 0x7f];
pub const DISC_READ_ORACLE_DATA: [u8; 8] = [0x51, 0x67, 0xf2, 0x0c, 0xcc, 0x63, 0x52, 0xea];
pub const DISC_INITIALIZE_STATE: [u8; 8] = [0xbe, 0xab, 0xe0, 0xdb, 0xd9, 0x48, 0xc7, 0xb0];
pub const DISC_SET_AUTHORITY: [u8; 8] = [0x85, 0xfa, 0x25, 0x15, 0x6e, 0xa3, 0x1a, 0x79];
pub const DISC_SET_BOUNTY_AMOUNT: [u8; 8] = [0xa6, 0x12, 0xa9, 0x0c, 0xa6, 0xfa, 0x6f, 0xd7];
pub const DISC_SET_BOUNTY_USD: [u8; 8] = [0x33, 0x3c, 0x12, 0x3c, 0x28, 0xce, 0x61, 0x3f];
// Calendar instructions (2026-09-19, Switchboard migration). Trade hours are
// FIXED at launch — there is NO production setter. The calendar authority
// (Squads multisig) holds the HOLIDAY knob only (`set_holidays`);
// `set_calendar_authority` rotates that multisig.
pub const DISC_INITIALIZE_CALENDAR: [u8; 8] = [0xaf, 0x24, 0xeb, 0xf3, 0xee, 0x61, 0xbb, 0x1c];
pub const DISC_SET_HOLIDAYS: [u8; 8] = [0x1d, 0x0e, 0x7a, 0xc8, 0xf9, 0xe3, 0xe9, 0xa2];
// tz/DST rule — the ONE timezone knob the calendar authority can turn (e.g. a
// permanent US DST policy change). Session times stay fixed.
pub const DISC_SET_TIMEZONE: [u8; 8] = [0x93, 0xfa, 0xbf, 0x8c, 0xad, 0x80, 0x49, 0xd3];
pub const DISC_SET_CALENDAR_AUTHORITY: [u8; 8] = [0xf9, 0xdc, 0x08, 0x31, 0xd6, 0x3a, 0x0d, 0x0b];
// Circuit-breaker venue re-pin — the SAME calendar authority (Squads
// multisig) that holds holidays + tz/DST. A maintenance knob for a
// Raydium/xStocks pool rotation, never a halt override: halt DETECTION stays
// fully automatic (pool mechanics only); the signer can only re-point venues.
pub const DISC_SET_HALT_POOLS: [u8; 8] = [0x5c, 0xda, 0xcb, 0xe4, 0xa6, 0x7c, 0x86, 0x46];
pub const DISC_MARKET_STATUS: [u8; 8] = [0x65, 0x2b, 0x7f, 0xc9, 0x64, 0xdd, 0xd0, 0xbc];
pub const DISC_BOUNTY_CONFIG: [u8; 8] = [0x83, 0xc9, 0x1c, 0x22, 0x46, 0xc6, 0x56, 0xbd];
pub const DISC_MARKET_CALENDAR: [u8; 8] = [0x03, 0x15, 0x85, 0x09, 0x9c, 0x0c, 0x5b, 0x49];
pub const DISC_HALT_STATE: [u8; 8] = [0xae, 0x3f, 0xb2, 0xc4, 0x49, 0x96, 0x2b, 0x40];

// ────────────────────────────── error codes ────────────────────────────────
/// anchor custom errors: 6000 + CrankError enum index. Codes are an
/// append-only wire contract — never renumber. Entries marked "reserved"
/// are unreachable since the Switchboard removal but stay in the registry
/// (and the IDL) so existing TS error maps keep decoding.
#[allow(dead_code)] // reserved wire-contract code
pub const ERR_NO_FEEDS: u32 = 6000;
#[allow(dead_code)] // reserved wire-contract code
pub const ERR_INVALID_FEED_VALUE: u32 = 6001;
pub const ERR_INVALID_MARKET_STATE: u32 = 6002;
pub const ERR_INVALID_AUTHORITY: u32 = 6003;
#[allow(dead_code)] // reserved wire-contract code (reachable only in tests/IDL)
pub const ERR_QUOTE_TOO_STALE: u32 = 6004;
pub const ERR_STALE_QUOTE: u32 = 6005; // crank slot <= last_crank_slot
pub const ERR_BOUNTY_EXHAUSTED: u32 = 6006;
pub const ERR_INVALID_SOL_PRICE: u32 = 6007;
pub const ERR_MATH_OVERFLOW: u32 = 6008;
#[allow(dead_code)] // reserved (was Switchboard queue/feed pinning)
pub const ERR_UNPINNED_ORACLE_CONFIG: u32 = 6009;
#[allow(dead_code)] // reserved
pub const ERR_QUEUE_MISMATCH: u32 = 6010;
#[allow(dead_code)] // reserved
pub const ERR_FEED_NOT_PINNED: u32 = 6011;
pub const ERR_INVALID_CALENDAR_RULE: u32 = 6012;
pub const ERR_CALENDAR_PENDING_EXISTS: u32 = 6013;
pub const ERR_INVALID_CALENDAR_DATA: u32 = 6014;
// Halt layer (appended 2026-09-19; re-sourced to CLMM pools 2026-09-20 —
// same codes, new names; nothing deployed pre-mainnet).
pub const ERR_HALT_POOLS_REQUIRED: u32 = 6015;
pub const ERR_HALT_POOL_LAYOUT: u32 = 6016;
pub const ERR_HALT_POOL_MISMATCH: u32 = 6017;
pub const ERR_HALT_POOL_PRICE: u32 = 6018;
pub const ERR_HALT_POOL_PIN: u32 = 6019; // set_halt_pools pair validation
pub const ERR_HALT_POOL_OWNER: u32 = 6020; // set_halt_pools venue not CLMM-owned

/// Raydium CLMM program — owner of the `PoolState` accounts the halt layer
/// reads (mainnet).
pub const CLMM_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");

/// The two SPYx/USDC Raydium CLMM venues the circuit breaker reads on MAINNET
/// (pool A = the deep venue, also the close-bell reference). These are the
/// DEFAULT pins written at calendar init; the calendar authority (Squads
/// multisig) may re-point them via `set_halt_pools` for a Raydium/xStocks
/// rotation — a maintenance knob, never a halt override.
pub const HALT_POOL_A_MAINNET: Pubkey =
    solana_program::pubkey!("6truu3rZuiB9rKQg4VYC3Dt3QwV7DgwGqXrYUcrvnDDE");
pub const HALT_POOL_B_MAINNET: Pubkey =
    solana_program::pubkey!("4pCZCVEiYyT4efNdXUdL2tJF8VGMgiMXrZWq6FiNXhRw");
