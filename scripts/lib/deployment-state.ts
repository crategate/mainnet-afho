import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

type DeploymentState = {
    cluster?: string;
    updatedAt?: string;
    mint?: string;
    stakingProgram?: string;
    crankProgram?: string;
    ammProgram?: string;
    ammState?: string;
    ammOfferList?: string;
    ammUsdcVault?: string;
    ammAfhoVault?: string;
    coinMintProgram?: string;
    pool?: string;
    vault?: string;
    rewardVault?: string;
    penaltyVault?: string;
    posrVault?: string;
    marketStatus?: string;
    raydiumPool?: string;
    raydiumLpMint?: string;
    raydiumAmmConfig?: string;
    raydiumProgram?: string;
    raydiumSolUsdcPool?: string;
    raydiumSolUsdcConfig?: string;
    claimLookupTable?: string;
};

const deploymentPath = path.join(process.cwd(), "app", "public", "deployment.json");

export function writeDeploymentState(update: DeploymentState) {
    let current: DeploymentState = {};

    if (fs.existsSync(deploymentPath)) {
        current = JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
    }

    const next: DeploymentState = {
        ...current,
        ...update,
        updatedAt: new Date().toISOString(),
    };

    fs.mkdirSync(path.dirname(deploymentPath), { recursive: true });
    fs.writeFileSync(deploymentPath, JSON.stringify(next, null, 2) + "\n");
    console.log("Updated app deployment state:", deploymentPath);
}

export function readDeploymentState(): DeploymentState {
    if (!fs.existsSync(deploymentPath)) return {};
    return JSON.parse(fs.readFileSync(deploymentPath, "utf-8"));
}

export function pubkey(value: PublicKey) {
    return value.toBase58();
}