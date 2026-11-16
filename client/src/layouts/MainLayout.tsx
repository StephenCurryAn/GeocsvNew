import { useRef, useState, type ReactNode } from 'react';
import {
    ChartNoAxesColumnIncreasing, Map as MapIcon, MessageCircle, PanelLeftClose, PanelLeftOpen,
    PanelRightClose, PanelRightOpen, PanelsTopLeft,
} from 'lucide-react';
import PanelSeparator, { SEPARATOR_SIZE } from './PanelSeparator';
import WorkbenchThemeMenu from './WorkbenchThemeMenu';
import { useAnalysisWorkspace, type WorkspaceView } from '../features/analysis/components/AnalysisWorkspace';
import AnalysisResultView from '../features/analysis/components/AnalysisResultView';
import { usePanelSize } from './usePanelSize';

const RAIL_WIDTH = 44;
const MIN_WORKSPACE = 196;
const MIN_ASSISTANT = 252;
const MIN_CENTER = 288;
const MIN_MAP = 240;
const MIN_TABLE = 218;
const FULL_WIDTH = MIN_WORKSPACE + MIN_ASSISTANT + MIN_CENTER + 2 * SEPARATOR_SIZE;
const VIEW_BAR_HEIGHT = 44;
const MIN_HEIGHT = MIN_MAP + MIN_TABLE + SEPARATOR_SIZE + VIEW_BAR_HEIGHT;
const views = [
    { key: 'map', title: '工作地图', icon: MapIcon },
    { key: 'results', title: '分析结果', icon: ChartNoAxesColumnIncreasing },
] as const;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
type Side = 'workspace' | 'assistant';
type SidebarSize = { collapsed: boolean; width?: number };

interface MainLayoutProps {
    workspace: ReactNode;
    map: ReactNode;
    table: ReactNode;
    assistant: ReactNode;
}

