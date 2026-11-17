import { useEffect, useState } from 'react';
import { Alert, Button, Descriptions, Form, Input, InputNumber, Select } from 'antd';
import { getRequestErrorMessage } from '../../../services/spatialPivotService';
import {
  professionalModelService, type ModelConfig, type ModelDataset, type ModelInputs, type ModelLayer,
  type ModelOperator, type OperatorInput, type Parameters, type ProfessionalModel,
} from '../../../services/professionalModelService';

const operatorKey = (operator: ModelOperator) => operator.id + '@' + operator.version;
const operatorLabel = (operator: ModelOperator) => operator.name + ' · v' + operator.version;
const parameterLabel = (description: string) => description.split(/[。，]/, 1)[0];
const parameterValue = (value: string | number) => value === 'queen' ? 'Queen（共边或共点）'
  : value === 'rook' ? 'Rook（共边）' : value;
const defaults = (operator: ModelOperator) => Object.fromEntries(
  Object.entries(operator.parameters).map(([key, parameter]) => [key, parameter.default]),
);

export function ModelSummary({ model }: { model: ProfessionalModel }) {
  return <>
    <div className="professional-model-description">
      <h3>{model.name} <span>v{model.version}</span></h3>
      <p>{model.description}</p>
    </div>
    <Descriptions size="small" column={1}>
      <Descriptions.Item label="执行算子">{operatorLabel(model.operator)}</Descriptions.Item>
      {Object.entries(model.operator.parameters).map(([key, parameter]) =>
        <Descriptions.Item key={key} label={parameterLabel(parameter.description)}>
          {parameterValue(model.parameters[key])}
        </Descriptions.Item>)}
    </Descriptions>
  </>;
}

export function ModelEditor({ draft, operators, saving, onEdit, onSave }: {
  draft?: ProfessionalModel; operators: ModelOperator[]; saving: boolean;
  onEdit: () => void; onSave: (config: ModelConfig) => void;
}) {
  const first = draft?.operator ?? operators[0];
  const [form] = Form.useForm<{ name: string; description: string; operatorKey: string; parameters: Parameters }>();
  const selected = Form.useWatch('operatorKey', form);
  const operator = operators.find(item => operatorKey(item) === selected) ?? first;
  if (!first || !operator) return <Alert type="info" title="暂无已登记的专业模型执行入口" />;

  return <Form form={form} layout="vertical" disabled={saving}
    initialValues={{ name: draft?.name, description: draft?.description, operatorKey: operatorKey(first),
      parameters: draft?.parameters ?? defaults(first) }}
    onValuesChange={() => onEdit()}
    onFinish={({ name, description, parameters }) =>
      onSave({ name, description, parameters, operator: { id: operator.id, version: operator.version } })}>
    <Form.Item name="name" label="模型名称" rules={[{ required: true, whitespace: true, message: '请输入模型名称' }]}>
      <Input maxLength={80} placeholder="例如 Moran/LISA Queen" />
    </Form.Item>
    <Form.Item name="description" label="模型说明" rules={[{ required: true, whitespace: true, message: '请输入模型说明' }]}>
      <Input.TextArea maxLength={500} rows={2} placeholder="说明模型能回答什么问题、适用于什么数据" />
    </Form.Item>
    <Form.Item name="operatorKey" label="执行算子" extra={operator.description}>
      <Select options={operators.map(item => ({ label: operatorLabel(item), value: operatorKey(item) }))}
        onChange={value => {
          const next = operators.find(item => operatorKey(item) === value);
          if (next) form.setFieldValue('parameters', defaults(next));
        }} />
    </Form.Item>
    <div className="professional-model-parameters">
      {Object.entries(operator.parameters).map(([key, parameter]) => (
        <Form.Item key={key} name={['parameters', key]} label={parameterLabel(parameter.description)}
          extra={parameter.description === parameterLabel(parameter.description) ? undefined : parameter.description}
          rules={[{ required: true, message: '请输入参数值' }]}>
          {parameter.type === 'string'
            ? <Select options={parameter.enum.map(value => ({ label: parameterValue(value), value }))} />
            : <InputNumber precision={0} min={parameter.minimum} max={parameter.maximum} style={{ width: '100%' }} />}
        </Form.Item>
      ))}
    </div>
    <Button htmlType="submit" loading={saving}>{draft ? '保存修改' : '保存草稿'}</Button>
  </Form>;
}

