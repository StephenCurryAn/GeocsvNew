import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Empty, Form, Input, Segmented, Select, Spin, Tag } from 'antd';
import { useAnalysisWorkspace } from './AnalysisWorkspace';
import { ModelEditor, ModelRunForm, ModelSummary } from './ProfessionalModelForms';
import { getRequestErrorMessage, type Run } from '../../../services/spatialPivotService';
import {
  professionalModelService as modelsApi, type ModelInputs, type ModelLayer, type ModelOperator, type ProfessionalModel,
} from '../../../services/professionalModelService';
import './professional-models.css';

type Mode = 'catalog' | 'manage' | 'history';
const modes: { label: string; value: Mode }[] = [
  { label: '模型目录', value: 'catalog' }, { label: '发布管理', value: 'manage' }, { label: '运行历史', value: 'history' },
];
const runStatus: Record<Run['status'], string> = {
  queued: '等待运行', running: '正在计算', succeeded: '已完成', failed: '失败', cancelled: '已取消',
};
type Management = { token: string; models: ProfessionalModel[]; operators: ModelOperator[] };

export default function ProfessionalModels({ sceneId }: { sceneId: string }) {
  const { runs: { professional: analysis }, openResult, view } = useAnalysisWorkspace();
  const [mode, setMode] = useState<Mode>('catalog');
  const [catalog, setCatalog] = useState<ProfessionalModel[]>();
  const [modelId, setModelId] = useState('');
  const [management, setManagement] = useState<Management>();
  const [draftId, setDraftId] = useState('');
  const [history, setHistory] = useState<Run[]>();
  const [layers, setLayers] = useState<ModelLayer[]>([]);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string>();
  const [reload, setReload] = useState(0);
  const request = useRef<{ fingerprint: string; key: string }>();
  const active = view === 'models';
  const run = analysis.run?.professionalModel?.sceneId === sceneId ? analysis.run : null;
  const latestRunStatus = run?.status;
  const selectedModel = catalog?.find(model => model.id === modelId);
  const selectedDraft = management?.models.find(model => model.id === draftId);
  const trial = run?.professionalModel?.purpose === 'trial' && selectedDraft?.revision === run.professionalModel.revision ? run : null;
  const trialPassed = selectedDraft?.trialRunId || (trial?.status === 'succeeded' && trial.artifactId);

  useEffect(() => {
    if (!active || mode !== 'catalog') return;
    const controller = new AbortController();
    modelsApi.catalog(controller.signal)
      .then(data => { if (!controller.signal.aborted) setCatalog(data); })
      .catch(error => { if (!controller.signal.aborted) setError(getRequestErrorMessage(error)); });
    return () => controller.abort();
  }, [active, mode, reload]);

  useEffect(() => {
    if (!active || !sceneId) return;
    const controller = new AbortController();
    const fetch = mode === 'history'
      ? modelsApi.runs(sceneId, controller.signal).then(items => { if (!controller.signal.aborted) setHistory(items); })
      : modelsApi.layers(sceneId, controller.signal).then(items => { if (!controller.signal.aborted) setLayers(items); });
    void fetch.catch(error => { if (!controller.signal.aborted) setError(getRequestErrorMessage(error)); });
    return () => controller.abort();
  }, [active, mode, sceneId, reload, latestRunStatus]);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try { await action(); }
    catch (failure) { setError(getRequestErrorMessage(failure)); }
    finally { setBusy(false); }
  };

  const remember = (model: ProfessionalModel) => {
    setManagement(previous => previous ? { ...previous, models: [
      ...previous.models.filter(item => item.id !== model.id), model,
    ].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')) } : previous);
    setDraftId(model.id);
    setDirty(false);
  };

  const submit = (model: ProfessionalModel, inputs: ModelInputs, token?: string) => void act(async () => {
    const fingerprint = JSON.stringify([model.revision, !!token, inputs]);
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, key: crypto.randomUUID() };
    const created = await modelsApi.run(sceneId, model, inputs, request.current.key, token);
    request.current = undefined;
    analysis.restoreRun(created);
  });

  const viewRun = (chosen: Run) => {
    analysis.restoreRun(chosen);
    openResult('professional');
  };

  const runNotice = (item: Run) => (
    <Alert showIcon type={item.status === 'failed' ? 'error' : item.status === 'succeeded' ? 'success' : 'info'}
      title={item.status === 'succeeded' && item.professionalModel?.purpose === 'trial' ? '试跑成功' : runStatus[item.status]}
      description={item.error}
      action={item.status === 'succeeded' && <Button size="small" onClick={() => viewRun(item)}>查看结果</Button>} />
  );

  return <div className="professional-models">
    <header className="professional-models-header">
      <Segmented<Mode> aria-label="专业模型视图" options={modes} value={mode} disabled={busy}
        onChange={value => { setError(undefined); setMode(value); }} />
      <Button size="small" disabled={busy} onClick={() => {
        setError(undefined);
        setReload(value => value + 1);
        if (mode === 'manage' && management) void act(async () => {
          const latest = await modelsApi.management(management.token);
          setManagement({ ...latest, token: management.token });
        });
      }}>刷新</Button>
    </header>
    {(error || analysis.requestError) && <Alert showIcon type="error" title={error ?? analysis.requestError} />}

    {mode === 'catalog' && (!catalog ? (!error && <Spin />) : !catalog.length
      ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无已发布的专业模型。可在发布管理中配置并试跑。" />
      : <section className="professional-model-card" aria-label="已发布模型">
        <Select aria-label="选择已发布模型" placeholder="选择已发布模型" value={modelId || undefined}
          className="professional-model-select" disabled={busy}
          options={catalog.map(model => ({ label: model.name + ' · v' + model.version, value: model.id }))}
          onChange={setModelId} />
        {selectedModel && <>
          <ModelSummary model={selectedModel} />
          <ModelRunForm key={selectedModel.revision} sceneId={sceneId} model={selectedModel} layers={layers}
            busy={busy} disabled={!!(run && ['queued', 'running'].includes(run.status))}
            onRun={inputs => submit(selectedModel, inputs)} />
          {run?.professionalModel?.purpose === 'run' && run.professionalModel.revision === selectedModel.revision && runNotice(run)}
        </>}
      </section>)}

    {mode === 'manage' && (!management ? (
      <section className="professional-model-card" aria-label="专业模型管理登录">
        <Form layout="vertical" onFinish={({ token }: { token: string }) => void act(async () => {
          const data = await modelsApi.management(token);
          setManagement({ ...data, token });
        })}>
          <Form.Item name="token" label="管理密钥" rules={[{ required: true, message: '请输入管理密钥' }]}>
            <Input.Password autoComplete="off" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={busy}>进入发布管理</Button>
        </Form>
      </section>
    ) : <>
      <section className="professional-model-card" aria-label="模型配置">
        <Select aria-label="选择配置" className="professional-model-select" value={draftId} disabled={busy}
          options={[{ label: '新建模型', value: '' }, ...management.models.map(model => ({
            label: model.name + ' · v' + model.version + (model.publishedAt ? '（已发布）' : '（草稿）'), value: model.id,
          }))]}
          onChange={value => { setDraftId(value); setDirty(false); setError(undefined); }} />
        {selectedDraft?.publishedAt ? <>
          <ModelSummary model={selectedDraft} />
          <div><Button loading={busy} onClick={() => void act(async () =>
            remember(await modelsApi.nextDraft(management.token, selectedDraft)))}>创建下一版本草稿</Button></div>
        </> : (
          <ModelEditor key={selectedDraft?.revision ?? 'new'} draft={selectedDraft} operators={management.operators}
            saving={busy} onEdit={() => setDirty(true)}
            onSave={config => void act(async () => remember(await modelsApi.save(management.token, config, selectedDraft)))} />
        )}
      </section>
      {selectedDraft && !selectedDraft.publishedAt && <section className="professional-model-card" aria-label="试跑与发布">
        <h3>试跑与发布</h3>
        {dirty && <Alert showIcon type="info" title="保存修改后，请重新试跑此草稿。" />}
        <ModelRunForm key={selectedDraft.revision} sceneId={sceneId} model={selectedDraft} layers={layers}
          busy={busy} trial disabled={dirty || !!(run && ['queued', 'running'].includes(run.status))}
          onRun={inputs => submit(selectedDraft, inputs, management.token)} />
        {trial ? runNotice(trial) : trialPassed && <Alert showIcon type="success" title="此草稿已通过试跑" />}
        <div><Button disabled={dirty || !trialPassed} loading={busy} onClick={() => void act(async () =>
          remember(await modelsApi.publish(management.token, selectedDraft)))}>发布 v{selectedDraft.version}</Button></div>
      </section>}
    </>)}

    {mode === 'history' && (!history ? (!error && <Spin />) : !history.length
      ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前场景还没有专业模型任务" />
      : <ul className="professional-model-history">
        {history.map(item => <li key={item.id}>
          <div>
            <h3>{item.professionalModel?.name} · v{item.professionalModel?.version}</h3>
            <p>{item.professionalModel?.purpose === 'trial' ? '试跑' : '正式运行'} · {new Date(item.createdAt).toLocaleString()}</p>
            {item.error && <p>{item.error}</p>}
          </div>
          <div className="professional-model-actions">
            <Tag color={item.status === 'succeeded' ? 'success' : item.status === 'failed' ? 'error' : 'default'}>
              {runStatus[item.status]}
            </Tag>
            {item.status === 'succeeded' && <Button size="small" onClick={() => viewRun(item)}>查看结果</Button>}
          </div>
        </li>)}
      </ul>)}
  </div>;
}
