import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import WorkbenchTheme from './layouts/WorkbenchTheme';
import { AnalysisWorkspaceProvider } from './features/analysis/components/AnalysisWorkspace';

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <WorkbenchTheme>
            <AnalysisWorkspaceProvider><App /></AnalysisWorkspaceProvider>
        </WorkbenchTheme>
    </StrictMode>,
);
