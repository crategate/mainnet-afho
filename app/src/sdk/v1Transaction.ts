import { Connection, type PublicKey, type TransactionInstruction } from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * SIMD-0385 v1 transaction codec + claim-path helpers (client-side only).
 *
 * Zero new dependencies: the v1 wire format is built by hand from the SIMD
 * spec (the 1.x SDK cannot represent v1 — `TransactionVersion` is
 * 'legacy' | 0 there), signed via the connected wallet's byte-signing
 * (`signMessage` — wallets sign arbitrary message bytes, so NO wallet v1
 * support is required), and sent raw.
 *
 * Layout (SIMD-0385):
 *   VersionByte u8 (129)
 *   LegacyHeader: num_required_signatures u8, num_readonly_signed u8,
 *                 num_readonly_unsigned u8
 *   TransactionConfigMask u32 LE
 *   LifetimeSpecifier [u8; 32] (recent blockhash)
 *   NumInstructions u8
 *   NumAddresses u8
 *   Addresses: NumAddresses × [u8; 32] — no duplicates, no lookup tables
 *   ConfigValues: popcount(mask) × 4 bytes, in ascending bit order
 *   InstructionHeaders: NumInstructions × (program_index u8,
 *     num_accounts u8, data_len u16 LE)
 *   InstructionPayloads: per instruction — account indices
 *     (num_accounts bytes) + data (data_len bytes)
 *   Signatures: num_required_signatures × 64 bytes, appended (each signature
 *     covers everything BEFORE this field)
 *
 * Config mask bits (each bit = 4 bytes of ConfigValues):
 *   [0,1] priority fee — total lamports u64 LE (both bits must be set)
 *   [2]   compute-unit-limit u32 LE
 *   [3]   requested loaded accounts data size limit u32 LE
 *   [4]   requested heap size u32 LE (unset = 32 KiB)
 */

export const V1_VERSION_BYTE = 129;
export const V1_CLAIM_CU_LIMIT = 400_000;
// Generous but sane loaded-accounts budget for the claim (two CPMM pools +
// observation accounts + token accounts + staking pool). Bump if the runtime
// returns MaxLoadedAccountsDataSizeExceeded.
export const V1_CLAIM_DATA_SIZE_LIMIT = 65_536;
// Feature flag: v1 SOL claims default ON with automatic fallback to the
// existing v0+ALT path on any v1-specific failure (build / dry-run / wallet
// signMessage missing). `VITE_V1_SOL_CLAIM=false` disables entirely.
export const V1_SOL_CLAIM =
    (import.meta.env?.VITE_V1_SOL_CLAIM ?? 'true') !== 'false';

export interface V1Config {
    /** Total lamports for transaction priority-fee (u64) — bits [0,1]. */
    priorityFeeLamports: number;
    /** Requested compute-unit limit (u32) — bit 2. */
    computeUnitLimit: number;
    /** Requested loaded accounts data size limit (u32) — bit 3. */
    loadedAccountsDataSizeLimit: number;
}

export interface BuildV1Input {
    feePayer: PublicKey;
    recentBlockhash: string;
    instructions: TransactionInstruction[];
    config: V1Config;
}

class Bytes {
    private buf: number[] = [];

    u8(v: number) {
        this.buf.push(v & 0xff);
    }

    u16(v: number) {
        this.buf.push(v & 0xff, (v >>> 8) & 0xff);
    }

    u32(v: number) {
        this.buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    }

    u64(v: number) {
        const lo = v % 2 ** 32;
        const hi = Math.floor(v / 2 ** 32);
        this.u32(lo);
        this.u32(hi);
    }

    bytes(b: Uint8Array) {
        for (const x of b) this.buf.push(x);
    }

    get(): Uint8Array {
        return Uint8Array.from(this.buf);
    }
}

interface AddrInfo {
    key: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
}

/**
 * Serialize the unsigned v1 message (everything before Signatures).
 * Throws on any sanitization violation we can know client-side.
 */
