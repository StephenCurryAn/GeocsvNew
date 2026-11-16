import { useEffect, useMemo, useRef } from 'react';
import { Alert, Empty, Pagination, Segmented, Spin, Table, theme } from 'antd';
import type { ColumnsType, TableRef } from 'antd/es/table';
import type { EChartsOption } from 'echarts';
import ReactECharts from 'echarts-for-react';
import { usePanelSize } from '../../../layouts/usePanelSize';
import type { ResultChartType, SpatialPivotArtifact, SpatialPivotGeoJSON, SpatialPivotRow } from '../../../services/spatialPivotService';
import SpatialResultMap from './SpatialResultMap';

interface SpatialPivotResultProps {
  artifact: SpatialPivotArtifact;
  rows: SpatialPivotRow[];
  page: number;
  pageSize: number;
  rowsLoading: boolean;
  rowsError?: string | null;
  onPageChange: (page: number, pageSize: number) => void;
  geoJSON: SpatialPivotGeoJSON | null;
  mapMessage: string | null;
  selectedFeatureId: number | null;
  onSelectFeature: (featureId: number) => void;
  chartType?: ResultChartType;
  onChartTypeChange?: (type: ResultChartType) => void;
}

const countFormat = new Intl.NumberFormat('zh-CN');
const PIE_COLORS = ['#5b83a2', '#8b9975', '#aa8376', '#7c80aa', '#998469', '#589087'];
const CHART_TYPES = [{ label: '柱状', value: 'bar' }, { label: '折线', value: 'line' }, { label: '占比', value: 'pie' }] as const;
const CHART_REPLACE = ['series', 'xAxis', 'yAxis'];

