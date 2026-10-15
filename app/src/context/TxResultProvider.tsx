import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { TxResultModal, type TxReport } from '../components/TxResultModal';

/* App-wide transaction-result reporter: any signed flow calls
   reportTx() instead of alert() and one branded modal answers. Must
   mount inside ChainDataProvider (the modal reads the cluster for
   explorer links). */
const TxResultContext = createContext<((report: TxReport) => void) | null>(null);

export function useTxResult() {
    const ctx = useContext(TxResultContext);
    if (!ctx) throw new Error('useTxResult must be used inside TxResultProvider');
    return ctx;
}

export function TxResultProvider({ children }: { children: ReactNode }) {
    const [report, setReport] = useState<TxReport | null>(null);
    const reportTx = useCallback((next: TxReport) => setReport(next), []);

    return (
        <TxResultContext.Provider value={reportTx}>
            {children}
            {report && <TxResultModal report={report} onClose={() => setReport(null)} />}
        </TxResultContext.Provider>
    );
}
