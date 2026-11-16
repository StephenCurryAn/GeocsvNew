import { Dropdown, Button } from 'antd';
import { BgColorsOutlined } from '@ant-design/icons';
import { useWorkbenchAppearance } from './WorkbenchTheme';
import { workbenchModes, workbenchThemes, type ThemeFamily, type ThemeMode } from './workbenchThemes';

export default function WorkbenchThemeMenu() {
    const { family, mode, dark, changeFamily, changeMode } = useWorkbenchAppearance();
    return (
        <Dropdown trigger={['click']} menu={{
            selectable: true,
            multiple: true,
            selectedKeys: [family, mode],
            items: [
                {
                    type: 'group', label: '主题风格',
                    children: (Object.keys(workbenchThemes) as ThemeFamily[]).map(key => {
                        const option = workbenchThemes[key];
                        const palette = option.palettes[dark ? 'dark' : 'light'];
                        return {
                            key, label: <span className="theme-option">
                                <span className="theme-preview" aria-hidden="true" style={{ background: palette.panel, borderColor: palette.border }}>
                                    <span style={{ background: palette.accent }} />
                                </span>
                                {option.label}
                            </span>,
                        };
                    }),
                },
                { type: 'divider' },
                { type: 'group', label: '明暗模式', children: workbenchModes },
            ],
            onClick: ({ key }) => {
                if (Object.hasOwn(workbenchThemes, key)) changeFamily(key as ThemeFamily);
                else changeMode(key as ThemeMode);
            },
        }}>
            <Button type="text" size="small" icon={<BgColorsOutlined />} aria-label="界面主题" title={'界面主题 · ' + workbenchThemes[family].label} />
        </Dropdown>
    );
}
