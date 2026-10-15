import { BorshInstructionCoder, type Idl } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

/* Pure classifier for the /activity page: takes one fetched transaction
   (jsonParsed shape) plus a wallet/deployment context and returns the row
   event, or null when the transaction is none of this wallet's business.
   Framework-free on purpose — a node script can run the same code against
   live devnet to validate the decoding without a browser. */

export type ActivityKind =
    | 'stake'
    | 'unstake'
    | 'claim'
    | 'freeze'
    | 'settle'
    | 'bond'
    | 'position'
    | 'protocol'
    | 'sent'
    | 'received'
    | 'swap';

export interface ActivityEvent {
    signature: string;
    blockTime: number | null;
    slot: number;
    kind: ActivityKind;
    /* Plain token movement (manual transfer or DEX fill) — hidden until
       the reveal toggle flips on. */
    manual: boolean;
    /* Signed raw AFHO units for the wallet's token accounts (BigInt-safe
       sums; convert for display). */
    afhoDelta: bigint | null;
    /* Net lamports for the fee payer when this wallet signed. */
    solDelta: number | null;
    signed: boolean;
    days?: number;
    positionIndex?: number;
    tier?: number; // 0 = sml, 1 = med, 2 = big
    units?: number;
    sheetDay?: number;
    payLeg?: 'usdc' | 'sol';
    altDesk?: boolean;
    counterparty?: string;
    /* Raw instruction name for generic protocol rows (authority ops etc). */
    ixName?: string;
}

export interface ActivityPrograms {
    staking: string;
    amm: string;
    crank: string;
    coinMint: string;
    raydium?: string;
}

export interface ActivityContext {
    wallet: string;
    ata: string;
    mint: string;
    programs: ActivityPrograms;
    coderStaking: BorshInstructionCoder;
    coderAmm: BorshInstructionCoder;
}

export function makeCoder(idl: unknown): BorshInstructionCoder {
    return new BorshInstructionCoder(idl as Idl);
}

/* ── minimal json-encoding transaction shapes (only the fields we read) ──
   web3.js v1.98 fails its own schema check on Helius's jsonParsed account
   keys, so the pipeline runs on the default json encoding — and that
   encoding comes in TWO runtime shapes: legacy transactions decompose to
   message.accountKeys + instructions, while versioned (v0) transactions
   keep the compiled form (staticAccountKeys + compiledInstructions with
   Buffer data). Account keys may be strings or PublicKey instances. The
   parser below tolerates all of it. */

interface TokenBalance {
    accountIndex: number;
    mint: string;
    owner?: string;
    uiTokenAmount: { amount: string };
}

interface TxMeta {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances: TokenBalance[] | null;
    postTokenBalances: TokenBalance[] | null;
    innerInstructions: { index: number; instructions: unknown[] }[] | null;
    loadedAddresses?: unknown;
}

export interface TxJson {
    slot: number;
    blockTime: number | null;
    transaction: {
        message: Record<string, unknown> & {
            instructions?: unknown[];
            compiledInstructions?: unknown[];
        };
    };
    meta: TxMeta;
}

function keyToString(k: unknown): string {
    return typeof k === 'string' ? k : String(k);
}

/* Loaded ALT addresses in index order (writable before readonly). */
function loadedList(meta: TxMeta): string[] {
    const loaded = meta.loadedAddresses;
    if (!loaded) return [];
    if (Array.isArray(loaded)) return loaded.map(keyToString);
    const rec = loaded as { writable?: unknown[]; readonly?: unknown[] };
    return [...(rec.writable ?? []), ...(rec.readonly ?? [])].map(keyToString);
}

/* One instruction normalized to {programId, dataBuffer} across every shape
   web3.js hands back: programId string (inner instructions) or index
   (legacy top level, v0 compiledInstructions), data base58 or Buffer. */
function normalizeInstruction(ix: unknown, accountsList: string[]): { programId: string; data: Buffer } | null {
    if (typeof ix !== 'object' || ix === null) return null;
    const rec = ix as Record<string, unknown>;
    let programId: string | undefined;
    if (typeof rec.programId === 'string') programId = rec.programId;
    else if (typeof rec.programIdIndex === 'number') programId = accountsList[rec.programIdIndex];
    if (programId === undefined) return null;
    let data: Buffer;
    try {
        data =
            typeof rec.data === 'string'
                ? Buffer.from(bs58.decode(rec.data))
                : Buffer.from(rec.data as Uint8Array);
    } catch {
        return null;
    }
    if (data.length < 8) return null;
    return { programId, data };
}

/* Primary-event priority: when a transaction carries several of our
   instructions (an offer claim CPIs create_amm_position, a stake also
   moves tokens), the first name here is the row the user meant. */
const PRIORITY = [
    'offer_claim_sol',
    'offer_claim',
    'alt_offer_claim_sol',
    'alt_offer_claim',
    'stake',
    'unstake',
    'claim',
    'freeze',
    'settle_freeze',
    'create_amm_position',
];

/* Position PDAs are derivable, so instructions without an index argument
   (unstake, claim) still get their position number by matching the derived
   PDA against the transaction's account set. */
