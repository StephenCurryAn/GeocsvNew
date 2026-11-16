import { Alert, Button, Empty, Spin } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import SpatialPivotResult from './SpatialPivotResult';
import type { AnalysisRunController } from './useAnalysisRun';
import './spatial-results.css';

export default function AnalysisResultView({ analysis }: { analysis: AnalysisRunController | null }) {
  const artifact = analysis?.artifact;
  return (
    <div className="spatial-result-view">
      <header className="spatial-result-heading">
        <h2>空间透视结果</h2>
        {artifact && (
          <Button size="small" icon={<DownloadOutlined />} loading={analysis.csvDownloading}
            onClick={() => void analysis.exportCsv()}>导出 CSV</Button>
        )}
      </header>
      {analysis?.resultError && <Alert className="spatial-result-error" type="error"
        showIcon title={analysis.resultError} closable onClose={() => analysis.setResultError(null)} />}
      {analysis && artifact ? (
        <SpatialPivotResult
          artifact={artifact}
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
          chartType={analysis.chartType}
          onChartTypeChange={analysis.setChartType}
        />
      ) : analysis?.artifactError ? (
        <div className="spatial-result-state">
          <Alert type="error" showIcon title={'结果加载失败：' + analysis.artifactError} />
          <Button onClick={analysis.retryArtifact}>重试加载结果</Button>
        </div>
      ) : analysis?.artifactLoading || (analysis?.run?.status === 'succeeded' && analysis.run.artifactId) ? (
        <div className="spatial-result-state" role="status"><Spin size="small" />读取结果…</div>
      ) : (
        <div className="spatial-result-state">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={analysis?.activeRun ? '分析正在运行，完成后可在这里查看' : '从运行历史打开已完成的结果'} />
        </div>
      )}
    </div>
  );
}