export default function MainLayout({ workspace, map, table, assistant }: MainLayoutProps) {
    const { view, result, changeView } = useAnalysisWorkspace();
    const tabs = useRef<Record<WorkspaceView, HTMLButtonElement | null>>({ map: null, results: null });
    const workbenchRef = useRef<HTMLDivElement>(null);
    const size = usePanelSize(workbenchRef);
    const [workspaceSize, setWorkspaceSize] = useState<SidebarSize>({ collapsed: false });
    const [assistantSize, setAssistantSize] = useState<SidebarSize>({ collapsed: false });
    const [preferredSide, setPreferredSide] = useState<Side>('workspace');
    const [resizingSide, setResizingSide] = useState(false);
    const [tableHeight, setTableHeight] = useState<number>();

    const narrow = size.width > 0 && size.width < FULL_WIDTH;
    const leftCollapsed = workspaceSize.collapsed || (narrow && !assistantSize.collapsed && preferredSide === 'assistant');
    const rightCollapsed = assistantSize.collapsed || (narrow && !workspaceSize.collapsed && preferredSide === 'workspace');
    const leftMin = leftCollapsed ? RAIL_WIDTH : MIN_WORKSPACE;
    const rightMin = rightCollapsed ? RAIL_WIDTH : MIN_ASSISTANT;
    const minWidth = leftMin + rightMin + MIN_CENTER + 2 * SEPARATOR_SIZE;
    const width = Math.max(minWidth, size.width || FULL_WIDTH);
    const height = Math.max(MIN_HEIGHT, size.height);
    const sidesAvailable = width - MIN_CENTER - 2 * SEPARATOR_SIZE;
    const leftRequested = workspaceSize.width ?? clamp(Math.round(width * 0.18), MIN_WORKSPACE, 264);
    const rightRequested = assistantSize.width ?? clamp(Math.round(width * 0.24), MIN_ASSISTANT, 368);
    const right = rightCollapsed ? RAIL_WIDTH : clamp(rightRequested, rightMin, Math.min(560, sidesAvailable - leftMin));
    const left = leftCollapsed ? RAIL_WIDTH : clamp(leftRequested, leftMin, Math.min(480, sidesAvailable - right));
    const leftDragMax = Math.min(480, sidesAvailable - (leftCollapsed ? (narrow ? RAIL_WIDTH : rightMin) : right));
    const rightDragMax = Math.min(560, sidesAvailable - (rightCollapsed ? (narrow ? RAIL_WIDTH : leftMin) : left));
    const tableMax = height - VIEW_BAR_HEIGHT - MIN_MAP - SEPARATOR_SIZE;
    const bottom = clamp(tableHeight ?? Math.round(height * 0.36), MIN_TABLE, tableMax);

    const toggleSide = (side: Side, collapsed: boolean) => {
        if (collapsed) setPreferredSide(side);
        const update = side === 'workspace' ? setWorkspaceSize : setAssistantSize;
        update(previous => ({ ...previous, collapsed: !collapsed }));
    };

    const resizeSide = (side: Side, value: number, start: number, fromPointer: boolean) => {
        const minimum = side === 'workspace' ? MIN_WORKSPACE : MIN_ASSISTANT;
        const fromRail = start === RAIL_WIDTH;
        // Drag past the compact layout to snap shut. A short pull on the rail opens it.
        const snapAt = fromRail ? RAIL_WIDTH + (fromPointer ? 44 : 0) : minimum - (fromPointer ? 28 : 1);
        const collapsed = value <= snapAt;
        if (!collapsed) setPreferredSide(side);
        const update = side === 'workspace' ? setWorkspaceSize : setAssistantSize;
        update(previous => {
            // Reopen at the width before the closing gesture, including a keyboard Home press.
            const nextWidth = collapsed
                ? (fromRail ? previous.width : start)
                : (fromRail && !fromPointer && value < minimum ? previous.width : Math.max(minimum, value));
            return previous.collapsed === collapsed && previous.width === nextWidth ? previous : { collapsed, width: nextWidth };
        });
    };

    return (
        <div className="workbench-scroll" ref={workbenchRef}>
            <div
                className="workbench"
                data-resizing={resizingSide || undefined}
                style={{
                    minWidth,
                    minHeight: MIN_HEIGHT,
                    gridTemplateColumns: left + 'px ' + SEPARATOR_SIZE + 'px minmax(0, 1fr) ' + SEPARATOR_SIZE + 'px ' + right + 'px',
                }}
            >
                <aside className="workbench-workspace" aria-label="工作空间" data-collapsed={leftCollapsed || undefined}>
                    <header className="workbench-heading workbench-sidebar-heading">
                        <h1 hidden={leftCollapsed}><span className="workbench-mark" aria-hidden="true"><PanelsTopLeft size={15} /></span>工作空间</h1>
                        <div className="workbench-heading-actions">
                            <div hidden={leftCollapsed}><WorkbenchThemeMenu /></div>
                            <button type="button" className="workbench-sidebar-toggle"
                                aria-label={leftCollapsed ? '展开工作空间' : '收起工作空间'}
                                title={leftCollapsed ? '展开工作空间' : '收起工作空间'}
                                aria-controls="workbench-workspace" aria-expanded={!leftCollapsed}
                                onClick={() => toggleSide('workspace', leftCollapsed)}>
                                {leftCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
                            </button>
                        </div>
                    </header>
                    {leftCollapsed && <span className="workbench-rail-label" aria-hidden="true">工作空间</span>}
                    <div id="workbench-workspace" className="workbench-sidebar-body workbench-workspace-content"
                        hidden={leftCollapsed}>{workspace}</div>
                </aside>

                <PanelSeparator
                    label="调整工作空间宽度" controls="workbench-workspace"
                    value={left} min={RAIL_WIDTH} max={leftDragMax} collapsed={leftCollapsed}
                    onResize={(value, start, fromPointer) => resizeSide('workspace', value, start, fromPointer)}
                    onDraggingChange={setResizingSide}
                />

                <main className="workbench-center">
                    <div className="workbench-view-bar" role="tablist" aria-label="中央视图">
                        {views.map(({ key, title, icon: Icon }) => (
                            <button
                                key={key} id={'workbench-tab-' + key} type="button" role="tab"
                                ref={element => { tabs.current[key] = element; }}
                                aria-selected={view === key} aria-controls={'workbench-view-' + key}
                                tabIndex={view === key ? 0 : -1}
                                onClick={() => changeView(key)}
                                onKeyDown={event => {
                                    let next: WorkspaceView;
                                    if (event.key === 'Home') next = 'map';
                                    else if (event.key === 'End') next = 'results';
                                    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') next = key === 'map' ? 'results' : 'map';
                                    else return;
                                    event.preventDefault();
                                    changeView(next);
                                    tabs.current[next]?.focus();
                                }}
                            >
                                <Icon size={15} aria-hidden="true" />{title}
                                {key === 'results' && result?.run?.artifactId && <span className="workbench-result-dot" aria-hidden="true" />}
                            </button>
                        ))}
                    </div>
                    <div className="workbench-view-stack">
                        <div id="workbench-view-map" className="workbench-map-layout" role="tabpanel" aria-labelledby="workbench-tab-map"
                            aria-hidden={view !== 'map'}
                            ref={element => { if (element) element.inert = view !== 'map'; }}
                            style={{ gridTemplateRows: 'minmax(0, 1fr) ' + SEPARATOR_SIZE + 'px ' + bottom + 'px' }}>
                            <section className="workbench-map" aria-label="地图">{map}</section>
                            <PanelSeparator
                                horizontal reverse label="调整属性表高度" controls="workbench-table"
                                value={bottom} min={MIN_TABLE} max={tableMax} onResize={value => setTableHeight(value)}
                            />
                            <section id="workbench-table" className="workbench-table" aria-label="属性表">{table}</section>
                        </div>
                        <section id="workbench-view-results" className="workbench-results" role="tabpanel" aria-labelledby="workbench-tab-results"
                            aria-hidden={view !== 'results'}
                            ref={element => { if (element) element.inert = view !== 'results'; }}
                            tabIndex={view === 'results' ? 0 : -1}>
                            <AnalysisResultView analysis={result} />
                        </section>
                    </div>
                </main>

                <PanelSeparator
                    reverse label="调整助手宽度" controls="workbench-assistant"
                    value={right} min={RAIL_WIDTH} max={rightDragMax} collapsed={rightCollapsed}
                    onResize={(value, start, fromPointer) => resizeSide('assistant', value, start, fromPointer)}
                    onDraggingChange={setResizingSide}
                />

                <aside className="workbench-assistant" aria-label="空间分析助手" data-collapsed={rightCollapsed || undefined}>
                    <header className="workbench-heading workbench-sidebar-heading">
                        <h2 hidden={rightCollapsed}><span className="workbench-mark" aria-hidden="true"><MessageCircle size={15} /></span>空间分析助手</h2>
                        <button type="button" className="workbench-sidebar-toggle"
                            aria-label={rightCollapsed ? '展开空间分析助手' : '收起空间分析助手'}
                            title={rightCollapsed ? '展开空间分析助手' : '收起空间分析助手'}
                            aria-controls="workbench-assistant" aria-expanded={!rightCollapsed}
                            onClick={() => toggleSide('assistant', rightCollapsed)}>
                            {rightCollapsed ? <PanelRightOpen size={17} /> : <PanelRightClose size={17} />}
                        </button>
                    </header>
                    {rightCollapsed && <span className="workbench-rail-label" aria-hidden="true">分析助手</span>}
                    <div id="workbench-assistant" className="workbench-sidebar-body" hidden={rightCollapsed}>{assistant}</div>
                </aside>
            </div>
        </div>
    );
}
