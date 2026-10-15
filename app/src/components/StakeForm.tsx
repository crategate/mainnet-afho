import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import BN from 'bn.js';
import { useStake, parseAmountToRawBN } from '../hooks/stake/useStake';
import { useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { useTokenBalance } from '../hooks/useTokenBalance';
import { useChainData } from '../context/useChainData';
import { GlitchText } from './GlitchText.tsx';
import { CopyAddress } from './CopyAddress.tsx';
import { WalletMark } from './WalletMark.tsx';
import { useTxResult } from '../context/TxResultProvider';

const TOKEN_DECIMALS = 9;
const PERCENT_STEPS = [25, 50, 75] as const;
const MAX_POSITION_SIZE = 9_006_000;

/* Amber notes stay mounted inside this wrapper so their height can animate
   (flex + max-height) both when appearing and disappearing — conditional
   rendering would pop them in/out with no transition. The whole tile (and
   its stretched sibling) resizes smoothly with it. */
function PenaltyReveal({ show, children }: { show: boolean; children: React.ReactNode }) {
    return (
        <div className={`stake-note-reveal${show ? ' open' : ''}`} aria-hidden={!show}>
            <p className="stake-penalty-note" role={show ? 'alert' : undefined}>
                {children}
            </p>
        </div>
    );
}

/** Raw u64 base units → plain decimal token string (9 dp, trailing zeros
    stripped). BigInt math so a filled amount can never round above the
    wallet's true balance. */
function rawToAmountString(raw: bigint, decimals: number): string {
    const base = 10n ** BigInt(decimals);
    const whole = raw / base;
    const frac = (raw % base).toString().padStart(decimals, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole.toString();
}

interface StakeFormProps {
    mint: PublicKey;
    marketStatusPda?: PublicKey;
    onStakeSuccess?: () => void;
}

export function StakeForm({ mint, marketStatusPda, onStakeSuccess }: StakeFormProps) {
    const { stake } = useStake(mint, marketStatusPda);
    const { connected, publicKey } = useWallet();
    const { balance, rawBalance, refresh: refreshBalance } = useTokenBalance(mint, publicKey, TOKEN_DECIMALS);
    const queryClient = useQueryClient();
    const { refresh: refreshChainData } = useChainData();
    const [amount, setAmount] = useState('');
    const [loading, setLoading] = useState(false);
    const reportTx = useTxResult();

    const handleStake = async () => {
        if (!amount) return;
        // Zero/negative never reaches a signature: the submit button gates
        // it and the inline PenaltyReveal states the rule.
        if (!(Number(amount) > 0)) return;
        const stakedAmount = amount;
        setLoading(true);
        try {
            const tx = await stake(amount);
            reportTx({
                kind: 'success',
                headline: `Staked ${stakedAmount} AFHO`,
                signature: tx,
            });
            setAmount('');
            void refreshBalance();
            // The new position appears immediately — no page refresh needed.
            // Invalidate the shared positions query (all mounted list
            // instances) and the chain snapshot (pool totalStaked), then
            // repeat once shortly after to cover devnet RPC lag on the fresh
            // account.
            onStakeSuccess?.();
            void queryClient.invalidateQueries({ queryKey: ['positions'] });
            void refreshChainData('pool');
            setTimeout(() => {
                void queryClient.invalidateQueries({ queryKey: ['positions'] });
            }, 1500);
        } catch (e) {
            reportTx({
                kind: 'error',
                headline: 'Stake did not confirm',
                detail: (e as Error).message,
            });
        } finally {
            setLoading(false);
        }
    };

    /* Quick-fill: 25/50/75% and MAX of the wallet's AFHO balance, computed
       from the raw u64 so the inserted amount always stakes exactly. */
    const fillFromBalance = (pct: number) => {
        if (rawBalance === null) return;
        const raw = pct >= 100 ? rawBalance : (rawBalance * BigInt(pct)) / 100n;
        setAmount(rawToAmountString(raw, TOKEN_DECIMALS));
    };

    const fillDisabled = rawBalance === null || rawBalance === 0n;

    /* Exact over-balance check (raw bigint, not floats — Number(amount) and
       the balance float can differ by an ulp at devnet scale, which would
       wrongly disable staking right after a MAX fill). Falls back to the
       float compare for inputs the exact parser rejects. */
    const amountExceedsBalance = (() => {
        if (amount === '') return false;
        if (rawBalance !== null) {
            try {
                return parseAmountToRawBN(amount, TOKEN_DECIMALS).gt(new BN(rawBalance.toString()));
            } catch {
                /* fall through to float compare */
            }
        }
        return balance !== null && Number(amount) > balance;
    })();

    /* Positive-only gate: the stake amount is a token quantity, so zero and
       negatives are invalid (the on-chain arg is u64 and the UI must not
       hand it a wrapped negative). */
    const amountIsNonPositive = amount !== '' && !(Number(amount) > 0);

    /* Input glow: 0 while empty/invalid, then a log curve toward the
       9,006,000 position cap so the cyan border+halo brighten and widen
       perceptibly from the first digit without maxing out early. */
    const stakeGlow = (() => {
        const n = Number(amount);
        if (amount === '' || !(n > 0)) return 0;
        return Math.min(1, Math.log10(1 + n) / Math.log10(1 + MAX_POSITION_SIZE));
    })();

    /* Step ladder: the form's effects grow slightly more excited as the
       staking process completes — empty (idle) → typing → ready. */
    const step = !amount
        ? 'idle'
        : amountExceedsBalance || amountIsNonPositive
            ? 'typing'
            : 'ready';

    return (
        <div
            className={`stake-form stake-card rainbow-glow neon-shadow glass-pane ${connected ? 'connected' : ''}`}
            data-step={step}
            style={{ '--shadow-delay': '0.4s' } as React.CSSProperties}
        >
            <h3>Lock & Earn AFHO</h3>
            <div className="mint-display">
                Mint: <br />
                <CopyAddress
                    value={mint.toBase58()}
                    className="mint-copy"
                    title="Copy AFHO token address"
                    display={
                        <code>
                            {mint.toBase58().slice(0, 8)}…{mint.toBase58().slice(-8)}
                        </code>
                    }
                />
            </div>
            <div className="balance-line">
                {balance !== null ? balance.toFixed(4) : '—'} <span>AFHO</span>
            </div>
            <p className="custodial-note">
                <GlitchText
                    text="Tokens move into the program vault and no longer appear in your wallet. You can see your positions below. Rewards from bond sales & unlock penalties."
                    variant="light"
                    split="word"
                    step={0.3}
                />
            </p>
            <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="Amount to stake"
                disabled={loading}
                min={0}
                max={balance || undefined}
                className={`neon-glitch${stakeGlow > 0 ? ' filled' : ''}`}
                style={{ '--stake-glow': stakeGlow } as React.CSSProperties}
            />
            < div className="pct-row" role="group" >
                {PERCENT_STEPS.map((pct) => (
                    <button
                        key={pct}
                        type="button"
                        className="pct-btn"
                        disabled={fillDisabled}
                        onClick={() => fillFromBalance(pct)}
                    >
                        {pct}%
                    </button>
                ))}
                <button
                    type="button"
                    className="pct-btn"
                    disabled={fillDisabled}
                    onClick={() => fillFromBalance(100)}
                >
                    MAX
                </button>
            </div>
            <PenaltyReveal show={amountIsNonPositive}>
                Stake amount must be greater than zero.
            </PenaltyReveal>
            <PenaltyReveal show={Number(amount) >= MAX_POSITION_SIZE}>
                Max position size 9,006,000
            </PenaltyReveal>
            <PenaltyReveal show={amount !== ''}>
                Penalty: unlocking your position outside NYSE trading hours
                (after-hours, closed, or halted) penalizes your principal;
                exit while the market is open to avoid it. Reward multipliers
                grow every trade day, reaching a 3X max.
            </PenaltyReveal>
            <button
                className="stake-submit"
                onClick={handleStake}
                disabled={loading || !amount || amountIsNonPositive || amountExceedsBalance}
            >
                {loading ? <><WalletMark /> Staking…</> : <><WalletMark /> Stake</>}
            </button>
        </div >
    );
};
