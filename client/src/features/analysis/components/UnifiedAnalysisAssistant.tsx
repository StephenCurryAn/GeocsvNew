import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Card, Input, Space, Spin, Tag, Typography } from 'antd';
import { CheckCircleOutlined, SendOutlined } from '@ant-design/icons';
import AnalysisRunView from './AnalysisRunView';
import { useAnalysisWorkspace } from './AnalysisWorkspace';
import {
  createNaturalLanguagePlan, getRequestErrorMessage,
  type NaturalLanguagePlan, type SpatialPivotPlan,
} from '../../../services/spatialPivotService';

interface UnifiedAnalysisAssistantProps {
  sceneId: string;
  selectedFileIds: string[];
  onSwitchToLegacy: () => void;
}

const UnifiedAnalysisAssistant = ({ sceneId, selectedFileIds, onSwitchToLegacy }: UnifiedAnalysisAssistantProps) => {
  const { message } = App.useApp();
  const { runs: { assistant: analysis }, openResult } = useAnalysisWorkspace();
  const [prompt, setPrompt] = useState('');
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<NaturalLanguagePlan | null>(null);
  const [planBinding, setPlanBinding] = useState<{ prompt: string; fileIdsKey: string; contextRunId: string } | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [reusing, setReusing] = useState(false);
  const requestEpoch = useRef(0);
  const planningController = useRef<AbortController | null>(null);
  const previousMoranPlan = useRef<{ id: string; fileIdsKey: string } | null>(null);
  const reuseLock = useRef(false);
  const fileIdsKey = JSON.stringify([...new Set(selectedFileIds)].sort());
  const fileIds = JSON.parse(fileIdsKey) as string[];
  const contextRunId = analysis.run?.status === 'succeeded' ? analysis.run.id : '';
  const hasReusableContext = Boolean(contextRunId && analysis.run?.artifactId);
  const planIsCurrent = Boolean(planBinding
    && planBinding.prompt === prompt.trim()
    && planBinding.fileIdsKey === fileIdsKey
    && planBinding.contextRunId === contextRunId);

  const invalidatePlanRequest = useCallback(() => {
    requestEpoch.current += 1;
    planningController.current?.abort();
    planningController.current = null;
    setPlanning(false);
    setPlan(null);
    setPlanBinding(null);
  }, []);

  useEffect(() => {
    invalidatePlanRequest();
  }, [fileIdsKey, contextRunId, invalidatePlanRequest]);

  useEffect(() => () => {
    requestEpoch.current += 1;
    planningController.current?.abort();
  }, []);

  const handlePlan = async () => {
    if (!sceneId || !prompt.trim()) return;
    invalidatePlanRequest();
    const epoch = ++requestEpoch.current;
    const controller = new AbortController();
    planningController.current = controller;
    const submittedPrompt = prompt.trim();
    const submittedContextRunId = contextRunId;
    setPlanning(true);
    setPlanError(null);
    setFeedback(null);
    try {
      const result = await createNaturalLanguagePlan(sceneId, {
        userPrompt: submittedPrompt, fileIds, contextRunId: submittedContextRunId || undefined,
        contextPlanId: previousMoranPlan.current?.fileIdsKey === fileIdsKey ? previousMoranPlan.current.id : undefined,
      }, controller.signal);
      if (controller.signal.aborted || requestEpoch.current !== epoch) return;
      setPlan(result);
      setPlanBinding({ prompt: submittedPrompt, fileIdsKey, contextRunId: submittedContextRunId });
      if ('view' in result) analysis.setChartType(result.view.chartType);
      if (result.status === 'ready') {
        previousMoranPlan.current = 'view' in result ? null : { id: result.plan.id, fileIdsKey };
      }
    } catch (error) {
      if (!controller.signal.aborted && requestEpoch.current === epoch) setPlanError(`自然语言规划失败：${getRequestErrorMessage(error)}`);
    } finally {
      if (requestEpoch.current === epoch) {
        planningController.current = null;
        setPlanning(false);
      }
    }
  };

  const handlePromptChange = (value: string) => {
    if (value.trim() !== prompt.trim()) {
      invalidatePlanRequest();
      setPlanError(null);
      setFeedback(null);
    }
    setPrompt(value);
  };

  const handleClearDraft = () => {
    invalidatePlanRequest();
    previousMoranPlan.current = null;
    setPrompt('');
    setPlanError(null);
    setFeedback(null);
  };

  const handleExecute = async (plan: SpatialPivotPlan) => {
    setStarting(true);
    setPlanError(null);
    try {
      await analysis.start(plan);
      setPlan(null);
      setPlanBinding(null);
      message.success('已提交已验证空间透视算子');
    } catch (error) {
      setPlanError(`提交分析任务失败：${getRequestErrorMessage(error)}`);
    } finally {
      setStarting(false);
    }
  };

  const handleReuse = async (runId: string, artifactId: string) => {
    if (reuseLock.current) return;
    reuseLock.current = true;
    setReusing(true);
    setPlanError(null);
    try {
      if (!await analysis.restoreExistingRun(runId, artifactId)) return;
      openResult('assistant');
      setFeedback('已复用已有结果并更新展示方式，没有重新计算。');
    } catch (error) {
      setPlanError(`无法复用已有结果：${getRequestErrorMessage(error)}`);
    } finally {
      reuseLock.current = false;
      setReusing(false);
    }
  };

  return (
    <div className="assistant-content flex h-full min-h-0 flex-col gap-3 overflow-y-auto">
      <Card size="small" className="assistant-plan-card" title="分析需求">
        <div className="space-y-3">
          <Typography.Paragraph className="!mb-0 text-xs text-slate-400">
            支持面内点计数和 Moran/LISA 空间自相关。可从左侧打开图层，也可在需求中写出当前场景的图层名称。
          </Typography.Paragraph>
          {selectedFileIds.length === 0 && hasReusableContext && <Alert type="info" showIcon title="可复用当前场景中已打开的运行结果来更换图表。" />}
          <Input.TextArea
            value={prompt}
            onChange={event => handlePromptChange(event.target.value)}
            placeholder="例如：用社区图层的 total_requests 字段做 Moran/LISA，采用 Queen 邻接"
            autoSize={{ minRows: 2, maxRows: 5 }}
            disabled={!sceneId}
          />
          <div className="flex gap-2">
            <Button className="flex-1" type="primary" icon={<SendOutlined />} loading={planning} disabled={!sceneId || !prompt.trim()} onClick={() => void handlePlan()}>
              规划分析
            </Button>
            <Button onClick={handleClearDraft} disabled={!prompt && !plan && !planError && !feedback && !planning}>清空草案</Button>
          </div>

          {planError && <Alert type="error" showIcon title={planError} />}
          {feedback && <Alert type="success" showIcon title={feedback} closable onClose={() => setFeedback(null)} />}
          {planning && <div className="text-center"><Spin size="small" /></div>}

          {plan?.status === 'ready' && 'view' in plan && planIsCurrent && (
            <div className="space-y-2 rounded-md border border-cyan-900/50 bg-slate-900/60 p-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-cyan-200"><CheckCircleOutlined />已生成待确认计划（{plan.source === 'rules' ? '规则规划' : '模型规划'}）</div>
              <Typography.Paragraph className="!mb-1 text-xs text-slate-300">{plan.message}</Typography.Paragraph>
              <div className="text-xs text-slate-300">
                目标面：{plan.inputs.targetName}（标识字段：{plan.spec.target.labelField || '要素 ID'}）<br />
                关联点：{plan.inputs.joinName}（类别字段：{plan.spec.join.categoryField || '统计总数'}）<br />
                边界点：{plan.spec.boundaryPolicy === 'include' ? '纳入统计' : '排除统计'}；展示：{{ bar: '柱状图', line: '折线图', pie: '饼图' }[plan.view.chartType]}
              </div>
              {plan.assumptions.length > 0 && <div className="text-xs text-amber-200">假设：<ul className="ml-4 list-disc">{plan.assumptions.map((assumption, index) => <li key={`${index}-${assumption}`}>{assumption}</li>)}</ul></div>}
              <Button block type="primary" loading={starting} disabled={!planIsCurrent || Boolean(analysis.activeRun)} onClick={() => void handleExecute(plan.plan)}>
                执行已验证算子
              </Button>
            </div>
          )}

          {plan?.status === 'ready' && !('view' in plan) && planIsCurrent && (
            <Card size="small" title="Moran/LISA 空间自相关">
              <Tag className="!mb-2" color="processing">待确认</Tag>
              <dl className="!mb-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                <dt>面图层</dt><dd className="break-all">{plan.inputs.targetName}</dd>
                <dt>数值字段</dt><dd className="break-all">{plan.spec.target.valueField}</dd>
                <dt>邻接规则</dt><dd>{plan.spec.contiguity === 'queen' ? 'Queen（共点或共边）' : 'Rook（共边）'}</dd>
                <dt>置换次数</dt><dd>{plan.spec.permutations}</dd>
                <dt>随机种子</dt><dd>{plan.spec.seed}</dd>
              </dl>
            </Card>
          )}

          {plan?.status === 'clarification' && planIsCurrent && (
            <Alert type="warning" showIcon title={plan.message} description={<ul className="ml-4 list-disc">{plan.questions.map((question, index) => <li key={`${index}-${question}`}>{question}</li>)}</ul>} />
          )}

          {plan?.status === 'unsupported' && planIsCurrent && (
            <Alert type="info" showIcon title={plan.message} description={<Button size="small" className="mt-2" onClick={onSwitchToLegacy}>切换到原有实验流程</Button>} />
          )}

          {plan?.status === 'view_only' && planIsCurrent && (
            <div className="space-y-2 rounded-md border border-indigo-900/50 bg-slate-900/60 p-3">
              <Alert type="info" showIcon title={plan.message} description="只复用既有运行结果；不会创建新任务。" />
              <Space wrap>
                {(['bar', 'line', 'pie'] as const).map(type => (
                  <Button key={type} size="small" type={analysis.chartType === type ? 'primary' : 'default'} onClick={() => analysis.setChartType(type)}>
                    {{ bar: '柱状图', line: '折线图', pie: '饼图' }[type]}
                  </Button>
                ))}
                <Button type="primary" size="small" loading={reusing} disabled={reusing} onClick={() => void handleReuse(plan.runId, plan.artifactId)}>复用已有结果</Button>
              </Space>
            </div>
          )}
        </div>
      </Card>

      <AnalysisRunView source="assistant" />
    </div>
  );
};

export default UnifiedAnalysisAssistant;
