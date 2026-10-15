// ─────────────────────────────────────────────────────────────────────
// clmm.ts — client-side mirror of the on-chain CLMM pool read (halt.rs).
//
// The circuit breaker prices SPY from two pinned Raydium CLMM pools:
// the pool account IS the price source (sqrtPriceX64 moves with every
// trade), so the keeper never pushes anything — it only passes the pool
// accounts to the crank. Layout offsets match the raydium-sdk-v2
// PoolInfoLayout (packed borsh) and are cross-checked by the program's
// own canaries on every read.
// ─────────────────────────────────────────────────────────────────────
import { Connection, PublicKey } from "@solana/web3.js";

export const CLMM_PROGRAM_IDS = [
    new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"), // mainnet
    new PublicKey("devi51mZmdwUJGU9hjN27vEz64Gps7uUefqxg27EAtH"), // devnet (drill)
];
export const CLMM_POOL_SPACE = 1544;
export const OFF_CONFIG = 9;
export const OFF_MINT_A = 73;
export const OFF_MINT_B = 105;
export const OFF_VAULT_A = 137;
export const OFF_VAULT_B = 169;
export const OFF_OBSERVATION = 201;
export const OFF_DECIMALS = 233;
export const OFF_TICK_SPACING = 235;
export const OFF_SQRT_PRICE = 253;

// The verified MAINNET SPYx/USDC venues (dexscreener 2026-09-20: ~$3.0M +
// $538K liquidity). Order: A = the deep pool (also the close-bell reference).
// These match the program's immutable `HALT_POOL_*_MAINNET` constants exactly
// — the breaker has no pin authority, so the crank just passes these.
export const SPYX_MINT = new PublicKey("XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W");
export const MAINNET_HALT_POOLS: [PublicKey, PublicKey] = [
    new PublicKey("6truu3rZuiB9rKQg4VYC3Dt3QwV7DgwGqXrYUcrvnDDE"),
    new PublicKey("4pCZCVEiYyT4efNdXUdL2tJF8VGMgiMXrZWq6FiNXhRw"),
];

/**
 * Cluster-resolved breaker venues, keyed off `solana config get` (the RPC
 * endpoint). MAINNET → the immutable SPYx pair above. DEVNET → null: there is
 * no canonical devnet SPYx, so the halt layer is inactive and the halt drill
 * passes its own ephemeral CLMM pools to the crank instead.
 */
export function haltPoolsForCluster(endpoint: string): { a: PublicKey; b: PublicKey } | null {
    if (endpoint.includes("devnet")) return null;
    return { a: MAINNET_HALT_POOLS[0], b: MAINNET_HALT_POOLS[1] };
}

export interface ClmmPool {
    address: PublicKey;
    programId: PublicKey;
    ammConfigId: PublicKey;
    mintA: PublicKey;
    mintB: PublicKey;
    vaultA: PublicKey;
    vaultB: PublicKey;
    observationId: PublicKey;
    decimalsA: number;
    decimalsB: number;
    tickSpacing: number;
    /** (sqrtPriceX64²) >> 64 — the same raw ratio halt.rs compares. */
    priceRaw: number;
}

export function decodeClmmPool(address: PublicKey, owner: PublicKey, data: Buffer): ClmmPool {
    if (!CLMM_PROGRAM_IDS.some((p) => p.equals(owner))) {
        throw new Error(`${address.toBase58()}: owner ${owner.toBase58()} is not a Raydium CLMM program`);
    }
    if (data.length !== CLMM_POOL_SPACE) {
        throw new Error(`${address.toBase58()}: expected ${CLMM_POOL_SPACE} bytes, got ${data.length}`);
    }
    const sqrt = data.readBigUInt64LE(OFF_SQRT_PRICE) | (data.readBigUInt64LE(OFF_SQRT_PRICE + 8) << 64n);
    if (sqrt === 0n) throw new Error(`${address.toBase58()}: zero sqrtPriceX64`);
    const priceRaw = Number((sqrt * sqrt) >> 64n);
    const pk = (off: number) => new PublicKey(data.subarray(off, off + 32));
    return {
        address,
        programId: owner,
        ammConfigId: pk(OFF_CONFIG),
        mintA: pk(OFF_MINT_A),
        mintB: pk(OFF_MINT_B),
        vaultA: pk(OFF_VAULT_A),
        vaultB: pk(OFF_VAULT_B),
        observationId: pk(OFF_OBSERVATION),
        decimalsA: data[OFF_DECIMALS],
        decimalsB: data[OFF_DECIMALS + 1],
        tickSpacing: data.readUInt16LE(OFF_TICK_SPACING),
        priceRaw,
    };
}

export async function fetchPool(connection: Connection, address: PublicKey): Promise<ClmmPool> {
    const info = await connection.getAccountInfo(address);
    if (!info) throw new Error(`pool ${address.toBase58()} does not exist`);
    return decodeClmmPool(address, info.owner, Buffer.from(info.data));
}

/** True when the bounty config pins a breaker venue pair. */
export function haltPoolsPinned(cfg: any): boolean {
    const a = cfg?.haltPoolA;
    return !!a && !new PublicKey(a).equals(PublicKey.default);
}

/** The pinned venue pair from BountyConfig, or null when the breaker is inert. */
export function haltPoolKeys(cfg: any): { a: PublicKey; b: PublicKey } | null {
    if (!haltPoolsPinned(cfg)) return null;
    return { a: new PublicKey(cfg.haltPoolA), b: new PublicKey(cfg.haltPoolB) };
}

/**
 * Fetch + validate a candidate pool pair the way the program will at crank
 * time: CLMM-owned, right size, equal decimals, identical mint pair across
 * venues. Returns both decoded pools and their divergence in percent.
 */
export async function validatePoolPair(
    connection: Connection,
    a: PublicKey,
    b: PublicKey
): Promise<{ poolA: ClmmPool; poolB: ClmmPool; divergencePct: number }> {
    const [poolA, poolB] = await Promise.all([fetchPool(connection, a), fetchPool(connection, b)]);
    if (poolA.decimalsA !== poolA.decimalsB || poolB.decimalsA !== poolB.decimalsB) {
        throw new Error("halt pools must quote equal-decimal mints (SPYx/USDC is 6/6)");
    }
    if (!poolA.mintA.equals(poolB.mintA) || !poolA.mintB.equals(poolB.mintB)) {
        throw new Error(`mint pair mismatch: pool A ${poolA.mintA.toBase58()}/${poolA.mintB.toBase58()} vs pool B ${poolB.mintA.toBase58()}/${poolB.mintB.toBase58()}`);
    }
    const divergencePct = Math.abs(poolA.priceRaw - poolB.priceRaw) / poolA.priceRaw * 100;
    return { poolA, poolB, divergencePct };
}

// ── raydium-sdk-v2 adapters (drill use) ────────────────────────────────────

/** The SDK's minimal pool shape (SimpleClmmPoolInfo), built from our decode. */
export function simplePoolInfo(p: ClmmPool): any {
    return {
        id: p.address.toBase58(),
        programId: p.programId.toBase58(),
        mintA: { address: p.mintA.toBase58(), programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", decimals: p.decimalsA },
        mintB: { address: p.mintB.toBase58(), programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", decimals: p.decimalsB },
        config: { id: p.ammConfigId.toBase58(), tickSpacing: p.tickSpacing },
    };
}

export function simplePoolKeys(p: ClmmPool): any {
    return { vault: { A: p.vaultA.toBase58(), B: p.vaultB.toBase58() } };
}
