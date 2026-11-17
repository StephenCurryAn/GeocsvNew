import { Alert, Button, Pagination, Table } from 'antd';
import type { MoranArtifact, MoranRow } from '../../../services/analysisService';
import type { AnalysisRunController } from './useAnalysisRun';
import { LOCAL_ALPHA, MORAN_LABELS } from './moranPresentation';
import SpatialResultMap from './SpatialResultMap';

const format = (value: number | null) => value == null ? '—' : Number(value.toFixed(4)).toString();

export default function MoranResult({ artifact, analysis }: { artifact: MoranArtifact; analysis: AnalysisRunController }) {
  const { globalI, pValue, expectedI } = artifact.summary;
  const message = pValue == null ? '本次未进行置换检验。'
    : pValue > LOCAL_ALPHA ? '整张图的空间聚集未达到 5% 置换检验阈值。'
    : globalI > expectedI ? '相邻区域的指标整体倾向于相似，达到 5% 全局置换检验阈值。'
    : '相邻区域的指标整体倾向于不同，达到 5% 全局置换检验阈值。';
  const features = analysis.geoJSON?.features ?? [];
  const highClusters = features.filter(({ properties }) => properties?.quadrant === 'HH'
    && typeof properties.pValue === 'number' && properties.pValue <= LOCAL_ALPHA);
  const select = (featureId: number) => {
    analysis.setSelectedFeatureId(featureId);
    const index = features.findIndex(feature => Number(feature.properties?.featureId) === featureId);
    if (index >= 0) {
      const nextPage = Math.floor(index / analysis.tablePageSize) + 1;
      if (nextPage !== analysis.tablePage) analysis.changePage(nextPage, analysis.tablePageSize);
    }
  };
  const rows = analysis.rows.filter((row): row is MoranRow => 'localI' in row);

  return (
    <div className="spatial-results">
      <dl className="spatial-result-summary" aria-label="空间自相关摘要">
        <div><dt>全局 Moran’s I</dt><dd>{format(globalI)}</dd></div>
        <div><dt>全局置换 p 值</dt><dd>{format(pValue)}</dd></div>
        <div><dt>区域数</dt><dd>{artifact.totalRows}</dd></div>
        <div><dt>邻接规则</dt><dd>{artifact.spec.contiguity === 'queen' ? 'Queen' : 'Rook'}</dd></div>
      </dl>
      <Alert className="mb-2" type="info" showIcon title={message}
        description="地图用局部置换 p ≤ 0.05 标记候选区域。局部 p 值未经多重比较校正，用于探索。" />
      {analysis.geoJSON && (
        <section className="mb-3" aria-label="高—高候选区域">
          <strong className="text-sm">高—高候选区域 · {highClusters.length}</strong>
          <div className="mt-1 flex flex-wrap gap-1">
            {highClusters.length === 0 && <span className="text-sm text-geo-text-secondary">当前阈值下暂无高—高候选区域。</span>}
            {highClusters.map(feature => {
              const id = Number(feature.properties?.featureId);
              return <Button size="small" key={id} type={analysis.selectedFeatureId === id ? 'primary' : 'default'}
                onClick={() => select(id)}>{String(feature.properties?.label ?? '区域 ' + id)}</Button>;
            })}
          </div>
        </section>
      )}
      <div className="spatial-result-grid spatial-result-grid--moran">
        <SpatialResultMap geoJSON={analysis.geoJSON} message={analysis.mapMessage}
          selectedFeatureId={analysis.selectedFeatureId} onSelectFeature={select} variant="moran" />
        <section className="spatial-result-panel spatial-result-table" aria-label="社区局部统计">
          <header className="spatial-result-panel-heading"><h3>区域明细</h3></header>
          {analysis.rowsError && <Alert type="error" title={analysis.rowsError} />}
          <div className="spatial-result-table-viewport">
            <Table<MoranRow> size="small" rowKey="featureId" pagination={false} dataSource={rows} loading={analysis.rowsLoading}
            rowClassName={() => 'spatial-result-row'}
            onRow={row => ({
              'aria-selected': row.featureId === analysis.selectedFeatureId,
              onClick: () => select(row.featureId),
            })}
            columns={[
              { key: 'label', title: '区域', render: (_, row) => row.label ?? String(row.featureId) },
              { key: 'quadrant', title: '象限', render: (_, row) => row.quadrant == null ? '—' : MORAN_LABELS[row.quadrant] },
              { key: 'localI', title: '局部 I', render: (_, row) => format(row.localI) },
              { key: 'pValue', title: '局部 p 值', render: (_, row) => format(row.pValue) },
            ]} />
          </div>
          <div className="spatial-result-pagination">
            <Pagination size="small" current={analysis.tablePage} pageSize={analysis.tablePageSize}
              total={artifact.totalRows} onChange={analysis.changePage} />
          </div>
        </section>
      </div>
    </div>
  );
}
