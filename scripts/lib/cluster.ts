import { execFileSync } from "child_process";

// cluster.ts — the single source of truth for "which network am I on".
//
// `solana config get` already knows the RPC URL and the payer keypair, so
// every launch/keeper script reads it instead of duplicating a
// CLUSTER / RPC_URL pair in multiple places. Everything here falls
// back gracefully when the Solana CLI is missing.

export type Cluster = "devnet" | "mainnet-beta";

export interface SolanaConfig {
    /** devnet or mainnet-beta, derived from the RPC URL host. */
    cluster: Cluster;
    /** https RPC URL (trailing slash trimmed). */
    rpcUrl: string;
    /** wss URL derived from the RPC URL. */
    wsUrl: string;
    /** ~-expanded absolute path of the CLI payer keypair ("" if unset). */
    keypairPath: string;
}

function expandHome(p: string): string {
    const home = process.env.HOME ?? ".";
    if (p === "~") return home;
    if (p.startsWith("~/")) return home + p.slice(1);
    return p;
}

/** Read and normalize `solana config get`. */
export function resolveSolanaConfig(): SolanaConfig {
    let rpcUrl = process.env.ANCHOR_PROVIDER_URL ?? "";
    let keypairPath = "";

    if (!rpcUrl) {
        try {
            const out = execFileSync("solana", ["config", "get"], { encoding: "utf8" });
            const rpc = out.match(/^RPC URL:\s*(.+)$/m);
            if (rpc) rpcUrl = rpc[1].trim();
        } catch {
            // Solana CLI not installed — caller falls back to defaults.
        }
    }

    try {
        const out = execFileSync("solana", ["config", "get"], { encoding: "utf8" });
        const key = out.match(/^Keypair Path:\s*(.+)$/m);
        if (key) keypairPath = expandHome(key[1].trim());
    } catch {
        // ignore
    }

    rpcUrl = rpcUrl.replace(/\/+$/, "");
    const cluster: Cluster = /mainnet/.test(rpcUrl) ? "mainnet-beta" : "devnet";
    const wsUrl = rpcUrl.replace(/^https/, "wss");
    return { cluster, rpcUrl, wsUrl, keypairPath };
}
