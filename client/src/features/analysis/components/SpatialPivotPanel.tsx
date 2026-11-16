import { useEffect, useMemo, useState } from 'react';
import {
  Alert, App, Button, Card, Empty, Radio, Select, Spin, Tag, Typography,
} from 'antd';
import {
  CheckCircleOutlined, DeploymentUnitOutlined, PlayCircleOutlined,
} from '@ant-design/icons';
import AnalysisRunView from './AnalysisRunView';
import { useAnalysisRun } from './useAnalysisRun';
import {
  createAnalysisPlan, fetchDatasets, getRequestErrorMessage,
  type BoundaryPolicy, type DatasetSummary, type SpatialPivotPlan, type SpatialPivotSpec,
} from '../../../services/spatialPivotService';


const isPolygonDataset = (dataset: DatasetSummary): boolean =>
  dataset.geometryTypes.length > 0 && dataset.geometryTypes.every(type =>
    ['polygon', 'multipolygon', 'st_polygon', 'st_multipolygon'].includes(type.toLowerCase()));

const isPointDataset = (dataset: DatasetSummary): boolean =>
  dataset.geometryTypes.length > 0 && dataset.geometryTypes.every(type =>
    ['point', 'multipoint', 'st_point', 'st_multipoint'].includes(type.toLowerCase()));

