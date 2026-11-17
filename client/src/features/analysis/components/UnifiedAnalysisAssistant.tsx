import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Input, Tag, Typography } from 'antd';
import { SendOutlined } from '@ant-design/icons';
import { fetchAnalysisSession, sendAnalysisEvent, type AnalysisSession, type AnalysisSessionEvent } from '../../../services/analysisWorkflowService';
import { fetchRun, getRequestErrorMessage } from '../../../services/spatialPivotService';
import AnalysisRunView from './AnalysisRunView';
import { useAnalysisWorkspace } from './AnalysisWorkspace';

const example = '2024 年 1 月，芝加哥坑洞投诉多的社区，是否也挨着投诉多的社区？如果有这种聚集，具体在哪里？';

function sceneThread(sceneId: string, next?: string | null) {
  try {
    const key = 'geocsv:analysis-session:' + sceneId;
    if (next === undefined) return localStorage.getItem(key);
    if (next === null) localStorage.removeItem(key);
    else localStorage.setItem(key, next);
  } catch { /* The session can still run when browser storage is disabled. */ }
  return null;
}

export default function UnifiedAnalysisAssistant({ sceneId, onSwitchToLegacy }: {
  sceneId: string;
  onSwitchToLegacy: () => void;
}) {
  const { runs: { assistant: analysis }, openResult } = useAnalysisWorkspace();
  const [prompt, setPrompt] = useState('');
  const [answer, setAnswer] = useState('');
  const [session, setSession] = useState<AnalysisSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const activeRequest = useRef<AbortController | null>(null);
  const retry = useRef<{ threadId: string; event: AnalysisSessionEvent } | null>(null);
  const attachedRun = useRef<string | null>(null);
  const restoreRun = analysis.restoreRun;
  const resetRun = analysis.reset;

  useEffect(() => {
    resetRun();
    const thread = sceneId && sceneThread(sceneId);
    if (thread) {
      const controller = new AbortController();
      activeRequest.current = controller;
      setBusy(true);
      void fetchAnalysisSession(sceneId, thread, controller.signal).then(value => {
        if (!controller.signal.aborted) { setSession(value); setPrompt(value.prompt); }
      }).catch(reason => {
        if (!controller.signal.aborted) setError(getRequestErrorMessage(reason));
      }).finally(() => {
        if (!controller.signal.aborted) { activeRequest.current = null; setBusy(false); }
      });
    }
    return () => { activeRequest.current?.abort(); };
  }, [sceneId, resetRun]);

  useEffect(() => {
    const runId = session?.runId;
    if (!runId || attachedRun.current === runId) return;
    const controller = new AbortController();
    void fetchRun(runId, controller.signal).then(run => {
      if (!controller.signal.aborted) {
        attachedRun.current = runId;
        restoreRun(run);
      }
    }).catch(reason => {
      if (!controller.signal.aborted) setError(getRequestErrorMessage(reason));
    });
    return () => { controller.abort(); };
  }, [session?.runId, restoreRun]);

  const applyEvent = async (threadId: string, event: AnalysisSessionEvent) => {
    if (!sceneId || activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    retry.current = { threadId, event };
    setBusy(true);
    setError('');
    try {
      const next = await sendAnalysisEvent(sceneId, threadId, event, controller.signal);
      if (controller.signal.aborted) return;
      retry.current = null;
      setSession(next);
      setPrompt(next.prompt);
      setAnswer('');
    } catch (reason) {
      if (!controller.signal.aborted) setError(getRequestErrorMessage(reason));
    } finally {
      if (!controller.signal.aborted) { activeRequest.current = null; setBusy(false); }
    }
  };

  const start = () => {
    const threadId = crypto.randomUUID();
    sceneThread(sceneId, threadId);
    setSession(null);
    const reusable = session?.runId === analysis.run?.id && analysis.run?.status === 'succeeded' ? analysis.run.id : undefined;
    void applyEvent(threadId, { action: 'start', requestId: crypto.randomUUID(), prompt: prompt.trim(), contextRunId: reusable });
  };

  const respond = (action: 'answer' | 'confirm' | 'cancel' | 'resume') => {
    const threadId = session?.threadId ?? sceneThread(sceneId);
    if (!threadId) return;
    void applyEvent(threadId, { action, requestId: crypto.randomUUID(),
      interactionId: session?.interactionId ?? undefined, ...(action === 'answer' ? { prompt: answer.trim() } : {}) });
  };

  const reset = () => {
    sceneThread(sceneId, null);
    retry.current = null;
    setSession(null);
    setPrompt('');
    setAnswer('');
    setError('');
  };

  const proposal = session?.proposal;
  const pending = session?.status === 'pending_confirmation' && proposal?.status === 'ready';
  const clarifying = session?.status === 'clarification' && proposal?.status === 'clarification';
  const processing = session?.status === 'processing';
  const reusable = proposal?.status === 'view_only' ? proposal : null;
  const metric = proposal?.status === 'ready' && !('view' in proposal) ? proposal.inputs.metricLabel : undefined;
  const dataMonth = proposal?.status === 'ready' && !('view' in proposal) ? proposal.inputs.dataMonth : undefined;

  return (
    <div className="assistant-content flex h-full min-h-0 flex-col gap-3 overflow-y-auto">
      <Card size="small" className="assistant-plan-card" title="分析需求">
        <div className="space-y-3">
          <Typography.Paragraph className="!mb-0 text-xs text-geo-text-secondary">
            直接描述你想知道什么。助手会从当前场景查找可用数据，并把选用的数据与分析方法列给你确认。
          </Typography.Paragraph>
          <Input.TextArea
            aria-label="分析需求" value={prompt} onChange={event => setPrompt(event.target.value)}
            placeholder={example} autoSize={{ minRows: 3, maxRows: 6 }}
            disabled={!sceneId || busy || pending || clarifying || processing}
          />
          <div className="flex gap-2">
            <Button className="flex-1" type="primary" icon={<SendOutlined />} loading={busy}
              disabled={!sceneId || !prompt.trim() || pending || clarifying || processing} onClick={start}>规划分析</Button>
            <Button disabled={busy || !prompt || processing} onClick={pending || clarifying ? () => respond('cancel') : reset}>
              {pending || clarifying ? '取消本次分析' : '清空'}
            </Button>
          </div>

          {error && <Alert type="error" showIcon title={error} action={
            <Button size="small" disabled={busy} onClick={() => {
              const latest = retry.current;
              if (latest) void applyEvent(latest.threadId, latest.event);
              else respond('resume');
            }}>恢复或重试</Button>
          } />}
          {processing && !error && <Alert type="info" showIcon title="分析可以从上次中断处继续"
            action={<Button size="small" loading={busy} onClick={() => respond('resume')}>恢复分析</Button>} />}
          {pending && (
            <Card size="small" title={<><Tag color="processing">待确认</Tag>{proposal.message}</>}>
              {'view' in proposal ? (
                <dl className="mb-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                  <dt>统计范围</dt><dd className="break-all">{proposal.inputs.targetName}</dd>
                  <dt>统计数据</dt><dd className="break-all">{proposal.inputs.joinName}</dd>
                </dl>
              ) : (
                <dl className="mb-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                  <dt>分析指标</dt><dd>{metric ?? proposal.spec.target.valueField}</dd>
                  {dataMonth && <><dt>数据时段</dt><dd>{dataMonth}</dd></>}
                  <dt>数据来源</dt><dd className="break-all">{proposal.inputs.targetName}</dd>
                  <dt>邻居定义</dt><dd>{proposal.spec.contiguity === 'queen' ? 'Queen（共边或共点）' : 'Rook（仅共边）'}</dd>
                  <dt>置换检验</dt><dd>{proposal.spec.permutations} 次 · 种子 {proposal.spec.seed}</dd>
                </dl>
              )}
              <Button block type="primary" loading={busy} onClick={() => respond('confirm')}>确认并运行</Button>
            </Card>
          )}
          {clarifying && <>
            <Alert type="warning" showIcon title={proposal.message}
              description={<ul className="ml-4 list-disc">{proposal.questions.map((question, index) => <li key={index}>{question}</li>)}</ul>} />
            <Input aria-label="补充分析条件" placeholder="用自己的话补充" value={answer} disabled={busy}
              onChange={event => setAnswer(event.target.value)} onPressEnter={() => { if (answer.trim()) respond('answer'); }} />
            <Button size="small" type="primary" disabled={busy || !answer.trim()} onClick={() => respond('answer')}>继续规划</Button>
          </>}
          {proposal?.status === 'unsupported' && <Alert type="info" showIcon title={proposal.message}
            description={<Button size="small" onClick={onSwitchToLegacy}>打开原有实验流程</Button>} />}
          {reusable && <Alert type="info" showIcon title={reusable.message} action={<Button size="small" onClick={() => {
            analysis.setChartType(reusable.view.chartType);
            void analysis.restoreExistingRun(reusable.runId, reusable.artifactId).then(restored => {
              if (restored) openResult('assistant');
            }).catch(reason => setError(getRequestErrorMessage(reason)));
          }}>查看已有结果</Button>} />}
          {session?.status === 'cancelled' && <Alert type="info" showIcon title="已取消本次分析" />}
        </div>
      </Card>
      <AnalysisRunView source="assistant" sceneId={sceneId} />
    </div>
  );
}
