import { useEffect, useRef, useState } from 'react';
import { Alert, Empty, Pagination, Radio, Table, Typography, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import ReactECharts from 'echarts-for-react';
import maplibregl from 'maplibre-gl';
import { bbox } from '@turf/turf';
import type { ResultChartType, SpatialPivotArtifact, SpatialPivotGeoJSON, SpatialPivotRow } from '../../../services/spatialPivotService';

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

const maxResultTotal = (geoJSON: SpatialPivotGeoJSON | null): number => Math.max(
  1,
  ...(geoJSON?.features || []).map(feature => Number(feature.properties?.total) || 0),
);

const resultFillColor = (maxTotal: number, selectedId: number | null): maplibregl.ExpressionSpecification => [
  'case',
  ['==', ['to-number', ['get', 'featureId']], selectedId ?? -1], '#fbbf24',
  ['interpolate', ['linear'], ['to-number', ['get', 'total'], 0], 0, '#083344', maxTotal, '#22d3ee'],
];

const PIE_PALETTE = ['#22d3ee', '#a78bfa', '#34d399', '#fb923c', '#60a5fa', '#f472b6', '#a3e635', '#facc15'];
const pieColorForFeature = (featureId: number): string => PIE_PALETTE[((featureId % PIE_PALETTE.length) + PIE_PALETTE.length) % PIE_PALETTE.length];

const SpatialResultMap = ({
  geoJSON,
  mapMessage,
  selectedFeatureId,
  onSelectFeature,
}: Pick<SpatialPivotResultProps, 'geoJSON' | 'mapMessage' | 'selectedFeatureId' | 'onSelectFeature'>) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const onSelectRef = useRef(onSelectFeature);
  const [loadedMap, setLoadedMap] = useState<maplibregl.Map | null>(null);
  const maxTotal = maxResultTotal(geoJSON);
  const fillColorRef = useRef(resultFillColor(maxTotal, selectedFeatureId));

  useEffect(() => {
    onSelectRef.current = onSelectFeature;
  }, [onSelectFeature]);

  useEffect(() => {
    fillColorRef.current = resultFillColor(maxTotal, selectedFeatureId);
    const map = mapRef.current;
    if (map && map === loadedMap && map.isStyleLoaded() && map.getLayer('spatial-pivot-fill')) {
      map.setPaintProperty('spatial-pivot-fill', 'fill-color', fillColorRef.current);
    }
  }, [loadedMap, maxTotal, selectedFeatureId]);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {},
        layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0b1121' } }],
      },
      center: [0, 0],
      zoom: 1,
      attributionControl: false,
    });
    mapRef.current = map;
    map.on('load', () => {
      if (mapRef.current === map) setLoadedMap(map);
    });
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = loadedMap;
    if (!map || mapRef.current !== map || !map.isStyleLoaded()) return;
    if (!geoJSON) {
      const source = map.getSource('spatial-pivot-result');
      if (source) (source as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
      return;
    }

    if (!map.getSource('spatial-pivot-result')) {
      map.addSource('spatial-pivot-result', { type: 'geojson', data: geoJSON });
      map.addLayer({
        id: 'spatial-pivot-fill',
        type: 'fill',
        source: 'spatial-pivot-result',
        paint: {
          'fill-color': fillColorRef.current,
          'fill-opacity': 0.4,
        },
      });
      map.addLayer({
        id: 'spatial-pivot-outline',
        type: 'line',
        source: 'spatial-pivot-result',
        paint: { 'line-color': '#67e8f9', 'line-width': 1.5 },
      });
      map.on('click', 'spatial-pivot-fill', event => {
        const featureId = Number(event.features?.[0]?.properties?.featureId);
        if (Number.isFinite(featureId)) onSelectRef.current(featureId);
      });
      map.on('mouseenter', 'spatial-pivot-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', 'spatial-pivot-fill', () => { map.getCanvas().style.cursor = ''; });
    } else {
      const source = map.getSource('spatial-pivot-result');
      if (source) (source as maplibregl.GeoJSONSource).setData(geoJSON);
    }

    if (geoJSON.features.length > 0) {
      try {
        const [minX, minY, maxX, maxY] = bbox(geoJSON);
        if ([minX, minY, maxX, maxY].every(Number.isFinite)) {
          map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 24, maxZoom: 14, duration: 0 });
        }
      } catch {
        // Keep the preview usable when an output contains invalid or empty geometry.
      }
    }
  }, [geoJSON, loadedMap]);

  return (
    <div className="space-y-2">
      {mapMessage && <Alert type="info" showIcon title={mapMessage} />}
      <div className="relative">
        <div ref={containerRef} className="h-72 w-full overflow-hidden rounded-lg border border-geo-border" aria-label="空间透视结果地图" />
        {!geoJSON && !mapMessage && (
          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-geo-panel">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可预览地图" />
          </div>
        )}
      </div>
      {geoJSON && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-geo-text-secondary" aria-label="地图颜色图例">
          <span>总量</span>
          <span className="h-2.5 w-24 rounded-sm" style={{ background: 'linear-gradient(90deg, #083344, #22d3ee)' }} />
          <span>0</span><span>{maxTotal}</span>
          <span className="ml-2 inline-block h-2.5 w-2.5 rounded-sm bg-amber-400" />
          <span>当前选中</span>
        </div>
      )}
    </div>
  );
};