const SpatialPivotPanel = ({ selectedFileIds }: { selectedFileIds: string[] }) => {
  const { message } = App.useApp();
  const analysis = useAnalysisRun();
  const selectedIdsKey = JSON.stringify(Array.from(new Set(selectedFileIds)));
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [datasetsLoading, setDatasetsLoading] = useState(false);
  const [targetFileId, setTargetFileId] = useState('');
  const [joinFileId, setJoinFileId] = useState('');
  const [labelField, setLabelField] = useState<string | null>(null);
  const [categoryField, setCategoryField] = useState<string | null>(null);
  const [boundaryPolicy, setBoundaryPolicy] = useState<BoundaryPolicy>('exclude');
  const [plan, setPlan] = useState<SpatialPivotPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const polygonDatasets = useMemo(() => datasets.filter(isPolygonDataset), [datasets]);
  const pointDatasets = useMemo(() => datasets.filter(isPointDataset), [datasets]);
  const hasValidLayerPair = polygonDatasets.some(target => pointDatasets.some(join => join.fileId !== target.fileId));
  const targetDataset = polygonDatasets.find(dataset => dataset.fileId === targetFileId);
  const joinDataset = pointDatasets.find(dataset => dataset.fileId === joinFileId);

  useEffect(() => {
    const controller = new AbortController();
    const fileIds = JSON.parse(selectedIdsKey) as string[];
    setDatasetsLoading(true);
    setDatasets([]);
    fetchDatasets(fileIds, controller.signal)
      .then(setDatasets)
      .catch(error => {
        if (!controller.signal.aborted) setRequestError(getRequestErrorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setDatasetsLoading(false);
      });
    return () => controller.abort();
  }, [selectedIdsKey]);

  useEffect(() => {
    if (!polygonDatasets.some(dataset => dataset.fileId === targetFileId)) {
      setTargetFileId(polygonDatasets[0]?.fileId || '');
      setLabelField(null);
      setPlan(null);
    }
    const validJoin = pointDatasets.find(dataset => dataset.fileId !== targetFileId);
    if (!pointDatasets.some(dataset => dataset.fileId === joinFileId && dataset.fileId !== targetFileId)) {
      setJoinFileId(validJoin?.fileId || '');
      setCategoryField(null);
      setPlan(null);
    }
  }, [polygonDatasets, pointDatasets, targetFileId, joinFileId]);

  const handlePlan = async () => {
    if (!targetDataset || !joinDataset) {
      message.warning('请选择一个面或多面目标图层，以及一个点或多点关联图层');
      return;
    }
    setPlanning(true);
    setRequestError(null);
    try {
      const spec: SpatialPivotSpec = {
        schemaVersion: 1,
        kind: 'spatial_pivot',
        operatorVersion: 1,
        target: { fileId: targetDataset.fileId, labelField },
        join: { fileId: joinDataset.fileId, categoryField },
        boundaryPolicy,
      };
      setPlan(await createAnalysisPlan(spec));
      message.success('分析计划已通过校验，请确认后开始运行');
    } catch (error) {
      setRequestError(`分析计划校验失败：${getRequestErrorMessage(error)}`);
    } finally {
      setPlanning(false);
    }
  };

  const handleStart = async () => {
    if (!plan) return;
    setStarting(true);
    setRequestError(null);
    try {
      await analysis.start(plan);
      setPlan(null);
      message.success('分析任务已提交');
    } catch (error) {
      setRequestError(`提交分析任务失败：${getRequestErrorMessage(error)}`);
    } finally {
      setStarting(false);
    }
  };

  return (
    <Card
      size="small"
      className="border-cyan-800/40 bg-[#0b1121] shadow-lg shadow-cyan-900/5"
      title={<span className="flex items-center gap-2 text-sm text-cyan-300"><DeploymentUnitOutlined />空间透视分析</span>}
      extra={<Tag color="cyan">确定性算子</Tag>}
      styles={{ header: { borderBottomColor: 'rgba(8,145,178,.25)' }, body: { padding: 14 } }}
    >
      <div className="space-y-4">
        <Typography.Paragraph className="!mb-0 text-xs text-slate-400">
          统计每个目标面内点要素的数量，可按关联图层的类别拆分。边界点可选择排除或纳入；重叠面采用多重归属，落在多个面的点会分别计入；没有匹配点的目标保留并显示为 0。
        </Typography.Paragraph>

        {requestError && <Alert type="error" showIcon closable title={requestError} onClose={() => setRequestError(null)} />}
        {selectedFileIds.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请先勾选参与分析的数据图层" />}
        {datasetsLoading && <div className="py-2 text-center"><Spin size="small" /><span className="ml-2 text-xs text-slate-400">读取图层字段信息…</span></div>}

        {!datasetsLoading && selectedFileIds.length > 0 && datasets.length === 0 && !requestError && (
          <Alert type="warning" showIcon title="当前勾选文件没有可用的空间图层信息" />
        )}

        {!datasetsLoading && datasets.length > 0 && (
          <div className="space-y-3">
            <label className="block text-xs text-slate-300">目标面图层
              <Select
                className="mt-1 w-full"
                value={targetFileId || undefined}
                placeholder="选择 Polygon / MultiPolygon 图层"
                options={polygonDatasets.map(dataset => ({ label: `${dataset.name}（${dataset.featureCount}）`, value: dataset.fileId }))}
                onChange={value => { setTargetFileId(value); setLabelField(null); setPlan(null); }}
              />
            </label>

            <label className="block text-xs text-slate-300">点要素关联图层
              <Select
                className="mt-1 w-full"
                value={joinFileId || undefined}
                placeholder="选择 Point / MultiPoint 图层"
                options={pointDatasets.filter(dataset => dataset.fileId !== targetFileId).map(dataset => ({ label: `${dataset.name}（${dataset.featureCount}）`, value: dataset.fileId }))}
                onChange={value => { setJoinFileId(value); setCategoryField(null); setPlan(null); }}
              />
            </label>

            <label className="block text-xs text-slate-300">目标标识字段（可选）
              <Select
                allowClear
                className="mt-1 w-full"
                value={labelField || undefined}
                placeholder="不选时使用要素 ID"
                options={(targetDataset?.fields || []).map(field => ({ label: field, value: field }))}
                onChange={value => { setLabelField(value || null); setPlan(null); }}
              />
            </label>

            <label className="block text-xs text-slate-300">点类别字段（可选）
              <Select
                allowClear
                className="mt-1 w-full"
                value={categoryField || undefined}
                placeholder="不选时统计点要素总数"
                options={(joinDataset?.fields || []).map(field => ({ label: field, value: field }))}
                onChange={value => { setCategoryField(value || null); setPlan(null); }}
              />
            </label>

            <div>
              <div className="mb-1 text-xs text-slate-300">落在面边界上的点</div>
              <Radio.Group
                value={boundaryPolicy}
                onChange={event => { setBoundaryPolicy(event.target.value as BoundaryPolicy); setPlan(null); }}
                optionType="button"
                buttonStyle="solid"
                size="small"
                options={[{ label: '排除边界', value: 'exclude' }, { label: '纳入边界', value: 'include' }]}
              />
            </div>

            <Button
              block
              type="primary"
              icon={<CheckCircleOutlined />}
              loading={planning}
              disabled={!targetDataset || !joinDataset || Boolean(analysis.activeRun)}
              onClick={handlePlan}
            >检查分析计划</Button>
          </div>
        )}

        {!datasetsLoading && datasets.length > 0 && !hasValidLayerPair && (
          <Alert type="warning" showIcon title="请勾选至少一个面图层和一个不同的点图层" />
        )}

        {plan && (
          <div className="space-y-2 rounded-md border border-cyan-900/50 bg-slate-900/60 p-3">
            <div className="text-xs font-semibold text-cyan-200">计划已校验</div>
            <div className="text-xs text-slate-300">
              {targetDataset?.name}：{plan.spec.target.labelField || '按要素 ID'}，统计 {joinDataset?.name}
              {plan.spec.join.categoryField ? ` 中的「${plan.spec.join.categoryField}」分类` : ' 的总数'}；
              {plan.spec.boundaryPolicy === 'include' ? '纳入边界点' : '排除边界点'}。
            </div>
            <Button block type="primary" icon={<PlayCircleOutlined />} loading={starting} disabled={Boolean(analysis.activeRun)} onClick={handleStart}>
              开始空间透视
            </Button>
          </div>
        )}

        <AnalysisRunView analysis={analysis} />
      </div>
    </Card>
  );
};

export default SpatialPivotPanel;
