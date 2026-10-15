import { useContext } from 'react';
import { ChainDataContext, type ChainDataContextValue } from './ChainDataContext';

export function useChainData(): ChainDataContextValue {
    const ctx = useContext(ChainDataContext);
    if (!ctx) throw new Error('useChainData must be used inside ChainDataProvider');
    return ctx;
}