const SpatialPivotResult = ({
  artifact, rows, page, pageSize, rowsLoading, rowsError, onPageChange, geoJSON, mapMessage,
  selectedFeatureId, onSelectFeature, chartType = 'bar', onChartTypeChange,
}: SpatialPivotResultProps) => {
  const { token } = theme.useToken();
  const dark = token.colorBgBase === '#000';
  const chartColor = dark ? '#85abc7' : '#507f9e';
  const selectionColor = dark ? '#ecad81' : '#ab5f3c';
  const table = useRef<TableRef>(null);
  const tableViewport = useRef<HTMLDivElement>(null);
  const { height: tableHeight } = usePanelSize(tableViewport);

  const columns = useMemo<ColumnsType<SpatialPivotRow>>(() => [
    { title: '目标要素', dataIndex: 'label', key: 'label', fixed: 'left', width: 140, ellipsis: true },
    ...artifact.columns.map(column => ({
      title: column.label,
      key: column.key,
      width: 96,
      ellipsis: true,
      align: 'right' as const,
      render: (_: unknown, row: SpatialPivotRow) => countFormat.format(row.counts[column.key] ?? 0),
    })),
    { title: '合计', dataIndex: 'total', key: 'total', width: 76, align: 'right', render: value => countFormat.format(value) },
  ], [artifact.columns]);

  useEffect(() => {
    if (selectedFeatureId != null && rows.some(row => row.featureId === selectedFeatureId)) {
      table.current?.scrollTo({ key: selectedFeatureId });
    }
  }, [rows, selectedFeatureId]);

  const pageTotal = rows.reduce((sum, row) => sum + row.total, 0);
  const chartOption = useMemo<EChartsOption>(() => {
    const labelCounts = new Map<string, number>();
    for (const row of rows) labelCounts.set(row.label, (labelCounts.get(row.label) ?? 0) + 1);
    const data = rows.map(row => ({
      value: row.total,
      name: chartType === 'pie' && (labelCounts.get(row.label) ?? 0) > 1 ? row.label + ' #' + row.featureId : row.label,
      // ECharts uses names as pie identifiers. Preserve distinct slices for repeated labels.
      id: String(row.featureId),
      itemStyle: {
        color: row.featureId === selectedFeatureId
          ? selectionColor
          : chartType === 'pie' ? PIE_COLORS[((row.featureId % PIE_COLORS.length) + PIE_COLORS.length) % PIE_COLORS.length] : chartColor,
      },
    }));
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const common: EChartsOption = {
      animation: !reduced,
      animationDuration: 220,
      animationDurationUpdate: 150,
      textStyle: { fontFamily: 'Inter, Segoe UI, Microsoft YaHei, sans-serif' },
      tooltip: {
        trigger: 'item',
        confine: true,
        backgroundColor: token.colorBgElevated,
        borderColor: token.colorBorderSecondary,
        textStyle: { color: token.colorText, fontSize: 12 },
      },
    };

    if (chartType === 'pie') {
      return {
        ...common,
        series: [{
          id: 'result-pie', type: 'pie', radius: ['43%', '73%'], center: ['50%', '50%'],
          stillShowZeroSum: false, data,
          itemStyle: { borderRadius: 3, borderWidth: 2, borderColor: token.colorBgContainer },
          label: { show: rows.length <= 8, color: token.colorTextSecondary, formatter: '{b} {d}%', fontSize: 11 },
          labelLayout: { hideOverlap: true },
        }],
      };
    }

    const horizontal = chartType === 'bar';
    const labels = rows.map(row => row.label);
    const valueAxis = {
      type: 'value' as const,
      minInterval: 1,
      axisLabel: { color: token.colorTextSecondary, fontSize: 11 },
      splitLine: { lineStyle: { color: token.colorSplit, type: 'dashed' as const } },
    };
    const labelAxis = {
      type: 'category' as const,
      data: labels,
      inverse: horizontal,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: token.colorBorderSecondary } },
      axisLabel: { color: token.colorTextSecondary, fontSize: 11, width: horizontal ? 80 : 66, overflow: 'truncate' as const },
    };
    return {
      ...common,
      grid: { left: 10, right: 32, top: 12, bottom: 12, containLabel: true },
      xAxis: horizontal ? valueAxis : labelAxis,
      yAxis: horizontal ? labelAxis : valueAxis,
      series: horizontal
        ? [{
          id: 'result-bars', type: 'bar', data, barMaxWidth: 16,
          itemStyle: { borderRadius: [0, 4, 4, 0] },
          label: { show: true, position: 'right', color: token.colorTextSecondary, fontSize: 11 },
        }]
        : [{
          id: 'result-line', type: 'line', data, symbolSize: 7,
          lineStyle: { color: chartColor, width: 2 },
        }],
    };
  }, [rows, chartType, selectedFeatureId, chartColor, selectionColor, token]);

  const chartEvents = useMemo(() => ({
    click: (event: { dataIndex?: number }) => {
      const row = event.dataIndex == null ? undefined : rows[event.dataIndex];
      if (row) onSelectFeature(row.featureId);
    },
  }), [rows, onSelectFeature]);

  return (
    <div className="spatial-results">
      <dl className="spatial-result-summary" aria-label="结果摘要">
        <div><dt>目标面</dt><dd>{countFormat.format(artifact.summary.targetCount)}</dd></div>
        <div><dt>关联点</dt><dd>{countFormat.format(artifact.summary.joinCount)}</dd></div>
        <div><dt>空间匹配对</dt><dd>{countFormat.format(artifact.summary.matchedPairs)}</dd></div>
      </dl>

      <div className="spatial-result-grid">
        <SpatialResultMap
          geoJSON={geoJSON}
          message={mapMessage}
          selectedFeatureId={selectedFeatureId}
          onSelectFeature={onSelectFeature}
          dark={dark}
        />

        <div className="spatial-result-inspector">
          <section className="spatial-result-panel spatial-result-chart" aria-label="目标要素合计">
            <header className="spatial-result-panel-heading">
              <div>
                <h3>目标要素合计</h3>
                <span className="spatial-result-muted">当前页 · {rows.length} 条</span>
              </div>
              {onChartTypeChange && (
                <Segmented<ResultChartType>
                  aria-label="结果图表类型" size="small" options={CHART_TYPES.map(option => ({ ...option }))}
                  value={chartType} onChange={onChartTypeChange}
                />
              )}
            </header>
            <div className="spatial-result-plot">
              {rowsLoading || rows.length === 0 || (chartType === 'pie' && pageTotal === 0) ? (
                <div className="spatial-result-placeholder">
                  {rowsLoading ? <Spin /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={rows.length ? '当前页合计为 0，暂无占比' : '当前页没有结果'} />}
                </div>
              ) : (
                <ReactECharts
                  option={chartOption}
                  onEvents={chartEvents}
                  style={{
                    height: '100%',
                    width: '100%',
                    minHeight: chartType === 'bar' ? rows.length * 23 + 28 : undefined,
                    minWidth: chartType === 'line' && rows.length > 8 ? rows.length * 45 : undefined,
                  }}
                  replaceMerge={CHART_REPLACE}
                  lazyUpdate
                />
              )}
            </div>
          </section>

          <section className="spatial-result-panel spatial-result-table" aria-label="统计明细">
            <header className="spatial-result-panel-heading">
              <h3>统计明细</h3>
              <span className="spatial-result-muted">共 {countFormat.format(artifact.totalRows)} 条</span>
            </header>
            {rowsError && <Alert className="spatial-result-table-error" type="error" showIcon title={rowsError} />}
            <div className="spatial-result-table-viewport" ref={tableViewport}>
              <Table<SpatialPivotRow>
                ref={table}
                size="small"
                rowKey="featureId"
                loading={rowsLoading}
                columns={columns}
                dataSource={rows}
                scroll={{ x: 'max-content', y: Math.max(68, tableHeight - 36) }}
                pagination={false}
                locale={{ emptyText: '暂无明细' }}
                onRow={row => ({
                  'aria-selected': row.featureId === selectedFeatureId,
                  className: 'spatial-result-row',
                  onClick: () => onSelectFeature(row.featureId),
                  onKeyDown: event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onSelectFeature(row.featureId);
                    }
                  },
                  tabIndex: 0,
                })}
              />
            </div>
            <div className="spatial-result-pagination">
              <Pagination
                size="small" current={page} pageSize={pageSize} total={artifact.totalRows}
                showLessItems showSizeChanger pageSizeOptions={[10, 20, 50, 100]} onChange={onPageChange}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

export default SpatialPivotResult;