export function buildV1MessageBytes(input: BuildV1Input): Uint8Array {
    const { feePayer, recentBlockhash, instructions, config } = input;

    // ── Dedup addresses, merge flags (signer/writable = OR across uses) ──
    const map = new Map<string, AddrInfo>();
    const put = (key: PublicKey, isSigner: boolean, isWritable: boolean) => {
        const s = key.toBase58();
        const existing = map.get(s);
        if (existing) {
            existing.isSigner ||= isSigner;
            existing.isWritable ||= isWritable;
            return;
        }
        map.set(s, { key, isSigner, isWritable });
    };
    put(feePayer, true, true);
    for (const ix of instructions) {
        put(ix.programId, false, false);
        for (const k of ix.keys) put(k.pubkey, k.isSigner, k.isWritable);
    }

    // ── Order: writable signers (fee payer first), readonly signers,
    //    writable non-signers, readonly non-signers ──
    const all = [...map.values()];
    const writableSigners = all.filter((a) => a.isSigner && a.isWritable);
    writableSigners.sort((a, b) =>
        a.key.equals(feePayer) ? -1 : b.key.equals(feePayer) ? 1 : 0
    );
    const readonlySigners = all.filter((a) => a.isSigner && !a.isWritable);
    const writableUnsigned = all.filter((a) => !a.isSigner && a.isWritable);
    const readonlyUnsigned = all.filter((a) => !a.isSigner && !a.isWritable);
    const ordered = [
        ...writableSigners,
        ...readonlySigners,
        ...writableUnsigned,
        ...readonlyUnsigned,
    ];

    const numRequiredSignatures = writableSigners.length + readonlySigners.length;
    const numReadonlySigned = readonlySigners.length;
    const numReadonlyUnsigned = readonlyUnsigned.length;
    if (numRequiredSignatures === 0) throw new Error('v1: transaction has no signer');
    // SIMD-0385: num_readonly_signed_accounts == num_required_signatures is a
    // sanitization failure (it would make the fee payer readonly).
    if (numReadonlySigned >= numRequiredSignatures) {
        throw new Error('v1: fee payer must be writable (readonly signed accounts >= required)');
    }
    if (ordered.length > 64) throw new Error(`v1: too many addresses (${ordered.length} > 64)`);
    if (instructions.length > 64) throw new Error('v1: too many instructions');

    const indexOf = new Map(ordered.map((a, i) => [a.key.toBase58(), i]));
    const programIndexes = instructions.map((ix) => {
        const idx = indexOf.get(ix.programId.toBase58());
        if (idx === undefined) throw new Error('v1: program id missing from address table');
        return idx;
    });

    // ── Config mask + values (ascending bit order) ──
    const { priorityFeeLamports, computeUnitLimit, loadedAccountsDataSizeLimit } = config;
    const hasFee = priorityFeeLamports > 0;
    let mask = 0;
    if (hasFee) mask |= 0b00011; // bits 0,1 (u64)
    if (computeUnitLimit > 0) mask |= 0b00100; // bit 2
    if (loadedAccountsDataSizeLimit > 0) mask |= 0b01000; // bit 3

    // ── Serialize ──
    const w = new Bytes();
    w.u8(V1_VERSION_BYTE);
    w.u8(numRequiredSignatures);
    w.u8(numReadonlySigned);
    w.u8(numReadonlyUnsigned);
    w.u32(mask);
    const blockhashBytes = bs58.decode(recentBlockhash);
    if (blockhashBytes.length !== 32) throw new Error('v1: bad blockhash length');
    w.bytes(blockhashBytes);
    w.u8(instructions.length);
    w.u8(ordered.length);
    for (const a of ordered) w.bytes(a.key.toBytes());
    if (hasFee) w.u64(priorityFeeLamports);
    if (computeUnitLimit > 0) w.u32(computeUnitLimit);
    if (loadedAccountsDataSizeLimit > 0) w.u32(loadedAccountsDataSizeLimit);
    for (let i = 0; i < instructions.length; i++) {
        const ix = instructions[i];
        if (ix.keys.length > 255) throw new Error('v1: too many accounts per instruction');
        if (ix.data.length > 65_535) throw new Error('v1: instruction data too large');
        w.u8(programIndexes[i]);
        w.u8(ix.keys.length);
        w.u16(ix.data.length);
    }
    for (const ix of instructions) {
        for (const k of ix.keys) {
            const idx = indexOf.get(k.pubkey.toBase58());
            if (idx === undefined) throw new Error('v1: account index missing');
            w.u8(idx);
        }
        w.bytes(ix.data);
    }

    const out = w.get();
    if (out.length + 64 * numRequiredSignatures > 4096) {
        throw new Error(`v1: transaction too large (${out.length + 64 * numRequiredSignatures} > 4096)`);
    }
    return out;
}

