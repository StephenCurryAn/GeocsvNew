import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { useAnalysisRun, type AnalysisRunController } from './useAnalysisRun';

export type AnalysisSource = 'assistant' | 'tools';
export type WorkspaceView = 'map' | 'results';

const AnalysisWorkspaceContext = createContext<{
    runs: Record<AnalysisSource, AnalysisRunController>;
    result: AnalysisRunController | null;
    view: WorkspaceView;
    changeView: (view: WorkspaceView) => void;
    openResult: (source: AnalysisSource) => void;
} | null>(null);

export function AnalysisWorkspaceProvider({ children }: { children: ReactNode }) {
    const assistant = useAnalysisRun();
    const tools = useAnalysisRun(false);
    const runs = { assistant, tools: { ...tools, historyLoading: assistant.historyLoading } };
    const [view, changeView] = useState<WorkspaceView>('map');
    const [source, setSource] = useState<AnalysisSource | null>(null);

    const openResult = useCallback((next: AnalysisSource) => {
        setSource(next);
        changeView('results');
    }, []);

    // A completed task is available from the results tab even before its first explicit open.
    const defaultResult = [assistant, tools].find(({ run }) => run?.status === 'succeeded' && run.artifactId);
    const result = (source ? runs[source] : defaultResult) ?? null;

    return (
        <AnalysisWorkspaceContext.Provider value={{ runs, view, result, changeView, openResult }}>
            {children}
        </AnalysisWorkspaceContext.Provider>
    );
}

export function useAnalysisWorkspace() {
    const workspace = useContext(AnalysisWorkspaceContext);
    if (!workspace) throw new Error('AnalysisWorkspaceProvider is missing');
    return workspace;
}
