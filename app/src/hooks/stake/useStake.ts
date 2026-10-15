import { useCallback } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { useStakingProgram, STAKING_PROGRAM_ID, CRANK_PROGRAM_ID } from '../../anchor/setup';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import BN from 'bn.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

/** Exact decimal string → raw base units as BN (e.g. "12.345678912", 9 dp).
    Replaces the old float path (`Number(amount) * 1e9`), which rounded above
    the wallet's raw balance for large amounts and failed the transfer.
    Exported for StakeForm's exact amount-vs-balance comparisons.
    Rejects negative amounts — token quantities are positive-only (zero is
    rejected by the stake caller).
    Throws on invalid input — callers guard. */
export function parseAmountToRawBN(amount: string, decimals: number): BN {
    let s = amount.trim();
    if (s === '' || s.startsWith('-')) {
        throw new Error('Amount must be positive');
    }
    s = s.replace(/^\+/, '');
    if (/e/i.test(s)) s = Number(s).toString(); // exponent notation → plain decimal
    if (s === '' || s.startsWith('-')) {
        throw new Error('Amount must be positive');
    }
    const [whole, frac = ''] = s.split('.');
    const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
    return new BN(whole || '0', 10)
        .mul(new BN(10).pow(new BN(decimals)))
        .add(new BN(fracPadded || '0', 10));
}

export function useStake(mint: PublicKey | null, marketStatusPda?: PublicKey) {
    const { publicKey } = useWallet();
    const { connection } = useConnection();
    const program = useStakingProgram();

    const stake = useCallback(async (amount: string) => {
        if (!publicKey || !program || !mint || !connection || !amount) {
            throw new Error('Wallet not connected or missing params');
        }

        // Derive PDAs using the exported constant (same as program.programId, but explicit)
        const [poolPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('pool'), mint.toBuffer()],
            STAKING_PROGRAM_ID
        );
        const [userIndexPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('user_index'), publicKey.toBuffer()],
            STAKING_PROGRAM_ID
        );
        const [vaultPda] = PublicKey.findProgramAddressSync(
            [Buffer.from('vault'), poolPda.toBuffer()],
            STAKING_PROGRAM_ID
        );
        const marketStatus = marketStatusPda ?? PublicKey.findProgramAddressSync(
            [Buffer.from('market_status')],
            CRANK_PROGRAM_ID
        )[0];

        type AccountNamespace = Record<
            string,
            { fetchNullable(key: PublicKey): Promise<{ nextIndex: unknown } | null> } | undefined
        >;
        let userIndex = null;
        try {
            userIndex =
                (await (program.account as AccountNamespace).userStakeIndex?.fetchNullable(
                    userIndexPda,
                )) ?? null;
        } catch {
            console.log('No existing userIndex account (expected for first stake)');
        }
        const index = userIndex ? Number(userIndex.nextIndex) : 0;

        const indexBytes = new BN(index).toArrayLike(Buffer, 'le', 8);

        const [positionPda] = PublicKey.findProgramAddressSync([
            Buffer.from('position'),
            poolPda.toBuffer(),
            publicKey.toBuffer(),
            indexBytes,
        ], STAKING_PROGRAM_ID);

        const ownerToken = getAssociatedTokenAddressSync(mint, publicKey, false, TOKEN_2022_PROGRAM_ID);
        const stakeAmount = parseAmountToRawBN(amount, 9);
        if (stakeAmount.lten(0)) {
            throw new Error('Stake amount must be greater than zero');
        }

        // ─── DEBUG LOGS ───
        console.group('STAKE DEBUG');
        console.log('STAKING_PROGRAM_ID :', STAKING_PROGRAM_ID.toBase58());
        console.log('program.programId  :', program.programId.toBase58());
        console.log('CRANK_PROGRAM_ID   :', CRANK_PROGRAM_ID.toBase58());
        console.log('mint               :', mint.toBase58());
        console.log('poolPda            :', poolPda.toBase58());
        console.log('userIndexPda       :', userIndexPda.toBase58());
        console.log('vaultPda           :', vaultPda.toBase58());
        console.log('marketStatus       :', marketStatus.toBase58());
        console.log('owner (wallet)     :', publicKey.toBase58());
        console.log('ownerToken         :', ownerToken.toBase58());
        console.log('index (decimal)    :', index);
        console.log('index (hex LE)     :', indexBytes.toString('hex'));
        console.log('positionPda        :', positionPda.toBase58());
        console.log('stakeAmount        :', stakeAmount.toString());
        console.groupEnd();
        // ──────────────────

        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');


        // Phantom will sign and send
        const signature = await program.methods.stake(stakeAmount, new BN(index), 0).accounts({
            owner: publicKey,
            mint,
            pool: poolPda,
            userIndex: userIndexPda,
            position: positionPda,
            ownerToken,
            vault: vaultPda,
            marketStatus,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
        }).rpc({
            skipPreflight: false,
            preflightCommitment: 'confirmed',
            maxRetries: 3,
        });

        // Wait for confirmation with the same blockhash parameters
        await connection.confirmTransaction(
            { signature, blockhash, lastValidBlockHeight },
            'confirmed'
        );

        return signature;
    }, [publicKey, program, mint, connection, marketStatusPda]);

    return { stake };
}