/**
 * Sign the message bytes and append the 64-byte signature (Signatures[i]
 * covers everything before the Signatures field — SIMD-0385). `signMessage`
 * is the connected wallet's byte-signing (wallet-adapter signMessage); the
 * wallet never needs v1 awareness.
 */
export async function signV1Message(
    message: Uint8Array,
    signMessage: (m: Uint8Array) => Promise<Uint8Array>,
): Promise<Uint8Array> {
    const sig = await signMessage(message);
    if (sig.length !== 64) throw new Error(`v1: wallet returned a ${sig.length}-byte signature`);
    const out = new Uint8Array(message.length + 64);
    out.set(message, 0);
    out.set(sig, message.length);
    return out;
}

export async function sendV1Transaction(connection: Connection, signed: Uint8Array): Promise<string> {
    return await connection.sendRawTransaction(Buffer.from(signed), {
        skipPreflight: true, // we dry-ran before signing
        preflightCommitment: 'confirmed',
    });
}

/**
 * Dry-run the unsigned v1 message before the wallet prompt. web3.js 1.x has
 * no v1 type for simulateTransaction, so go through the raw RPC channel —
 * same params the rest of the claim flow uses (sigVerify false, fresh
 * blockhash) so real failures (desk closed, stale sheet, floor held, CU)
 * surface before anything is signed.
 */
export async function simulateV1Transaction(
    connection: Connection,
    message: Uint8Array,
): Promise<{ err: unknown; logs: string[] | null } | null> {
    const raw = connection as unknown as {
        _rpcRequest: (method: string, params: unknown[]) => Promise<unknown>;
    };
    try {
        const resp = await raw._rpcRequest('simulateTransaction', [
            bs58.encode(message),
            { sigVerify: false, replaceRecentBlockhash: true },
        ]);
        const value = (resp as { result?: { value?: { err: unknown; logs: string[] | null } } })?.result?.value
            ?? (resp as { value?: { err: unknown; logs: string[] | null } })?.value
            ?? null;
        return value;
    } catch {
        // RPC refused the dry run (rate limit / outage / no v1 support) —
        // callers fall back to the v0+ALT path rather than blocking.
        return null;
    }
}

/**
 * Priority-fee estimation (helius skill: NEVER hardcode fees — estimate from
 * live data). Helius' getPriorityFeeEstimate first (microLamports per CU,
 * 'High'); falls back to the recent-prioritization-fees median on other
 * RPCs; floor 1 microLamport/CU.
 */
export async function estimateMicroLamportsPerCu(
    connection: Connection,
    accountKeys: string[],
): Promise<number> {
    try {
        const raw = connection as unknown as {
            _rpcRequest: (method: string, params: unknown[]) => Promise<unknown>;
        };
        const resp = await raw._rpcRequest('getPriorityFeeEstimate', [
            { accountKeys, options: { priorityLevel: 'High' } },
        ]);
        const est = (resp as { result?: { priorityFeeEstimate?: number } })?.result?.priorityFeeEstimate;
        if (typeof est === 'number' && est > 0) return Math.ceil(est);
    } catch {
        // not a Helius endpoint — fall through
    }
    try {
        const fees = (await connection.getRecentPrioritizationFees())
            .map((f) => f.prioritizationFee)
            .filter((f) => f > 0)
            .slice(-150);
        if (fees.length > 0) {
            fees.sort((a, b) => a - b);
            const med = fees[Math.floor(fees.length / 2)];
            return Math.max(1, Math.ceil(med / 1_000_000));
        }
    } catch {
        // RPC without prioritization fees — floor it
    }
    return 1;
}

/**
 * v1 priority fee is a TOTAL-lamports field (bits [0,1] of the config mask).
 * Charge the same as the ComputeBudget model would: price × requested CU
 * limit, clamped so a hot market can't turn a claim into a surprise SOL burn.
 */
export async function estimateV1PriorityFeeLamports(
    connection: Connection,
    accountKeys: string[],
): Promise<number> {
    const microLamportsPerCu = await estimateMicroLamportsPerCu(connection, accountKeys);
    const total = Math.ceil((microLamportsPerCu * V1_CLAIM_CU_LIMIT) / 1_000_000);
    return Math.min(Math.max(total, 5_000), 20_000_000);
}
