import * as anchor from "@coral-xyz/anchor";
import * as myIdl from "../../target/idl/crank_oracle.json";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import { pubkey, writeDeploymentState } from "../lib/deployment-state";
import { resolveSolanaConfig } from "../lib/cluster";
async function main() {
    // 1. Load the program via provider env (ANCHOR_WALLET /
    // ANCHOR_PROVIDER_URL — set by `anchor run` from Anchor.toml [provider]),
    // so market_status is paid for by the SAME wallet as every other launch
    // step. This previously hardcoded ~/.config/solana/id.json + the public
    // devnet RPC, which mixed wallets inside the `init` step (bounty authority
    // mismatches → 0x1773) and would have hit devnet on a mainnet launch.
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = new anchor.Program(myIdl as anchor.Idl, provider);
    const net = resolveSolanaConfig();

    console.log("Program ID:", program.programId.toBase58());

    // 3. Derive your Market Status PDA
    const [marketStatusPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("market_status")],
        program.programId
    );
    console.log("Market Status PDA:", marketStatusPda.toBase58());
    writeDeploymentState({
        cluster: net.cluster,
        crankProgram: pubkey(program.programId),
        marketStatus: pubkey(marketStatusPda),
    });

    // 4. Build and send the initialization transaction
    try {
        const tx = await program.methods
            .initializeState()
            .accounts({
                marketStatus: marketStatusPda, // Anchor converts your rust snake_case to camelCase
                payer: provider.wallet.publicKey,
                systemProgram: anchor.web3.SystemProgram.programId,
            })
            .rpc();

        console.log(`Success! State initialized. Tx: ${tx}`);
    } catch (e) {
        console.error("Initialization failed (It might already be initialized):", e);
    }
}

main().catch(console.error);