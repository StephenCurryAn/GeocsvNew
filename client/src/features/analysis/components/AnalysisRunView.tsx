import { useEffect, useState } from 'react';
import { Alert, Button, Space, Spin, Tag } from 'antd';
import { ArrowUpRight, History } from 'lucide-react';
import { CheckCircleOutlined, ClockCircleOutlined, LoadingOutlined, StopOutlined } from '@ant-design/icons';
import { useAnalysisWorkspace, type AnalysisSource } from './AnalysisWorkspace';
import { fetchSceneRuns } from '../../../services/analysisWorkflowService';
import { getRequestErrorMessage, type Run } from '../../../services/analysisService';

const statusLabel = { queued: '排队中', running: '计算中', succeeded: '已完成', failed: '失败', cancelled: '已取消' } as const;
const historyTime = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
const formatRunTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : historyTime.format(date);
};

export default function AnalysisRunView({ source, sceneId }: { source: AnalysisSource; sceneId?: string }) {
  const { runs, openResult } = useAnalysisWorkspace();
  const analysis = runs[source];
  const { run } = analysis;
  const [sceneRuns, setSceneRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  useEffect(() => {
    if (!sceneId) return;
    const controller = new AbortController();
    setLoading(true);
    setHistoryError(null);
    void fetchSceneRuns(sceneId, controller.signal)
      .then(items => { if (!controller.signal.aborted) setSceneRuns(items); })
      .catch(reason => { if (!controller.signal.aborted) setHistoryError(getRequestErrorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sceneId, run?.id, run?.status]);
  const history = sceneId === undefined ? analysis.runHistory : sceneRuns;

  return (
    <>
      {analysis.requestError && <Alert className="mb-2" type="error" showIcon title={analysis.requestError}
        closable onClose={() => analysis.setRequestError(null)} />}
      {run && (
        <section className="run-status-card" aria-label="当前任务">
          <div className="run-status-header">
            <Space size={6}>
              {analysis.activeRun ? <LoadingOutlined className="text-geo-accent" /> : run.status === 'succeeded'
                ? <CheckCircleOutlined className="text-emerald-400" /> : <ClockCircleOutlined className="text-geo-text-secondary" />}
              <span>{statusLabel[run.status]}</span>
            </Space>
            {analysis.activeRun && <Button size="small" danger icon={<StopOutlined />} loading={analysis.cancelling}
              onClick={() => void analysis.cancel()}>取消</Button>}
            {run.status === 'succeeded' && run.artifactId && (
              <Button size="small" type="text" onClick={() => openResult(source)}>
                查看结果 <ArrowUpRight size={13} />
              </Button>
            )}
          </div>
          {run.error && <div className="mt-2 text-xs text-red-300">{run.error}</div>}
        </section>
      )}

      <section className="run-history" aria-label="运行历史">
        <h3><History size={14} />运行历史</h3>
        {historyError && <Alert type="error" showIcon title={historyError} />}
        {(sceneId === undefined ? analysis.historyLoading : loading) ? <Spin size="small" /> : history.length === 0
          ? <p className="run-history-empty">暂无运行</p> : (
          <div className="run-history-list">
            {history.map(historyRun => (
              <button key={historyRun.id} type="button" className="run-history-item" title={historyRun.createdAt}
                onClick={() => {
                  if (run?.id !== historyRun.id || run.status !== historyRun.status || run.artifactId !== historyRun.artifactId
                    || (historyRun.artifactId && analysis.artifactError)) analysis.restoreRun(historyRun);
                  if (historyRun.status === 'succeeded' && historyRun.artifactId) openResult(source);
                }}>
                <span>{formatRunTime(historyRun.createdAt)}</span>
                {sceneId && <span>{historyRun.spec.kind === 'spatial_autocorrelation' ? 'Moran/LISA' : '空间透视'}</span>}
                <Tag color={historyRun.status === 'succeeded' ? 'green' : historyRun.status === 'failed' ? 'red' : 'default'}>
                  {statusLabel[historyRun.status]}
                </Tag>
              </button>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
