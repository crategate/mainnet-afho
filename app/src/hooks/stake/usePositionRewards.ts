import { useMemo } from 'react';
import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { usePool } from './usePool';
import { useMarketStatus } from '../useMarketStatus';
import type { Position } from './usePositions';

export interface EnrichedPosition extends Position {
    multiplierBps: number;
    multiplierDisplay: string;
    tradingDays: number;
    weight: number;
    grossRewardRaw: number;
    penaltyBps: number;
    penaltyRaw: number;
    posrTaxRaw: number;
    netRewardRaw: number;
    netRewardDisplay: string;
    frozenUntilDay: number;
    freezeBonusBps: number;
    isFrozen: boolean;
    freezeEnded: boolean; // freeze window over but not yet cleared by a claim
}

export function usePositionRewards(mint: PublicKey | null, positions: Position[], marketStatusPda?: PublicKey) {
    const { pool } = usePool(mint);
    const { data: marketData } = useMarketStatus(marketStatusPda);

    const enriched: EnrichedPosition[] = useMemo(() => {
        if (!pool || !marketData || !positions.length) return [];

        const currentTradingDay = marketData.tradingDay;
        const maxMultiplierBps = Number(pool.maxMultiplierBps);
        const posrTaxBps = Number(pool.posrTaxBps);
        const accPerShare = new BN(pool.accruedRewardPerShare.toString());
        const SCALE = new BN(10).pow(new BN(12));

        return positions.map(pos => {
            const amount = pos.amount;
            const entryDay = pos.entryTradingDay;
            const tradingDays = Math.max(0, currentTradingDay - entryDay - 1);

            // Same curve as the Rust program: base + (days * range) / (days + 60)
            const base = 10000;
            const range = Math.max(0, maxMultiplierBps - base);
            const multiplier = base + Math.floor((tradingDays * range) / (tradingDays + 60));

            // Freeze bonus multiplies the base while active (positions/
            // freezeCurve mirror). Display shows the effective total. A
            // "frozen" state requires a real stored bonus — bonds can never
            // be frozen (vesting gate on-chain).
            const frozenUntilDay = pos.frozenUntilDay ?? 0;
            const freezeBonusBps = pos.freezeBonusBps ?? 0;
            const hasFreeze = frozenUntilDay > 0 && freezeBonusBps > 0;
            const isFrozen = hasFreeze && currentTradingDay <= frozenUntilDay;
            const freezeEnded = hasFreeze && !isFrozen;
            const effectiveBps = isFrozen
                ? Math.floor((multiplier * (10000 + freezeBonusBps)) / 10000)
                : multiplier;

            // Display weight previews the next checkpointed weight.
            const weight = Math.floor((amount * effectiveBps) / 10000);

            // Claimable rewards use the on-chain checkpointed weight so older
            // reward distributions are not re-counted as multipliers grow.
            const weightBN = new BN(pos.currentWeight);
            const accumulated = weightBN.mul(accPerShare).div(SCALE);
            const rewardDebt = new BN(pos.rewardDebt);
            const gross = accumulated.gt(rewardDebt) ? accumulated.sub(rewardDebt) : new BN(0);

            // Claims are market-open only. No tiered claim penalty is applied.
            const posrTax = gross.muln(posrTaxBps).divn(10000);
            const net = gross.sub(posrTax);

            const grossNum = parseFloat(gross.toString()) / 1e9;
            const posrTaxNum = parseFloat(posrTax.toString()) / 1e9;
            const netNum = parseFloat(net.toString()) / 1e9;

            return {
                ...pos,
                multiplierBps: effectiveBps,
                multiplierDisplay: (effectiveBps / 10000).toFixed(2),
                tradingDays,
                weight,
                grossRewardRaw: grossNum,
                penaltyBps: 0,
                penaltyRaw: 0,
                posrTaxRaw: posrTaxNum,
                netRewardRaw: netNum,
                netRewardDisplay: `${netNum.toFixed(4)} AFHO`,
                frozenUntilDay,
                freezeBonusBps,
                isFrozen,
                freezeEnded,
            };
        });
    }, [pool, marketData, positions]);

    const grandTotal = useMemo(() => {
        return enriched.reduce((sum, pos) => sum + pos.netRewardRaw, 0);
    }, [enriched]);

    // Claimable vs locked: a still-vesting position (bond lots) gates ALL of
    // its pending rewards — claim() requires entry_trading_day +
    // days_to_unlock <= current trading day before it settles anything.
    const claimSplit = useMemo(() => {
        if (!marketData) return { claimableTotal: 0, vestingTotal: 0, vestingCount: 0 };
        const currentTradingDay = marketData.tradingDay;
        let claimableTotal = 0;
        let vestingTotal = 0;
        let vestingCount = 0;
        for (const pos of enriched) {
            const unlockDay = pos.entryTradingDay + (pos.daysToUnlock ?? 0);
            if (currentTradingDay >= unlockDay) {
                claimableTotal += pos.netRewardRaw;
            } else {
                vestingTotal += pos.netRewardRaw;
                vestingCount += 1;
            }
        }
        return { claimableTotal, vestingTotal, vestingCount };
    }, [enriched, marketData]);

    return {
        enriched,
        grandTotal,
        claimableTotal: claimSplit.claimableTotal,
        vestingTotal: claimSplit.vestingTotal,
        vestingCount: claimSplit.vestingCount,
        pool,
        marketData,
    };
}