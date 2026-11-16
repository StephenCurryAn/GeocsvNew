import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Empty } from 'antd';
import { CloseOutlined, TableOutlined } from '@ant-design/icons';
import type { ColDef } from 'ag-grid-community';
import { useAnalysisStore } from '../../../stores/useAnalysisStore';
import PanelSeparator, { SEPARATOR_SIZE } from '../../../layouts/PanelSeparator';
import { usePanelSize } from '../../../layouts/usePanelSize';
import DeferredGrid from './DeferredGrid';

const MIN_PIVOT = 94;
const MIN_ATTRIBUTES = 112;

export default function SplitTablePanel({ children }: { children: ReactNode }) {
    const { pivotData, generatedColumns, pivotConfig, isPivotPanelOpen, setPivotPanelOpen } = useAnalysisStore();
    const panel = useRef<HTMLDivElement>(null);
    const { height } = usePanelSize(panel);
    const [pivotHeight, setPivotHeight] = useState<number>();
    const max = Math.max(MIN_PIVOT, height - MIN_ATTRIBUTES - SEPARATOR_SIZE);
    const bottom = Math.min(max, Math.max(MIN_PIVOT, pivotHeight ?? Math.round(height * 0.48)));

    const columnDefs = useMemo<ColDef[]>(() => {
        if (!pivotConfig.groupByRow || !pivotData) return [];
        const singleValue = generatedColumns.length === 1 && generatedColumns[0] === 'value';
        return [
            { field: 'rowKey', headerName: pivotConfig.groupByRow, pinned: 'left', width: 150, cellStyle: { fontWeight: 'bold' } },
            ...generatedColumns.map(field => ({
                field,
                headerName: singleValue ? pivotConfig.valueField || '统计值' : field,
                width: 120,
                cellStyle: { textAlign: 'right' },
                valueFormatter: (params: { value: unknown }) => String(params.value ?? '—'),
            })),
        ];
    }, [pivotConfig, generatedColumns, pivotData]);

    const defaultColDef = useMemo<ColDef>(() => ({ sortable: true, resizable: true, filter: true, menuTabs: [] }), []);

    return (
        <div className="split-table" ref={panel}>
            <div className="attribute-table">{children}</div>
            {isPivotPanelOpen ? (
                <>
                    <PanelSeparator
                        horizontal reverse label="调整透视结果高度" controls="pivot-results"
                        min={MIN_PIVOT} max={max} value={bottom} onResize={setPivotHeight}
                    />
                    <section id="pivot-results" className="pivot-results" style={{ height: bottom }} aria-label="透视结果">
                        <header className="pivot-header">
                            <span>透视结果{pivotConfig.groupByRow && ' · ' + pivotConfig.groupByRow}
                                {pivotConfig.groupByCol && ' × ' + pivotConfig.groupByCol}</span>
                            <Button
                                type="text" size="small" icon={<CloseOutlined />}
                                aria-label="关闭透视结果" onClick={() => setPivotPanelOpen(false)}
                            />
                        </header>
                        <div className="ag-theme-alpine workbench-grid data-grid">
                            {pivotData ? (
                                <DeferredGrid
                                    rowData={pivotData}
                                    columnDefs={columnDefs}
                                    defaultColDef={defaultColDef}
                                    animateRows
                                    theme="legacy"
                                    autoSizeStrategy={{ type: 'fitCellContents' }}
                                    suppressCellFocus
                                />
                            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />}
                        </div>
                    </section>
                </>
            ) : pivotData && (
                <div className="pivot-header">
                    <Button type="text" size="small" icon={<TableOutlined />} onClick={() => setPivotPanelOpen(true)}>
                        显示透视结果
                    </Button>
                </div>
            )}
        </div>
    );
}
