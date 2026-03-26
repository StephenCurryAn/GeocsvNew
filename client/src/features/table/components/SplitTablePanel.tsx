import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Button, Empty } from 'antd';
import { CloseOutlined, ExpandAltOutlined, MoreOutlined } from '@ant-design/icons';
import { useAnalysisStore } from '../../../stores/useAnalysisStore';

// AG Grid 相关依赖
import { AgGridReact } from 'ag-grid-react'; 
import { type ColDef, ModuleRegistry, AllCommunityModule } from 'ag-grid-community'; 
import 'ag-grid-community/styles/ag-grid.css'; 
import 'ag-grid-community/styles/ag-theme-alpine.css'; 

// 注册模块
ModuleRegistry.registerModules([ AllCommunityModule ]);

const SNAP_THRESHOLD = 50;     
const DEFAULT_BOTTOM_HEIGHT = 350; 

interface SplitTablePanelProps {
    children: React.ReactNode; 
}

const SplitTablePanel: React.FC<SplitTablePanelProps> = ({ children }) => {
    const { 
        pivotData, 
        generatedColumns, 
        pivotConfig,
        isPivotPanelOpen, 
        setPivotPanelOpen 
    } = useAnalysisStore();

    // --- 拖拽与高度控制逻辑 (保持丝滑) ---
    const [bottomHeight, setBottomHeight] = useState<number>(0);
    const dragInfoRef = useRef<{ startY: number; startHeight: number; } | null>(null);

    useEffect(() => {
        if (isPivotPanelOpen && bottomHeight === 0) {
             setBottomHeight(DEFAULT_BOTTOM_HEIGHT);
        } else if (!isPivotPanelOpen && bottomHeight > 0) {
             setBottomHeight(0);
        }
    }, [isPivotPanelOpen]);

    const handleMouseDown = (e: React.MouseEvent) => {
        e.preventDefault();
        dragInfoRef.current = { startY: e.clientY, startHeight: bottomHeight };
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    };

    const handleMouseMove = (e: MouseEvent) => {
        if (!dragInfoRef.current) return;
        const deltaY = dragInfoRef.current.startY - e.clientY; 
        const rawHeight = dragInfoRef.current.startHeight + deltaY;

        if (rawHeight < SNAP_THRESHOLD) {
            setBottomHeight(0);
            if (isPivotPanelOpen) setPivotPanelOpen(false); 
        } else {
             const maxHeight = window.innerHeight - 150; 
             setBottomHeight(Math.min(maxHeight, rawHeight));
             if (!isPivotPanelOpen) setPivotPanelOpen(true); 
        }
    };

    const handleMouseUp = () => {
        dragInfoRef.current = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
    };

    // --- AG Grid 列定义 ---
    const agColumnDefs = useMemo<ColDef[]>(() => {
        if (!pivotConfig.groupByRow || !pivotData) return [];

        const cols: ColDef[] = [];

        // (1) 左侧固定列：行分组 (如 District)
        cols.push({
            field: 'rowKey', 
            headerName: pivotConfig.groupByRow, 
            pinned: 'left', 
            width: 150,
            //    ：字体颜色改为纯白
            cellStyle: { fontWeight: 'bold', color: '#ffffff' }, 
            filter: true,
        });

        // (2) 动态数据列 (如 2020, 2021)
        generatedColumns.forEach(colKey => {
            cols.push({
                field: colKey,
                headerName: colKey,
                width: 120,
                //    ：字体颜色改为纯白，保持右对齐
                cellStyle: { textAlign: 'right', color: '#ffffff' }, 
                valueFormatter: (params) => params.value == null ? '-' : params.value
            });
        });

        if (generatedColumns.length === 1 && generatedColumns[0] === 'value') {
            cols[1].headerName = pivotConfig.valueField || '统计值';
        }

        return cols;
    }, [pivotConfig, generatedColumns, pivotData]);

    // AG Grid 默认配置
    const defaultColDef = useMemo<ColDef>(() => ({
        sortable: true,  
        resizable: true, 
        filter: true,    
        menuTabs: [],    
    }), []);

    return (
        <div className="h-full w-full flex flex-col bg-gray-900 overflow-hidden relative select-none">
            
            {/* 🔼 上半部分：原始表格 */}
            <div className="flex-1 overflow-hidden relative flex flex-col">
                 {children}
            </div>

            {/* 拖拽条 */}
            {pivotData && (
                <div 
                    className="h-2 w-full z-20 cursor-row-resize hover:bg-cyan-600/50 hover:h-2.5 transition-all flex items-center justify-center group bg-gray-800 border-t border-b border-gray-700 shrink-0"
                    onMouseDown={handleMouseDown}
                    onDoubleClick={() => {
                        if (bottomHeight === 0) {
                            setBottomHeight(DEFAULT_BOTTOM_HEIGHT);
                            setPivotPanelOpen(true);
                        } else {
                            setBottomHeight(0);
                            setPivotPanelOpen(false);
                        }
                    }}
                >
                    <div className="h-1 w-12 bg-gray-600 group-hover:bg-cyan-400 rounded-full transition-colors flex justify-center items-center">
                        <MoreOutlined className="text-[8px] text-gray-900 opacity-0 group-hover:opacity-100 rotate-90"/>
                    </div>
                </div>
            )}

            {/* 🔽 下半部分：透视结果 (AG Grid) */}
            <div 
                className="shrink-0 flex flex-col bg-gray-800 overflow-hidden"
                style={{ 
                    height: `${bottomHeight}px`,
                    transition: dragInfoRef.current ? 'none' : 'height 0.2s cubic-bezier(0.25, 0.8, 0.25, 1)' 
                }}
            >
                <div className={`w-full h-full flex flex-col ${bottomHeight < SNAP_THRESHOLD ? 'opacity-0' : 'opacity-100'} transition-opacity duration-100`}>
                     
                     {/* 标题栏 */}
                     <div className="h-10 shrink-0 bg-gray-800 border-b border-gray-700 flex justify-between items-center px-4 select-none">
                        <span className="text-cyan-400 font-bold text-sm flex items-center gap-2">
                            <ExpandAltOutlined /> 
                            透视结果 ({pivotConfig.groupByRow} 
                            {pivotConfig.groupByCol ? ` × ${pivotConfig.groupByCol}` : ''})
                        </span>
                        <Button 
                            type="text" 
                            size="small"
                            icon={<CloseOutlined className="text-gray-400 hover:text-red-400" />} 
                            onClick={() => {
                                setBottomHeight(0);
                                setPivotPanelOpen(false);
                            }} 
                        />
                     </div>

                     {/* 表格内容区 */}
                     <div className="flex-1 w-full h-full ag-theme-alpine-dark">
                        {pivotData ? (
                            <AgGridReact
                                rowData={pivotData}
                                columnDefs={agColumnDefs}
                                defaultColDef={defaultColDef}
                                animateRows={true} 
                                theme="legacy"
                                autoSizeStrategy={{ type: 'fitCellContents' }}
                                suppressCellFocus={true} // 移除单元格点击时的蓝色边框
                            />
                        ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" className="mt-10" />}
                     </div>
                </div>
            </div>

            {/* 样式注入 */}
            <style>{`
                /* 透视表专用样式 */
                .ag-theme-alpine-dark {
                    --ag-background-color: #111827; 
                    --ag-header-background-color: #1f2937; 
                    --ag-odd-row-background-color: #111827;
                    --ag-row-border-color: #374151;
                    --ag-header-foreground-color: #9ca3af;
                    /*    ：默认文字颜色改为纯白 */
                    --ag-foreground-color: #ffffff; 
                }

                .ag-header-cell-label {
                    font-weight: 600;
                }
                
                /* 去除选中行样式，因为我们禁用了选中 */
                .ag-theme-alpine-dark .ag-cell-focus {
                    border-color: transparent !important;
                }
            `}</style>
        </div>
    );
};

export default SplitTablePanel;