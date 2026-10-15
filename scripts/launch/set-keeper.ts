import * as anchor from "@coral-xyz/anchor";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

// Rotate the AMM keeper hot wallet (amm set_keeper). The keeper is the
// OPERATIONAL key that fires the crank-gated daily instructions
// (make_offers / dex_buyback / update_tradeday_stats / buy_the_dip); it
// holds NO admin power and can never rotate anything — set_keeper itself
// is authority-gated (has_one = authority), and the keeper can never call
// it (see programs/amm/src/instructions/set_keeper.rs).
//
// This is the launch-day path for running the keeper on the VPS WITHOUT
// the launch wallet: set_keeper → the VPS wallet, then run the keeper
// (bount-mainnet) there as that wallet. Rotate the keeper BEFORE the
// ops-bundle multisig rotation so the multisig never holds a hot key
// (AUTHORITY-PLAYBOOK §4).
//
// Usage:   KEEPER=<pubkey> anchor run set-keeper
//   or:    KEEPER=<pubkey> anchor run set-keeper
//
// Run as the CURRENT AmmState.authority (the launch wallet).

async function main(): Promise<void> {
    const arg = process.env.KEEPER ?? process.argv[2];
    if (!arg) {
        console.error("usage: KEEPER=<pubkey> anchor run set-keeper");
        process.exit(1);
    }
    let newKeeper: PublicKey;
    try {
        newKeeper = new PublicKey(arg);
    } catch {
        console.error(`KEEPER is not a valid pubkey: ${arg}`);
        process.exit(1);
    }

    // mev-keeper env contract: .env RPC_URL (funded endpoint) wins over the
    // ANCHOR_PROVIDER_URL that `anchor run` exports; works via bare ts-node too.
    dotenv.config();
    const rpcUrl = process.env.RPC_URL ?? process.env.ANCHOR_PROVIDER_URL;
    if (!rpcUrl) {
        console.error("set RPC_URL (or run via `anchor run set-keeper`)");
        process.exit(1);
    }
    const walletPath = (process.env.ANCHOR_WALLET ?? "~/.config/solana/id.json").replace(
        /^~/, process.env.HOME ?? "~"
    );
    const payer = Keypair.fromSecretKey(
        Buffer.from(JSON.parse(fs.readFileSync(walletPath, "utf-8")))
    );
    const provider = new anchor.AnchorProvider(
        new Connection(rpcUrl, "confirmed"),
        new anchor.Wallet(payer),
        {}
    );
    anchor.setProvider(provider);

    const idl = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "target", "idl", "amm.json"), "utf-8")
    );
    const program = new anchor.Program(idl, provider);

    const deployment = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "app", "public", "deployment.json"), "utf-8")
    );
    const ammStatePda = new PublicKey(deployment.ammState);

    const before: any = await (program.account as any).ammState.fetch(ammStatePda);
    console.log(`amm_state ${ammStatePda.toBase58()}`);
    console.log(`  authority (signer must be this): ${new PublicKey(before.authority).toBase58()}`);
    console.log(`  current keeper:                  ${new PublicKey(before.keeper).toBase58()}`);

    if (newKeeper.equals(new PublicKey("11111111111111111111111111111111"))) {
        console.error("REFUSING: 111…1 would freeze the keeper slot forever (no set_keeper recovery).");
        process.exit(1);
    }
    if (newKeeper.equals(new PublicKey(before.keeper))) {
        console.log("keeper already set to that pubkey — nothing to do.");
        return;
    }

    // Loud echo BEFORE sending (launch-script convention: destination
    // visible even if the send fails).
    console.log(`\n→ rotating keeper to ${newKeeper.toBase58()}`);

    const tx = await program.methods
        .setKeeper(newKeeper)
        .accounts({
            authority: provider.wallet.publicKey,
            ammState: ammStatePda,
        })
        .rpc();
    console.log(`  tx ${tx}`);

    // Read-back verify.
    const after: any = await (program.account as any).ammState.fetch(ammStatePda);
    const landed = new PublicKey(after.keeper).equals(newKeeper);
    if (!landed) {
        console.error(`✗ read-back mismatch: keeper is still ${new PublicKey(after.keeper).toBase58()}`);
        process.exit(1);
    }
    console.log(`✓ keeper = ${newKeeper.toBase58()}`);
    console.log(
        `\nThe keeper can now run as that wallet (bount-mainnet on the VPS needs only SOL for fees —\n` +
        `day-flow moves program vault funds, not the keeper's). The launch wallet keeps every\n` +
        `authority; re-verify with: anchor run check-authorities`
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
