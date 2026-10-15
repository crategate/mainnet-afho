import { AnchorProvider, Program, web3, type Idl } from "@coral-xyz/anchor";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { useMemo } from "react";
import stakingIdl from "../../../target/idl/staking.json";
import crankIdl from "../../../target/idl/crank_oracle.json";
import ammIdl from "../../../target/idl/amm.json";

// Derive directly from the built IDL — never stale
function idlProgramId(idl: unknown): web3.PublicKey {
    const meta = idl as { metadata?: { address?: string }; address?: string };
    const address = meta.metadata?.address ?? meta.address;
    if (!address) throw new Error("IDL missing program address");
    return new web3.PublicKey(address);
}

export const STAKING_PROGRAM_ID = idlProgramId(stakingIdl);
export const CRANK_PROGRAM_ID = idlProgramId(crankIdl);
export const AMM_PROGRAM_ID = idlProgramId(ammIdl);

export function useStakingProgram() {
    const { connection } = useConnection();
    const wallet = useAnchorWallet();

    return useMemo(() => {
        if (!wallet) return null;
        const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
        // Explicitly pass the ID so there is zero chance of mismatch
        return new Program(stakingIdl as Idl, provider);
    }, [connection, wallet]);
}

export function useCrankProgram() {
    const { connection } = useConnection();
    const wallet = useAnchorWallet();

    return useMemo(() => {
        if (!wallet) return null;
        const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
        return new Program(crankIdl as Idl, provider);
    }, [connection, wallet]);
}

export function useAmmProgram() {
    const { connection } = useConnection();
    const wallet = useAnchorWallet();

    return useMemo(() => {
        if (!wallet) return null;
        const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
        return new Program(ammIdl as Idl, provider);
    }, [connection, wallet]);
}