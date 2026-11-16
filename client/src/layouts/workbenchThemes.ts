export type ThemeMode = 'light' | 'dark' | 'system';
export type ThemeFamily = 'tenon' | 'green';
type ResolvedMode = Exclude<ThemeMode, 'system'>;

interface WorkbenchPalette {
    background: string;
    panel: string;
    inset: string;
    border: string;
    text: string;
    muted: string;
    accent: string;
    onAccent: string;
    selected: string;
    focus: string;
    focusSurface: string;
    mapSurface: string;
    mapLow: string;
    mapHigh: string;
    mapOutline: string;
}

export const workbenchThemes: Record<ThemeFamily, {
    label: string;
    radius: number;
    palettes: Record<ResolvedMode, WorkbenchPalette>;
}> = {
    tenon: {
        label: '暖白', radius: 8,
        palettes: {
            light: {
                background: '#f4f1eb', panel: '#fbf9f5', inset: '#ede8de', border: '#ded7cc',
                text: '#282a29', muted: '#605c55', accent: '#3d6683', onAccent: '#fff',
                selected: '#e2ebef', focus: '#a25336', focusSurface: '#f3e3d6',
                mapSurface: '#e8ece6', mapLow: '#d4dfe5', mapHigh: '#507d98', mapOutline: '#44677d',
            },
            dark: {
                background: '#151719', panel: '#1e2125', inset: '#292c31', border: '#393d44',
                text: '#efeeea', muted: '#b3b2af', accent: '#9ebad1', onAccent: '#18202a',
                selected: '#2a3d4d', focus: '#ebad87', focusSurface: '#43352e',
                mapSurface: '#242b31', mapLow: '#374a58', mapHigh: '#85a9c0', mapOutline: '#a0bdce',
            },
        },
    },
    green: {
        label: '苔绿', radius: 9,
        palettes: {
            light: {
                background: '#e9ece2', panel: '#f7f8f1', inset: '#e6ebdb', border: '#cfd7c1',
                text: '#253021', muted: '#53634a', accent: '#47633c', onAccent: '#fff',
                selected: '#dce9d2', focus: '#a45a24', focusSurface: '#f2e1cc',
                mapSurface: '#e5ecde', mapLow: '#d4e2c6', mapHigh: '#6c8958', mapOutline: '#506642',
            },
            dark: {
                background: '#161b15', panel: '#20271e', inset: '#2b3426', border: '#3d4b35',
                text: '#edf1e7', muted: '#b0bfa5', accent: '#b7cb9d', onAccent: '#25321f',
                selected: '#34472d', focus: '#efb872', focusSurface: '#483829',
                mapSurface: '#252e24', mapLow: '#43533c', mapHigh: '#a4bd90', mapOutline: '#adc59b',
            },
        },
    },

};

export const workbenchModes: { key: ThemeMode; label: string }[] = [
    { key: 'light', label: '浅色' }, { key: 'dark', label: '深色' }, { key: 'system', label: '跟随系统' },
];
