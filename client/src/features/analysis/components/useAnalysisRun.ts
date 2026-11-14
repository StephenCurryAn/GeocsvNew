import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelRun, createRun, downloadArtifactCsv, fetchArtifact, fetchArtifactGeoJSON,
  fetchArtifactRows, fetchRun, fetchRuns, getRequestErrorMessage,
  type ResultChartType, type Run, type SpatialPivotArtifact, type SpatialPivotGeoJSON, type SpatialPivotRow,
  type SpatialPivotSpec,
} from '../../../services/spatialPivotService';
import { useRunHistoryStore } from '../../../stores/useRunHistoryStore';

const TERMINAL_STATUSES = new Set<Run['status']>(['succeeded', 'failed', 'cancelled']);
const MAP_PREVIEW_LIMIT = 5000;

export type { ResultChartType } from '../../../services/spatialPivotService';

export const useAnalysisRun = () => {
  const selectionEpoch = useRef(0);
  const [selectionVersion, setSelectionVersion] = useState(0);
  const beginSelection = useCallback(() => {
    const version = ++selectionEpoch.current;
    setSelectionVersion(version);
    return version;
  }, []);
  const [run, setRun] = useState<Run | null>(null);
  const runHistory = useRunHistoryStore(state => state.runHistory);
  const setRunHistory = useRunHistoryStore(state => state.setRunHistory);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [artifact, setArtifact] = useState<SpatialPivotArtifact | null>(null);
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [artifactError, setArtifactError] = useState<string | null>(null);
  const [rows, setRows] = useState<SpatialPivotRow[]>([]);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [tablePage, setTablePage] = useState(1);
  const [tablePageSize, setTablePageSize] = useState(20);
  const [geoJSON, setGeoJSON] = useState<SpatialPivotGeoJSON | null>(null);
  const [mapMessage, setMapMessage] = useState<string | null>(null);
  const [selectedFeatureId, setSelectedFeatureId] = useState<number | null>(null);
  const [chartType, setChartType] = useState<ResultChartType>('bar');
  const [resultOpen, setResultOpen] = useState(false);
  const [csvDownloading, setCsvDownloading] = useState(false);
  const [artifactReload, setArtifactReload] = useState(0);
  const runId = run?.id;
  const runStatus = run?.status;
  const runArtifactId = run?.artifactId;
  const artifactId = artifact?.id;
  const artifactTotalRows = artifact?.totalRows;
  const activeRun = run && !TERMINAL_STATUSES.has(run.status) ? run : null;

  useEffect(() => {
    const controller = new AbortController();
    setHistoryLoading(true);
    fetchRuns(20, controller.signal)
      .then(setRunHistory)
      .catch(error => { if (!controller.signal.aborted) setRequestError(getRequestErrorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setHistoryLoading(false); });
    return () => controller.abort();
  }, [setRunHistory]);

  useEffect(() => {
    if (!runId || !runStatus || TERMINAL_STATUSES.has(runStatus)) return;
    const controller = new AbortController();
    const version = selectionVersion;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const latest = await fetchRun(runId, controller.signal);
        if (controller.signal.aborted || selectionEpoch.current !== version) return;
        setRequestError(null);
        setRun(latest);
        setRunHistory(previous => [latest, ...previous.filter(item => item.id !== latest.id)].slice(0, 20));
      } catch (error) {
        if (!controller.signal.aborted && selectionEpoch.current === version) setRequestError(`读取任务状态失败：${getRequestErrorMessage(error)}`);
      }
      if (!controller.signal.aborted && selectionEpoch.current === version) timer = window.setTimeout(poll, 1500);
    };
    timer = window.setTimeout(poll, 1000);
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [runId, runStatus, selectionVersion, setRunHistory]);

  useEffect(() => {
    if (runStatus !== 'succeeded' || !runArtifactId) return;
    const controller = new AbortController();
    setArtifact(null);
    setArtifactError(null);
    setArtifactLoading(true);
    setResultError(null);
    setRows([]);
    setRowsError(null);
    setGeoJSON(null);
    setMapMessage(null);
    setTablePage(1);
    setSelectedFeatureId(null);
    setResultOpen(true);
    fetchArtifact(runArtifactId, controller.signal)
      .then(setArtifact)
      .catch(error => { if (!controller.signal.aborted) setArtifactError(getRequestErrorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setArtifactLoading(false); });
    return () => controller.abort();
  }, [runId, runStatus, runArtifactId, artifactReload]);

  useEffect(() => {
    if (!artifactId) return;
    const controller = new AbortController();
    setRowsLoading(true);
    setRows([]);
    setRowsError(null);
    fetchArtifactRows(artifactId, tablePage, tablePageSize, controller.signal)
      .then(result => { setRows(result.rows); setTablePage(result.page); setTablePageSize(result.pageSize); })
      .catch(error => { if (!controller.signal.aborted) setRowsError(`读取结果表失败：${getRequestErrorMessage(error)}`); })
      .finally(() => { if (!controller.signal.aborted) setRowsLoading(false); });
    return () => controller.abort();
  }, [artifactId, tablePage, tablePageSize]);

  useEffect(() => {
    if (!artifactId || artifactTotalRows === undefined) return;
    if (artifactTotalRows > MAP_PREVIEW_LIMIT) {
      setGeoJSON(null);
      setMapMessage(`结果包含 ${artifactTotalRows} 个目标要素，超过首期地图预览上限 ${MAP_PREVIEW_LIMIT}；表格和 CSV 导出仍可使用。`);
      return;
    }
    const controller = new AbortController();
    setMapMessage('正在加载地图预览…');
    fetchArtifactGeoJSON(artifactId, controller.signal)
      .then(result => { setGeoJSON(result); setMapMessage(null); })
      .catch(error => {
        if (!controller.signal.aborted) {
          setGeoJSON(null);
          setMapMessage(`地图预览加载失败：${getRequestErrorMessage(error)}`);
        }
      });
    return () => controller.abort();
  }, [artifactId, artifactTotalRows]);

  const start = useCallback(async (spec: SpatialPivotSpec) => {
    const version = beginSelection();
    setRequestError(null);
    setResultError(null);
    setArtifact(null);
    setResultOpen(false);
    const created = await createRun(spec);
    if (selectionEpoch.current === version) setRun(created);
    setRunHistory(previous => [created, ...previous.filter(item => item.id !== created.id)].slice(0, 20));
    return created;
  }, [beginSelection, setRunHistory]);

  const restoreRun = useCallback((selected: Run) => {
    beginSelection();
    setRequestError(null);
    setArtifact(null);
    setRun(selected);
    setResultOpen(selected.status === 'succeeded' && Boolean(selected.artifactId));
    if (selected.status === 'succeeded' && selected.artifactId) setArtifactReload(value => value + 1);
    else setArtifact(null);
  }, [beginSelection]);

  const restoreExistingRun = useCallback(async (id: string, expectedArtifactId: string) => {
    const version = beginSelection();
    setRequestError(null);
    const existing = await fetchRun(id);
    if (selectionEpoch.current !== version) return false;
    if (existing.status !== 'succeeded' || !existing.artifactId) throw new Error('指定任务没有可复用的已完成结果');
    if (existing.artifactId !== expectedArtifactId) throw new Error('自然语言计划返回的结果 ID 与任务记录不一致');
    setRun(existing);
    setArtifact(null);
    setRunHistory(previous => [existing, ...previous.filter(item => item.id !== existing.id)].slice(0, 20));
    setResultOpen(true);
    setArtifactReload(value => value + 1);
    return true;
  }, [beginSelection, setRunHistory]);

  const cancel = useCallback(async () => {
    if (!activeRun) return;
    const version = selectionEpoch.current;
    setCancelling(true);
    setRequestError(null);
    try {
      await cancelRun(activeRun.id);
      const latest = await fetchRun(activeRun.id);
      if (selectionEpoch.current === version) setRun(latest);
      setRunHistory(previous => [latest, ...previous.filter(item => item.id !== latest.id)]);
    } catch (error) {
      if (selectionEpoch.current === version) setRequestError(`取消任务失败：${getRequestErrorMessage(error)}`);
    } finally { setCancelling(false); }
  }, [activeRun, setRunHistory]);

  const changePage = useCallback((page: number, pageSize: number) => {
    setRows([]);
    setTablePage(page);
    setTablePageSize(pageSize);
  }, []);

  const exportCsv = useCallback(async () => {
    if (!artifact) return;
    setCsvDownloading(true);
    try { await downloadArtifactCsv(artifact.id); }
    catch (error) { setResultError(`CSV 导出失败：${getRequestErrorMessage(error)}`); }
    finally { setCsvDownloading(false); }
  }, [artifact]);

  const retryArtifact = useCallback(() => setArtifactReload(value => value + 1), []);

  return {
    run, runHistory, historyLoading, requestError, setRequestError, resultError, setResultError,
    activeRun, cancelling, artifact, artifactLoading, artifactError, rows, rowsError, rowsLoading,
    tablePage, tablePageSize, geoJSON, mapMessage, selectedFeatureId, setSelectedFeatureId, chartType, setChartType,
    resultOpen, setResultOpen, csvDownloading, start, restoreRun, restoreExistingRun,
    cancel, changePage, exportCsv, retryArtifact,
  };
};

export type AnalysisRunController = ReturnType<typeof useAnalysisRun>;