function LayerBinding({ sceneId, role, definition, layers, single }: {
  sceneId: string; role: string; definition: OperatorInput; layers: ModelLayer[]; single: boolean;
}) {
  const form = Form.useFormInstance<ModelInputs>();
  const fileId: string | undefined = Form.useWatch([role, 'fileId'], form);
  const [details, setDetails] = useState<{ fileId: string; dataset?: ModelDataset; error?: string }>();

  useEffect(() => {
    if (!fileId) return;
    const controller = new AbortController();
    professionalModelService.dataset(sceneId, fileId, controller.signal)
      .then(dataset => { if (!controller.signal.aborted) setDetails({ fileId, dataset }); })
      .catch(error => { if (!controller.signal.aborted) setDetails({ fileId, error: getRequestErrorMessage(error) }); });
    return () => controller.abort();
  }, [sceneId, fileId]);

  const dataset = details?.fileId === fileId ? details?.dataset : undefined;
  const matchesGeometry = dataset?.geometryTypes.length
    && dataset.geometryTypes.every(type => definition.geometryTypes.includes(type));
  return <>
    <Form.Item name={[role, 'fileId']} label={single ? '输入图层' : role}
      rules={[{ required: true, message: '请选择当前场景中的图层' }]}>
      <Select showSearch optionFilterProp="label" placeholder="选择当前场景中的图层"
        options={layers.map(layer => ({ label: layer.name, value: layer.fileId }))}
        onChange={() => {
          for (const field of Object.keys(definition.fields ?? {})) form.setFieldValue([role, field], undefined);
        }} />
    </Form.Item>
    {details?.fileId === fileId && details?.error && <Alert showIcon type="error" title={details.error} />}
    {dataset && !matchesGeometry &&
      <Alert showIcon type="warning" title={definition.geometryTypes.every(type => type.endsWith('Polygon'))
        ? '请选择面图层' : '该图层的几何类型与算子要求不符'} />}
    {Object.entries(definition.fields ?? {}).map(([field, info]) => {
      const names = (matchesGeometry && dataset && (info.type === 'numeric' ? dataset.numericFields : dataset.fields)) || [];
      return <Form.Item key={field} name={[role, field]} label={info.description}
        rules={[{ required: info.required, message: '请选择' + info.description }]}>
        <Select showSearch optionFilterProp="label" allowClear={!info.required} disabled={!names.length}
          loading={!!fileId && details?.fileId !== fileId}
          placeholder={matchesGeometry && !names.length && info.type === 'numeric' ? '此图层没有可用的数值字段' : '选择字段'}
          options={names.map(name => ({ label: name, value: name }))} />
      </Form.Item>;
    })}
  </>;
}

export function ModelRunForm({ sceneId, model, layers, trial, busy, disabled, onRun }: {
  sceneId: string; model: ProfessionalModel; layers: ModelLayer[]; trial?: boolean; busy: boolean;
  disabled?: boolean; onRun: (inputs: ModelInputs) => void;
}) {
  const roles = Object.entries(model.operator.inputs);
  return <Form layout="vertical" disabled={disabled || busy || !layers.length} onFinish={onRun}>
    {!layers.length && <Alert type="info" showIcon title="请先向当前场景上传图层" />}
    {roles.map(([role, definition]) => <LayerBinding key={role} role={role} definition={definition}
      single={roles.length === 1} sceneId={sceneId} layers={layers} />)}
    <Button type="primary" htmlType="submit" loading={busy}>{trial ? '开始试跑' : '运行模型'}</Button>
  </Form>;
}
