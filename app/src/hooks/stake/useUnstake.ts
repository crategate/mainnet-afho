import { useCallback, useState } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { useStakingProgram, STAKING_PROGRAM_ID, CRANK_PROGRAM_ID, AMM_PROGRAM_ID } from '../../anchor/setup';
import type { StakePoolData } from './usePool';
import type { Position } from './usePositions';

// Principal-penalty estimate for the debug log: the pool's CONFIGURED bps
// (the on-chain unstake reads these) with the devnet init defaults as a
// fallback only until the pool account loads — never let the log drift
// from the real penalty the exit button quotes.
function principalPenaltyBpsForState(state: number | undefined, pool: StakePoolData | null | undefined) {
    if (state === 1) return pool?.afterHoursPenaltyBps ?? 300; // extended-hours exit
    if (state === 2) return pool?.closedPenaltyBps ?? 600; // closed exit
    if (state === 3) return pool?.haltedPenaltyBps ?? 1800; // halted exit
    return 0;
}

export function useUnstake(
    mint: PublicKey | null,
    marketStatusPda?: PublicKey,
    marketState?: number,
    pool?: StakePoolData | null,
) {
    const { publicKey } = useWallet();
    const { connection } = useConnection();
    const program = useStakingProgram();
    const [loadingIndex, setLoadingIndex] = useState<number | null>(null);

    const unstake = useCallback(async (position: Position) => {
        if (!publicKey || !program || !mint || !connection) {
            throw new Error('Wallet not connected or missing parameters');
        }

        setLoadingIndex(position.index);
        try {
            const [poolPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('pool'), mint.toBuffer()],
                STAKING_PROGRAM_ID
            );
            const [vaultPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('vault'), poolPda.toBuffer()],
                STAKING_PROGRAM_ID
            );
            const [rewardVaultPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('rewards'), poolPda.toBuffer()],
                STAKING_PROGRAM_ID
            );
            const [penaltyVaultPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('penalties'), poolPda.toBuffer()],
                STAKING_PROGRAM_ID
            );
            // AMM bond vault: the AFHO ATA of the amm_state PDA. The 5% POSR
            // legs of every exit refill this (bond-sale inventory).
            const [ammStatePda] = PublicKey.findProgramAddressSync(
                [Buffer.from('amm_state'), mint.toBuffer()],
                AMM_PROGRAM_ID
            );
            const bondVault = getAssociatedTokenAddressSync(mint, ammStatePda, true, TOKEN_2022_PROGRAM_ID);
            const marketStatus = marketStatusPda ?? PublicKey.findProgramAddressSync(
                [Buffer.from('market_status')],
                CRANK_PROGRAM_ID
            )[0];
            const ownerToken = getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_2022_PROGRAM_ID);
            const penaltyBps = principalPenaltyBpsForState(marketState, pool);
            const principalPenaltyRaw = Math.floor(position.amount * penaltyBps / 10000);

            console.log('Exit stake transaction', {
                position: position.pda.toBase58(),
                index: position.index,
                amountRaw: position.amount,
                marketState,
                principalPenaltyBps: penaltyBps,
                principalPenaltyRaw,
                principalPenaltyDisplay: `${(principalPenaltyRaw / 1e9).toFixed(4)} AFHO`,
                pool: poolPda.toBase58(),
                vault: vaultPda.toBase58(),
                rewardVault: rewardVaultPda.toBase58(),
                bondVault: bondVault.toBase58(),
                marketStatus: marketStatus.toBase58(),
            });

            const signature = await program.methods
                .unstake()
                .accounts({
                    owner: publicKey,
                    mint,
                    pool: poolPda,
                    position: position.pda,
                    vault: vaultPda,
                    rewardVault: rewardVaultPda,
                    penaltyVault: penaltyVaultPda,
                    bondVault,
                    ownerToken,
                    marketStatus,
                    tokenProgram: TOKEN_2022_PROGRAM_ID,
                })
                .rpc({
                    skipPreflight: false,
                    preflightCommitment: 'confirmed',
                    maxRetries: 3,
                });

            return signature;
        } finally {
            setLoadingIndex(null);
        }
    }, [publicKey, program, mint, connection, marketStatusPda, marketState, pool]);

    return { unstake, loadingIndex };
}