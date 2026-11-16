import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';
import { App, ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { workbenchModes, workbenchThemes, type ThemeFamily, type ThemeMode } from './workbenchThemes';

const FAMILY_KEY = 'geocsv.themeFamily';
const MODE_KEY = 'geocsv.theme';
const SYSTEM_SCHEME = '(prefers-color-scheme: dark)';

function readSetting(key: string) {
    try { return localStorage.getItem(key); } catch { return null; }
}

function saveSetting(key: string, value: string) {
    try { localStorage.setItem(key, value); } catch { /* Apply the preference for this session. */ }
}

const useAppearance = () => {
    const [family, setFamily] = useState<ThemeFamily>(() => {
        const saved = readSetting(FAMILY_KEY);
        return saved && Object.hasOwn(workbenchThemes, saved) ? saved as ThemeFamily : 'tenon';
    });
    const [mode, setMode] = useState<ThemeMode>(() => workbenchModes.find(option => option.key === readSetting(MODE_KEY))?.key ?? 'light');
    const [systemDark, setSystemDark] = useState(() => matchMedia(SYSTEM_SCHEME).matches);
    const dark = mode === 'dark' || (mode === 'system' && systemDark);
    const definition = workbenchThemes[family];
    const palette = definition.palettes[dark ? 'dark' : 'light'];

    useLayoutEffect(() => {
        const query = matchMedia(SYSTEM_SCHEME);
        setSystemDark(query.matches);
        const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
        query.addEventListener('change', onChange);
        return () => query.removeEventListener('change', onChange);
    }, []);

    useLayoutEffect(() => {
        const root = document.documentElement;
        root.dataset.theme = dark ? 'dark' : 'light';
        root.dataset.themeFamily = family;
        const vars = {
            bg: palette.background, panel: palette.panel, inset: palette.inset, border: palette.border,
            text: palette.text, muted: palette.muted, accent: palette.accent, 'on-accent': palette.onAccent, selected: palette.selected,
            focus: palette.focus, 'focus-surface': palette.focusSurface, radius: definition.radius + 'px',
        };
        for (const [name, value] of Object.entries(vars)) root.style.setProperty('--workbench-' + name, value);
    }, [dark, family, palette, definition.radius]);

    return {
        family, mode, dark, palette,
        changeFamily(next: ThemeFamily) { setFamily(next); saveSetting(FAMILY_KEY, next); },
        changeMode(next: ThemeMode) { setMode(next); saveSetting(MODE_KEY, next); },
    };
};

const AppearanceContext = createContext<ReturnType<typeof useAppearance> | null>(null);

export function useWorkbenchAppearance() {
    const appearance = useContext(AppearanceContext);
    if (!appearance) throw new Error('WorkbenchTheme is missing');
    return appearance;
}

export default function WorkbenchTheme({ children }: { children: ReactNode }) {
    const appearance = useAppearance();
    const { palette, family, dark } = appearance;

    return (
        <AppearanceContext.Provider value={appearance}>
            <ConfigProvider locale={zhCN} theme={{
                algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
                token: {
                    borderRadius: workbenchThemes[family].radius,
                    colorPrimary: palette.accent,
                    colorTextLightSolid: palette.onAccent,
                    colorText: palette.text,
                    colorTextSecondary: palette.muted,
                    colorBgContainer: palette.panel,
                    colorBgElevated: palette.panel,
                    colorBgLayout: palette.background,
                    colorBorder: palette.border,
                    colorBorderSecondary: palette.border,
                    colorFillSecondary: palette.inset,
                    colorFillTertiary: palette.inset,
                    colorFillQuaternary: palette.background,
                    controlItemBgActive: palette.selected,
                    controlItemBgHover: palette.inset,
                    fontFamily: 'Inter, Segoe UI, Microsoft YaHei, sans-serif',
                },
                components: {
                    Segmented: { trackBg: palette.inset, itemSelectedBg: palette.panel, itemSelectedColor: palette.text },
                    Button: { primaryShadow: 'none' },
                },
            }}>
                <App>{children}</App>
            </ConfigProvider>
        </AppearanceContext.Provider>
    );
}