export function findPositionIndex(
    accounts: Set<string>,
    wallet: string,
    mint: string,
    stakingProgram: string,
): number | undefined {
    try {
        const program = new PublicKey(stakingProgram);
        const [pool] = PublicKey.findProgramAddressSync(
            [Buffer.from('pool'), new PublicKey(mint).toBuffer()],
            program,
        );
        const owner = new PublicKey(wallet);
        for (let i = 0; i < 80; i++) {
            const indexBytes = Buffer.alloc(8);
            indexBytes.writeBigUInt64LE(BigInt(i));
            const [position] = PublicKey.findProgramAddressSync(
                [Buffer.from('position'), pool.toBuffer(), owner.toBuffer(), indexBytes],
                program,
            );
            if (accounts.has(position.toBase58())) return i;
        }
    } catch {
        /* derivation needs valid keys — caller guarantees them, ignore */
    }
    return undefined;
}

const num = (v: unknown): number | undefined =>
    v === null || v === undefined ? undefined : Number(v.toString());

export function classifyTx(tx: TxJson, ctx: ActivityContext): ActivityEvent | null {
    const meta = tx.meta;
    if (!meta || meta.err) return null;

    const message = tx.transaction.message;
    const staticKeys = (message.accountKeys ?? message.staticAccountKeys ?? []) as unknown[];
    const accountsList = [...staticKeys.map(keyToString), ...loadedList(meta)];
    const accounts = new Set<string>(accountsList);
    const signed = accountsList[0] === ctx.wallet;

    /* AFHO delta across every token account this wallet owns (BigInt sum —
       whole-supply amounts exceed Number's safe integer range). */
    let post = 0n;
    let pre = 0n;
    const owners = new Set<string>();
    for (const tb of meta.postTokenBalances ?? []) {
        if (tb.mint !== ctx.mint) continue;
        if (tb.owner) owners.add(tb.owner);
        if (tb.owner === ctx.wallet) post += BigInt(tb.uiTokenAmount.amount);
    }
    for (const tb of meta.preTokenBalances ?? []) {
        if (tb.mint !== ctx.mint) continue;
        if (tb.owner) owners.add(tb.owner);
        if (tb.owner === ctx.wallet) pre += BigInt(tb.uiTokenAmount.amount);
    }
    const afhoDelta = post - pre;

    const p = ctx.programs;
    const protocolHit =
        accounts.has(p.staking) || accounts.has(p.amm) || accounts.has(p.crank) || accounts.has(p.coinMint);
    const swapHit = p.raydium !== undefined && accounts.has(p.raydium);

    const base = {
        signature: '',
        blockTime: tx.blockTime,
        slot: tx.slot,
        manual: false,
        afhoDelta: null as bigint | null,
        solDelta: signed ? meta.postBalances[0] - meta.preBalances[0] : null,
        signed,
    };

    if (protocolHit) {
        /* Decode every AFHO-program instruction (top level + CPIs). */
        const ixs: unknown[] = [
            ...(message.instructions ?? []),
            ...(message.compiledInstructions ?? []),
        ];
        for (const group of meta.innerInstructions ?? []) ixs.push(...group.instructions);
        const decoded: { name: string; data: Record<string, unknown> }[] = [];
        for (const ix of ixs) {
            const norm = normalizeInstruction(ix, accountsList);
            if (!norm) continue;
            let entry: { name: string; data: unknown } | null = null;
            if (norm.programId === p.staking) entry = ctx.coderStaking.decode(norm.data);
            else if (norm.programId === p.amm) entry = ctx.coderAmm.decode(norm.data);
            if (entry) decoded.push({ name: entry.name, data: (entry.data ?? {}) as Record<string, unknown> });
        }

        const primary = decoded
            .filter((d) => PRIORITY.includes(d.name))
            .sort((a, b) => PRIORITY.indexOf(a.name) - PRIORITY.indexOf(b.name))[0];

        const event: ActivityEvent = {
            ...base,
            afhoDelta,
            kind: 'protocol',
            ixName: primary ? undefined : decoded[0]?.name,
        };

        if (primary) {
            const d = primary.data;
            switch (primary.name) {
                case 'stake':
                    event.kind = 'stake';
                    event.positionIndex = num(d.index);
                    event.days = num(d.days);
                    break;
                case 'unstake':
                case 'claim':
                    event.kind = primary.name === 'claim' ? 'claim' : 'unstake';
                    event.positionIndex = findPositionIndex(accounts, ctx.wallet, ctx.mint, p.staking);
                    break;
                case 'freeze':
                    event.kind = 'freeze';
                    event.positionIndex = num(d.index);
                    event.days = num(d.days);
                    break;
                case 'settle_freeze':
                    event.kind = 'settle';
                    event.positionIndex = num(d.index);
                    break;
                case 'create_amm_position':
                    event.kind = 'position';
                    event.positionIndex = num(d.index);
                    event.days = num(d.days_to_unlock);
                    break;
                default: {
                    // offer claims (all four variants)
                    event.kind = 'bond';
                    event.tier = num(d.tier);
                    event.units = num(d.units);
                    event.sheetDay = num(d.index);
                    event.payLeg = primary.name.endsWith('_sol') ? 'sol' : 'usdc';
                    event.altDesk = primary.name.startsWith('alt_');
                    break;
                }
            }
        }
        return event;
    }

    /* No protocol accounts: only interesting if AFHO actually moved for
       this wallet — a manual transfer (either direction) or a DEX fill. */
    if (afhoDelta === 0n) return null;

    if (swapHit) {
        return { ...base, kind: 'swap', manual: true, afhoDelta };
    }

    const counterparty = [...owners].find((o) => o !== ctx.wallet);
    return {
        ...base,
        kind: afhoDelta > 0n ? 'received' : 'sent',
        manual: true,
        afhoDelta,
        counterparty,
    };
}
