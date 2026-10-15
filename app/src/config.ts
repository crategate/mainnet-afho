import { PublicKey } from '@solana/web3.js';

export type DeploymentConfig = {
    cluster?: string;
    updatedAt?: string;
    mint?: string;
    stakingProgram?: string;
    crankProgram?: string;
    coinMintProgram?: string;
    pool?: string;
    vault?: string;
    rewardVault?: string;
    penaltyVault?: string;
    posrVault?: string;
    marketStatus?: string;
    ammProgram?: string;
    ammState?: string;
    ammOfferList?: string;
    ammUsdcVault?: string;
    ammAfhoVault?: string;
    // Raydium CPMM program (DEX fills in the activity feed are the txs that
    // touch it; also pins for TWAP reads)
    raydiumProgram?: string;
    // Address lookup table holding the SOL bond claim's static account set
    // (scripts/launch/create-claim-alt.ts). Lets offer_claim_sol go out as a v0
    // transaction with a compute-budget instruction — the legacy form is 19
    // bytes under the packet limit and cannot carry one.
    claimLookupTable?: string;

};

export type ResolvedDeployment = DeploymentConfig & {
    mintKey: PublicKey;
    marketStatusKey?: PublicKey;
};

export function resolveDeployment(config: DeploymentConfig): ResolvedDeployment {
    const mint = config.mint ?? import.meta.env.VITE_AFHO_MINT;

    if (!mint) {
        throw new Error('No mint configured. Run anchor run mint, then refresh the app.');
    }

    return {
        ...config,
        mint,
        mintKey: new PublicKey(mint),
        marketStatusKey: config.marketStatus ? new PublicKey(config.marketStatus) : undefined,
    };
}