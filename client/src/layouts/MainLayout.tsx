import React, { useState, useRef, useEffect } from 'react';
import { Button, Tooltip } from 'antd';
import { RobotOutlined } from '@ant-design/icons';

const MIN_SIDEBAR_WIDTH = 150;
const MIN_TABLE_WIDTH = 200;
const SNAP_THRESHOLD = 80;

interface MainLayoutProps {
    children?: React.ReactNode;
    selectedFileIds?: string[];
    aiPanelOpen?: boolean;
    onToggleAI?: () => void;
}

const MainLayout: React.FC<MainLayoutProps> = ({
    children,
    selectedFileIds = [],
    aiPanelOpen = false,
    onToggleAI,
}) => {
    const [sidebarWidth, setSidebarWidth] = useState<number>(260);
    const [tableWidth, setTableWidth] = useState<number>(500);
    const dragInfoRef = useRef<{
        type: 'sidebar' | 'table';
        startX: number;
        startWidth: number;
    } | null>(null);

    const handleMouseDown = (type: 'sidebar' | 'table', e: React.MouseEvent) => {
        e.preventDefault();
        dragInfoRef.current = { type, startX: e.clientX, startWidth: type === 'sidebar' ? sidebarWidth : tableWidth };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    };

    const handleMouseMove = (e: MouseEvent) => {
        if (!dragInfoRef.current) return;
        const { type, startX, startWidth } = dragInfoRef.current;
        const rawWidth = startWidth + (e.clientX - startX);
        if (type === 'sidebar') {
            setSidebarWidth(rawWidth < SNAP_THRESHOLD ? 0 : Math.max(MIN_SIDEBAR_WIDTH, Math.min(500, rawWidth)));
        } else {
            setTableWidth(rawWidth < SNAP_THRESHOLD ? 0 : Math.max(MIN_TABLE_WIDTH, Math.min(window.innerWidth - sidebarWidth - 200, rawWidth)));
        }
    };

    const handleMouseUp = () => {
        dragInfoRef.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
    };

    useEffect(() => {
        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, []);

    const childrenArray = React.Children.toArray(children);

    return (
        <div className="w-screen h-screen overflow-hidden flex flex-row bg-geo-dark select-none">

            {/* === 左侧面板 === */}
            <div
                className="shrink-0 flex flex-col bg-geo-panel"
                style={{
                    width: `${sidebarWidth}px`,
                    borderRight: sidebarWidth === 0 ? 'none' : '1px solid #334155',
                    transition: dragInfoRef.current ? 'none' : 'width 0.1s ease-out',
                }}
            >
                <div className={`w-full h-full flex flex-col ${sidebarWidth < MIN_SIDEBAR_WIDTH ? 'opacity-0' : 'opacity-100'} transition-opacity duration-100`}>
                    <div className="h-11 flex items-center px-4 border-b border-geo-border shrink-0">
                        <span className="text-xs font-semibold text-geo-text-secondary tracking-widest uppercase">工作空间</span>
                    </div>
                    <div className="flex-1 overflow-auto">
                        {childrenArray[0]}
                    </div>
                </div>
            </div>

            {/* 拖拽条 1 */}
            <div
                className="w-1 shrink-0 cursor-col-resize hover:bg-geo-accent/60 transition-colors duration-150 z-10"
                style={{ background: '#1e293b' }}
                onMouseDown={(e) => handleMouseDown('sidebar', e)}
                onDoubleClick={() => setSidebarWidth(prev => prev === 0 ? 260 : 0)}
            />

            {/* === 中间表格面板 === */}
            <div
                className="shrink-0 flex flex-col bg-geo-dark"
                style={{
                    width: `${tableWidth}px`,
                    transition: dragInfoRef.current ? 'none' : 'width 0.1s ease-out',
                }}
            >
                <div className={`w-full h-full flex flex-col ${tableWidth < MIN_TABLE_WIDTH ? 'opacity-0' : 'opacity-100'} transition-opacity duration-100`}>
                    <div className="h-11 flex items-center px-4 border-b border-geo-border shrink-0">
                        <span className="text-xs font-semibold text-geo-text-secondary tracking-widest uppercase">属性数据</span>
                    </div>
                    <div className="flex-1 overflow-hidden">
                        {childrenArray[1]}
                    </div>
                </div>
            </div>

            {/* 拖拽条 2 */}
            <div
                className="w-1 shrink-0 cursor-col-resize hover:bg-geo-accent/60 transition-colors duration-150 z-10"
                style={{ background: '#1e293b' }}
                onMouseDown={(e) => handleMouseDown('table', e)}
                onDoubleClick={() => setTableWidth(prev => prev === 0 ? 500 : 0)}
            />

            {/* === 右侧地图 + AI 侧边栏 wrapper === */}
            <div className="flex-1 flex flex-row min-w-0 relative overflow-hidden">

                {/* 地图区 */}
                <div className="flex-1 flex flex-col min-w-0 relative">
                    {/* 地图顶栏：标题 + AI 按钮 */}
                    <div className="h-11 flex items-center justify-between px-4 border-b border-geo-border shrink-0 bg-geo-panel/80 backdrop-blur-sm">
                        <span className="text-xs font-semibold text-geo-text-secondary tracking-widest uppercase">地图可视化</span>
                        <div className="flex items-center gap-2">
                            {selectedFileIds.length > 0 && (
                                <span className="text-[10px] bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded-full border border-blue-500/30">
                                    {selectedFileIds.length} 个图层已选
                                </span>
                            )}
                            <Tooltip title={aiPanelOpen ? '收起 AI 助手' : '展开 AI 助手'} placement="bottomRight">
                                <Button
                                    type={aiPanelOpen ? 'primary' : 'default'}
                                    size="small"
                                    icon={<RobotOutlined />}
                                    onClick={onToggleAI}
                                    className={`text-xs transition-all ${
                                        aiPanelOpen
                                            ? 'bg-blue-600 border-blue-500 text-white shadow-[0_0_12px_rgba(59,130,246,0.5)]'
                                            : 'bg-geo-panel/60 border-geo-border text-geo-text-secondary hover:border-blue-500 hover:text-blue-400'
                                    }`}
                                >
                                    GeoAI
                                </Button>
                            </Tooltip>
                        </div>
                    </div>
                    {/* 地图容器 */}
                    <div className="flex-1 overflow-hidden relative">
                        {childrenArray[2]}
                    </div>
                </div>

                {/* AI 侧边栏：可折叠，宽度 380px */}
                <div
                    className="shrink-0 flex flex-col border-l border-geo-border bg-geo-panel/95 backdrop-blur-md overflow-hidden"
                    style={{
                        width: aiPanelOpen ? '380px' : '0px',
                        transition: 'width 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                    }}
                >
                    <div className="w-[380px] h-full flex flex-col">
                        {/* AI 面板内容由第 4 个 child（GeoAIAgent）提供 */}
                        {childrenArray[3]}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default MainLayout;