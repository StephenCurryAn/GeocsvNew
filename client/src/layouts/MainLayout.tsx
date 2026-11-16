import { useRef, useState, type ReactNode } from 'react';
import { Button, Dropdown } from 'antd';
import { BgColorsOutlined } from '@ant-design/icons';
import PanelSeparator, { SEPARATOR_SIZE } from './PanelSeparator';
import type { ThemePreference } from './WorkbenchTheme';
import { usePanelSize } from './usePanelSize';

const MIN_WORKSPACE = 178;
const MIN_ASSISTANT = 264;
const MIN_CENTER = 300;
const MIN_MAP = 240;
const MIN_TABLE = 218;
const MIN_WIDTH = MIN_WORKSPACE + MIN_ASSISTANT + MIN_CENTER + 2 * SEPARATOR_SIZE;
const MIN_HEIGHT = MIN_MAP + MIN_TABLE + SEPARATOR_SIZE;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

interface MainLayoutProps {
    workspace: ReactNode;
    map: ReactNode;
    table: ReactNode;
    assistant: ReactNode;
    themePreference: ThemePreference;
    onThemeChange: (preference: ThemePreference) => void;
}

export default function MainLayout({ workspace, map, table, assistant, themePreference, onThemeChange }: MainLayoutProps) {
    const workbenchRef = useRef<HTMLDivElement>(null);
    const size = usePanelSize(workbenchRef);
    const [workspaceWidth, setWorkspaceWidth] = useState<number>();
    const [assistantWidth, setAssistantWidth] = useState<number>();
    const [tableHeight, setTableHeight] = useState<number>();

    const width = Math.max(MIN_WIDTH, size.width);
    const height = Math.max(MIN_HEIGHT, size.height);
    const sidesAvailable = width - MIN_CENTER - 2 * SEPARATOR_SIZE;
    const leftRequested = workspaceWidth ?? clamp(Math.round(width * 0.18), MIN_WORKSPACE, 264);
    const rightRequested = assistantWidth ?? clamp(Math.round(width * 0.24), MIN_ASSISTANT, 368);
    const right = clamp(rightRequested, MIN_ASSISTANT, Math.min(560, sidesAvailable - MIN_WORKSPACE));
    const left = clamp(leftRequested, MIN_WORKSPACE, Math.min(480, sidesAvailable - right));
    const tableMax = height - MIN_MAP - SEPARATOR_SIZE;
    const bottom = clamp(tableHeight ?? Math.round(height * 0.36), MIN_TABLE, tableMax);

    return (
        <div className="workbench-scroll" ref={workbenchRef}>
            <div
                className="workbench"
                style={{
                    minWidth: MIN_WIDTH,
                    minHeight: MIN_HEIGHT,
                    gridTemplateColumns: left + 'px ' + SEPARATOR_SIZE + 'px minmax(0, 1fr) ' + SEPARATOR_SIZE + 'px ' + right + 'px',
                }}
            >
                <aside id="workbench-workspace" className="workbench-workspace" aria-labelledby="workspace-heading">
                    <header className="workbench-heading">
                        <h1 id="workspace-heading">工作空间</h1>
                        <Dropdown
                            trigger={['click']}
                            menu={{
                                selectable: true,
                                selectedKeys: [themePreference],
                                items: [
                                    { key: 'light', label: '浅色' },
                                    { key: 'dark', label: '深色' },
                                    { key: 'system', label: '跟随系统' },
                                ],
                                onClick: ({ key }) => onThemeChange(key as ThemePreference),
                            }}
                        >
                            <Button type="text" size="small" icon={<BgColorsOutlined />} aria-label="界面主题" title="界面主题" />
                        </Dropdown>
                    </header>
                    <div className="workbench-workspace-content">{workspace}</div>
                </aside>

                <PanelSeparator
                    label="调整工作空间宽度" controls="workbench-workspace"
                    value={left} min={MIN_WORKSPACE} max={Math.min(480, sidesAvailable - right)}
                    onResize={setWorkspaceWidth}
                />

                <main className="workbench-center" style={{ gridTemplateRows: 'minmax(0, 1fr) ' + SEPARATOR_SIZE + 'px ' + bottom + 'px' }}>
                    <section className="workbench-map" aria-label="地图">{map}</section>
                    <PanelSeparator
                        horizontal reverse label="调整属性表高度" controls="workbench-table"
                        value={bottom} min={MIN_TABLE} max={tableMax} onResize={setTableHeight}
                    />
                    <section id="workbench-table" className="workbench-table" aria-label="属性表">{table}</section>
                </main>

                <PanelSeparator
                    reverse label="调整助手宽度" controls="workbench-assistant"
                    value={right} min={MIN_ASSISTANT} max={Math.min(560, sidesAvailable - left)}
                    onResize={setAssistantWidth}
                />

                <aside id="workbench-assistant" className="workbench-assistant" aria-labelledby="agent-heading">
                    {assistant}
                </aside>
            </div>
        </div>
    );
}
