import { PublicKey } from "@solana/web3.js";
import { getCreatePoolKeys } from "@raydium-io/raydium-sdk-v2";
import type { Cluster } from "./cluster";

// cpmm.ts — shared Raydium CPMM constants + the pool-PDA derivation used by
// sync-buyer and prep. Mirrors buyer/src/config.ts CLUSTERS + buyer/src/pool.ts
// sort order (Raydium sorts the pair token0 < token1 by raw byte order).

export const CPMM_CLUSTERS = {
  devnet: {
    usdcMint: "USDCoctVLVnvTXBEuP9s8hntucdJokbo17RwHuNXemT",
    cpmmProgram: "DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb",
    ammConfigId: "5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy",
  },
  "mainnet-beta": {
    usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    cpmmProgram: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
    ammConfigId: "D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2",
  },
} as const;

export function sortMints(a: PublicKey, b: PublicKey): [PublicKey, PublicKey] {
  return Buffer.compare(Buffer.from(a.toBytes()), Buffer.from(b.toBytes())) <= 0 ? [a, b] : [b, a];
}

/** The pool PDA the buyer watches — derived from the AFHO mint, BEFORE the pool exists. */
export function derivePoolId(mint: PublicKey, cluster: Cluster): PublicKey {
  const c = CPMM_CLUSTERS[cluster] ?? CPMM_CLUSTERS.devnet;
  const [m0, m1] = sortMints(mint, new PublicKey(c.usdcMint));
  return getCreatePoolKeys({
    programId: new PublicKey(c.cpmmProgram),
    configId: new PublicKey(c.ammConfigId),
    mintA: m0,
    mintB: m1,
  }).poolId;
}

/**
 * THE one source of truth for the USDC mint every launch script uses. Derived
 * from the cluster `solana config get` reports (the same flip-everything
 * switch as the rest of the flow); an explicit USDC_MINT env still wins for
 * one-off overrides. This replaces the three per-script mechanisms
 * (hardcoded devnet constant / DEVNET_USDC_MINT env / USDC_MINT env) that
 * drifted apart and already mis-pinned a devnet BountyConfig (4zMMC + GoZmdd).
 */
export function usdcMintFor(cluster: Cluster, envOverride?: string): PublicKey {
  if (envOverride) return new PublicKey(envOverride);
  const c = CPMM_CLUSTERS[cluster] ?? CPMM_CLUSTERS.devnet;
  return new PublicKey(c.usdcMint);
}
