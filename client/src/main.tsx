import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import WorkbenchTheme from './layouts/WorkbenchTheme';

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <WorkbenchTheme>
            {(themePreference, changeTheme) => <App themePreference={themePreference} onThemeChange={changeTheme} />}
        </WorkbenchTheme>
    </StrictMode>,
);
