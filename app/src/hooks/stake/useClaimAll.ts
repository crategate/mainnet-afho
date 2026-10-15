import { useCallback, useState } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { useStakingProgram, STAKING_PROGRAM_ID, CRANK_PROGRAM_ID, AMM_PROGRAM_ID } from '../../anchor/setup';
import { PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import type { Position } from './usePositions';

export function useClaimAll(mint: PublicKey | null, positions: Position[], marketStatusPda?: PublicKey) {
    const { publicKey } = useWallet();
    const { connection } = useConnection();
    const program = useStakingProgram();
    const [loading, setLoading] = useState(false);

    const claimAll = useCallback(async () => {
        if (!publicKey || !program || !mint || !positions.length || !connection) {
            throw new Error('Wallet not connected or missing parameters');
        }

        setLoading(true);
        try {
            const [poolPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('pool'), mint.toBuffer()],
                STAKING_PROGRAM_ID
            );
            const [rewardVaultPda] = PublicKey.findProgramAddressSync(
                [Buffer.from('rewards'), poolPda.toBuffer()],
                STAKING_PROGRAM_ID
            );
            // AMM bond vault: the AFHO ATA of the amm_state PDA. The 5% POSR
            // leg of every claim refills this (bond-sale inventory).
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

            // One failing claim aborts the whole transaction (Vesting /
            // ClaimsClosed / size limits), so: (1) drop positions that are
            // still vesting — the market-status layout is disc(8) +
            // state(1) + timestamp(8) + trading_day_index(8); (2) chunk into
            // transactions of 4 — each claim ix serializes ~9 accounts ≈
            // 300B, and the 1232B packet caps a legacy tx at ~4 claims.
            let currentDay = 0;
            if (marketStatus) {
                const msInfo = await connection.getAccountInfo(marketStatus);
                if (msInfo && msInfo.data.length >= 25) {
                    currentDay = Number(
                        new DataView(msInfo.data.buffer, msInfo.data.byteOffset).getBigUint64(17, true),
                    );
                }
            }
            const claimable = positions.filter(
                (p) => currentDay >= p.entryTradingDay + (p.daysToUnlock ?? 0),
            );
            if (!claimable.length) {
                throw new Error('No positions are vested for claiming yet');
            }

            const CLAIMS_PER_TX = 4;
            const sendAndConfirm = program.provider.sendAndConfirm?.bind(program.provider);
            if (!sendAndConfirm) throw new Error('Provider cannot send transactions');

            const signatures: string[] = [];
            for (let i = 0; i < claimable.length; i += CLAIMS_PER_TX) {
                const tx = new Transaction();
                const { blockhash } = await connection.getLatestBlockhash('confirmed');
                tx.recentBlockhash = blockhash;
                tx.feePayer = publicKey;

                for (const position of claimable.slice(i, i + CLAIMS_PER_TX)) {
                    const ix = await program.methods
                        .claim()
                        .accounts({
                            owner: publicKey,
                            mint,
                            pool: poolPda,
                            position: position.pda,
                            rewardVault: rewardVaultPda,
                            bondVault,
                            ownerToken,
                            marketStatus,
                            tokenProgram: TOKEN_2022_PROGRAM_ID,
                        })
                        .instruction();
                    tx.add(ix);
                }

                signatures.push(await sendAndConfirm(tx));
            }
            return signatures.join(', ');
        } catch (e) {
            console.error('Claim all error:', e);
            throw e;
        } finally {
            setLoading(false);
        }
    }, [publicKey, program, mint, positions, connection, marketStatusPda]);

    return { claimAll, loading };
}