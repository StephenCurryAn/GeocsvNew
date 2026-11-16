import { useLayoutEffect, useState, type ReactNode } from 'react';
import { App, ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';

export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'geocsv.theme';
const SYSTEM_SCHEME = '(prefers-color-scheme: dark)';

function loadPreference(): ThemePreference {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved === 'dark' || saved === 'light' || saved === 'system') return saved;
    } catch {
        // The theme can still be changed when browser storage is unavailable.
    }
    return 'light';
}

export default function WorkbenchTheme({
    children,
}: {
    children: (preference: ThemePreference, changePreference: (next: ThemePreference) => void) => ReactNode;
}) {
    const [preference, setPreference] = useState(loadPreference);
    const [systemDark, setSystemDark] = useState(() => matchMedia(SYSTEM_SCHEME).matches);
    const dark = preference === 'dark' || (preference === 'system' && systemDark);

    useLayoutEffect(() => {
        const query = matchMedia(SYSTEM_SCHEME);
        setSystemDark(query.matches);
        const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
        query.addEventListener('change', onChange);
        return () => query.removeEventListener('change', onChange);
    }, []);

    useLayoutEffect(() => {
        document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    }, [dark]);

    const changePreference = (next: ThemePreference) => {
        setPreference(next);
        try {
            localStorage.setItem(STORAGE_KEY, next);
        } catch {
            // Keep the current session usable without storage.
        }
    };

    return (
        <ConfigProvider locale={zhCN} theme={{
            algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
            token: {
                borderRadius: 6,
                colorPrimary: dark ? '#5397ee' : '#2367b3',
                colorBgContainer: dark ? '#202731' : '#fff',
                colorBgElevated: dark ? '#262f3b' : '#fff',
                colorBorder: dark ? '#3f4b5a' : '#cdd5df',
            },
        }}>
            <App>{children(preference, changePreference)}</App>
        </ConfigProvider>
    );
}
