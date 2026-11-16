import { Component, Suspense, forwardRef, lazy, type ReactNode } from 'react';
import { Button, Spin } from 'antd';
import type { AgGridReact, AgGridReactProps } from 'ag-grid-react';

const TableGrid = lazy(() => import('./TableGrid'));

class GridErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError() {
        return { failed: true };
    }

    render() {
        if (this.state.failed) {
            return (
                <div className="h-full flex flex-col items-center justify-center gap-2 text-gray-300" role="alert">
                    <span>表格加载失败</span>
                    <Button size="small" onClick={() => window.location.reload()}>
                        刷新页面
                    </Button>
                </div>
            );
        }

        return this.props.children;
    }
}

const DeferredGrid = forwardRef<AgGridReact, AgGridReactProps>(function DeferredGrid(props, ref) {
    return (
        <GridErrorBoundary>
            <Suspense fallback={
                <div className="h-full flex items-center justify-center gap-2 text-gray-300" role="status">
                    <Spin size="small" />
                    <span>正在加载表格…</span>
                </div>
            }>
                <TableGrid {...props} ref={ref} />
            </Suspense>
        </GridErrorBoundary>
    );
});

export default DeferredGrid;
