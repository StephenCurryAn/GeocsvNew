import { useRef, useState, type ReactNode } from 'react';
import { ChartNoAxesColumnIncreasing, Map as MapIcon, PanelsTopLeft } from 'lucide-react';
import PanelSeparator, { SEPARATOR_SIZE } from './PanelSeparator';
import WorkbenchThemeMenu from './WorkbenchThemeMenu';
import { useAnalysisWorkspace, type WorkspaceView } from '../features/analysis/components/AnalysisWorkspace';
import AnalysisResultView from '../features/analysis/components/AnalysisResultView';
import { usePanelSize } from './usePanelSize';

const MIN_WORKSPACE = 178;
const MIN_ASSISTANT = 264;
const MIN_CENTER = 300;
const MIN_MAP = 240;
const MIN_TABLE = 218;
const MIN_WIDTH = MIN_WORKSPACE + MIN_ASSISTANT + MIN_CENTER + 2 * SEPARATOR_SIZE;
const VIEW_BAR_HEIGHT = 44;
const MIN_HEIGHT = MIN_MAP + MIN_TABLE + SEPARATOR_SIZE + VIEW_BAR_HEIGHT;
const views = [
    { key: 'map', title: '工作地图', icon: MapIcon },
    { key: 'results', title: '分析结果', icon: ChartNoAxesColumnIncreasing },
] as const;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

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
    const tableMax = height - VIEW_BAR_HEIGHT - MIN_MAP - SEPARATOR_SIZE;
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
                        <h1 id="workspace-heading"><span className="workbench-mark" aria-hidden="true"><PanelsTopLeft size={15} /></span>工作空间</h1>
                        <WorkbenchThemeMenu />
                    </header>
                    <div className="workbench-workspace-content">{workspace}</div>
                </aside>

                <PanelSeparator
                    label="调整工作空间宽度" controls="workbench-workspace"
                    value={left} min={MIN_WORKSPACE} max={Math.min(480, sidesAvailable - right)}
                    onResize={setWorkspaceWidth}
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
                                value={bottom} min={MIN_TABLE} max={tableMax} onResize={setTableHeight}
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