const SpatialPivotResult = ({
  artifact,
  rows,
  page,
  pageSize,
  rowsLoading,
  rowsError,
  onPageChange,
  geoJSON,
  mapMessage,
  selectedFeatureId,
  onSelectFeature,
  chartType = 'bar',
  onChartTypeChange,
}: SpatialPivotResultProps) => {
  const columns: ColumnsType<SpatialPivotRow> = [
    { title: '目标要素', dataIndex: 'label', key: 'label', fixed: 'left', width: 180, ellipsis: true },
    ...artifact.columns.map(column => ({
      title: column.label,
      key: column.key,
      width: 110,
      render: (_: unknown, row: SpatialPivotRow) => row.counts[column.key] ?? 0,
    })),
    { title: '合计', dataIndex: 'total', key: 'total', width: 90 },
  ];

  const pageTotal = rows.reduce((sum, row) => sum + row.total, 0);
  const labelCounts = new Map<string, number>();
  rows.forEach(row => labelCounts.set(row.label, (labelCounts.get(row.label) || 0) + 1));
  const chartData = rows.map(row => ({
    value: row.total,
    name: chartType === 'pie' && (labelCounts.get(row.label) || 0) > 1 ? `${row.label} (#${row.featureId})` : row.label,
    itemStyle: {
      color: row.featureId === selectedFeatureId ? '#fbbf24' : chartType === 'pie' ? pieColorForFeature(row.featureId) : '#22d3ee',
    },
  }));
  const showPieLegend = rows.length <= 6;
  const { token } = theme.useToken();
  const chartOption = chartType === 'pie' ? {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'item' },
    ...(showPieLegend ? { legend: { orient: 'horizontal', bottom: 0, textStyle: { color: token.colorTextSecondary, fontSize: 10 } } } : {}),
    series: [{
      type: 'pie',
      radius: showPieLegend ? '54%' : '68%',
      center: showPieLegend ? ['50%', '43%'] : ['50%', '50%'],
      stillShowZeroSum: false,
      label: { show: true, color: token.colorText, fontSize: 11, formatter: '{b}: {d}%' },
      data: chartData,
    }],
  } : {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis' },
    grid: { left: 90, right: 24, top: 20, bottom: 36 },
    xAxis: chartType === 'bar'
      ? { type: 'value', axisLabel: { color: token.colorTextSecondary }, splitLine: { lineStyle: { color: token.colorSplit } } }
      : { type: 'category', data: rows.map(row => row.label), axisLabel: { color: token.colorTextSecondary, width: 140, overflow: 'truncate', rotate: 25 } },
    yAxis: chartType === 'bar'
      ? { type: 'category', data: rows.map(row => row.label), axisLabel: { color: token.colorTextSecondary, width: 140, overflow: 'truncate' } }
      : { type: 'value', axisLabel: { color: token.colorTextSecondary }, splitLine: { lineStyle: { color: token.colorSplit } } },
    series: [{ type: chartType, data: chartData }],
  };
  const chartEvents = {
    click: (event: { dataIndex?: number }) => {
      const row = typeof event.dataIndex === 'number' ? rows[event.dataIndex] : undefined;
      if (row) onSelectFeature(row.featureId);
    },
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="rounded-md bg-geo-dark p-2"><span className="text-geo-text-secondary">目标要素</span><div className="mt-1 text-geo-text-primary">{artifact.summary.targetCount}</div></div>
        <div className="rounded-md bg-geo-dark p-2"><span className="text-geo-text-secondary">关联要素</span><div className="mt-1 text-geo-text-primary">{artifact.summary.joinCount}</div></div>
        <div className="rounded-md bg-geo-dark p-2"><span className="text-geo-text-secondary">空间匹配对</span><div className="mt-1 text-geo-text-primary">{artifact.summary.matchedPairs}</div></div>
      </div>

      <section>
        <div className="mb-1 flex items-center justify-between">
          <Typography.Text className="text-geo-text-primary">目标要素总量</Typography.Text>
          <Typography.Text className="text-xs text-geo-text-secondary">图表使用当前第 {page} 页的 {rows.length} 条结果</Typography.Text>
        </div>
        {onChartTypeChange && <Radio.Group size="small" className="mb-2" value={chartType} onChange={event => onChartTypeChange(event.target.value as ResultChartType)} optionType="button" options={[{ label: '柱状', value: 'bar' }, { label: '折线', value: 'line' }, { label: '饼图', value: 'pie' }]} />}
        {rows.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前页没有结果" /> : chartType === 'pie' && pageTotal === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前页合计为 0，暂无占比" /> : <ReactECharts option={chartOption} onEvents={chartEvents} style={{ height: 260 }} notMerge />}
      </section>

      <section>
        <Typography.Text className="mb-2 block text-geo-text-primary">结果地图</Typography.Text>
        <SpatialResultMap
          geoJSON={geoJSON}
          mapMessage={mapMessage}
          selectedFeatureId={selectedFeatureId}
          onSelectFeature={onSelectFeature}
        />
      </section>

      <section>
        <Typography.Text className="mb-2 block text-geo-text-primary">统计明细</Typography.Text>
        {rowsError && <Alert className="mb-2" type="error" showIcon title={rowsError} />}
        <Table<SpatialPivotRow>
          size="small"
          rowKey="featureId"
          loading={rowsLoading}
          columns={columns}
          dataSource={rows}
          scroll={{ x: 'max-content', y: 320 }}
          pagination={false}
          onRow={row => ({
            onClick: () => onSelectFeature(row.featureId),
            className: row.featureId === selectedFeatureId ? 'bg-geo-accent/15' : 'cursor-pointer',
          })}
        />
        <Pagination
          className="mt-3 text-right"
          size="small"
          current={page}
          pageSize={pageSize}
          total={artifact.totalRows}
          showSizeChanger
          pageSizeOptions={[10, 20, 50, 100]}
          onChange={onPageChange}
        />
      </section>
    </div>
  );
};

export default SpatialPivotResult;
