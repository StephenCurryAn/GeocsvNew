import { Alert, Button, Empty, Modal, Space, Spin, Tag } from 'antd';
import { CheckCircleOutlined, ClockCircleOutlined, DownloadOutlined, HistoryOutlined, LoadingOutlined, StopOutlined } from '@ant-design/icons';
import SpatialPivotResult from './SpatialPivotResult';
import type { AnalysisRunController, ResultChartType } from './useAnalysisRun';
import './spatial-results.css';

const statusLabel = { queued: '排队中', running: '计算中', succeeded: '已完成', failed: '失败', cancelled: '已取消' } as const;
const formatRunTime = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

interface AnalysisRunViewProps {
  analysis: AnalysisRunController;
  chartType?: ResultChartType;
  onChartTypeChange?: (type: ResultChartType) => void;
}

const AnalysisRunView = ({ analysis, chartType, onChartTypeChange }: AnalysisRunViewProps) => (
  <>
    {analysis.requestError && <Alert className="mb-2" type="error" showIcon title={analysis.requestError} closable onClose={() => analysis.setRequestError(null)} />}
    {analysis.run && (
      <div className="rounded-md border border-slate-700 bg-slate-900/60 p-3">
        <div className="flex items-center justify-between gap-2">
          <Space size={6}>
            {analysis.activeRun ? <LoadingOutlined className="text-cyan-400" /> : analysis.run.status === 'succeeded' ? <CheckCircleOutlined className="text-emerald-400" /> : <ClockCircleOutlined className="text-slate-400" />}
            <span className="text-xs text-slate-200">任务 {statusLabel[analysis.run.status]}</span>
          </Space>
          {analysis.activeRun && <Button size="small" danger icon={<StopOutlined />} loading={analysis.cancelling} onClick={() => void analysis.cancel()}>取消</Button>}
          {analysis.run.status === 'succeeded' && analysis.run.artifactId && (
            <Button size="small" onClick={() => {
              analysis.setResultOpen(true);
              if (analysis.artifact?.id !== analysis.run?.artifactId) analysis.retryArtifact();
            }}>查看结果</Button>
          )}
        </div>
        {analysis.run.error && <div className="mt-2 text-xs text-red-300">{analysis.run.error}</div>}
      </div>
    )}

    <div className="border-t border-slate-800 pt-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-300"><HistoryOutlined />最近 20 次运行</div>
      {analysis.historyLoading ? <Spin size="small" /> : analysis.runHistory.length === 0 ? <div className="text-xs text-slate-500">暂无历史运行</div> : (
        <div className="max-h-44 space-y-1 overflow-y-auto">
          {analysis.runHistory.map(historyRun => (
            <button key={historyRun.id} type="button" onClick={() => analysis.restoreRun(historyRun)} className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left hover:bg-slate-800">
              <span className="truncate text-xs text-slate-300">{formatRunTime(historyRun.createdAt)}</span>
              <Tag color={historyRun.status === 'succeeded' ? 'green' : historyRun.status === 'failed' ? 'red' : 'default'}>{statusLabel[historyRun.status]}</Tag>
            </button>
          ))}
        </div>
      )}
    </div>

    <Modal
      title="空间透视结果"
      open={analysis.resultOpen}
      onCancel={() => analysis.setResultOpen(false)}
      centered
      destroyOnHidden
      className="spatial-result-dialog"
      width="min(1280px, calc(100vw - 32px))"
      footer={null}
      styles={{
        container: { padding: 0, borderRadius: 14, overflow: 'hidden', background: 'var(--result-surface)' },
        header: { margin: 0, background: 'var(--result-surface)' },
        body: { maxHeight: 'calc(100dvh - 116px)', overflow: 'auto' },
        mask: { backdropFilter: 'none', backgroundColor: 'rgb(23 28 36 / 54%)' },
      }}
    >
      {analysis.artifact && (
        <Button className="spatial-result-export" icon={<DownloadOutlined />} loading={analysis.csvDownloading}
          onClick={() => void analysis.exportCsv()}>
          导出 CSV
        </Button>
      )}
      {analysis.resultError && <Alert className="spatial-result-error" type="error" showIcon title={analysis.resultError} closable onClose={() => analysis.setResultError(null)} />}
      {analysis.artifact ? (
        <SpatialPivotResult
          artifact={analysis.artifact}
          rows={analysis.rows}
          page={analysis.tablePage}
          pageSize={analysis.tablePageSize}
          rowsLoading={analysis.rowsLoading}
          rowsError={analysis.rowsError}
          onPageChange={analysis.changePage}
          geoJSON={analysis.geoJSON}
          mapMessage={analysis.mapMessage}
          selectedFeatureId={analysis.selectedFeatureId}
          onSelectFeature={analysis.setSelectedFeatureId}
          chartType={chartType ?? analysis.chartType}
          onChartTypeChange={onChartTypeChange ?? analysis.setChartType}
        />
      ) : analysis.artifactError ? (
        <div className="spatial-result-dialog-state space-y-3">
          <Alert type="error" showIcon title={`结果加载失败：${analysis.artifactError}`} />
          <div className="text-center"><Button onClick={analysis.retryArtifact}>重试加载结果</Button></div>
        </div>
      ) : analysis.artifactLoading ? <div className="spatial-result-dialog-state text-center"><Spin /><span className="ml-2 text-sm text-geo-text-secondary">读取结果…</span></div> : <Empty className="spatial-result-dialog-state" description="暂无结果" />}
    </Modal>
  </>
);

export default AnalysisRunView;
