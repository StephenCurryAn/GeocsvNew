import React, { useCallback, useRef, useState } from 'react';
import './App.css';
import MainLayout from './layouts/MainLayout';
import LeftPanel from './features/workspace/components/LeftPanel';
import SplitTablePanel from './features/table/components/SplitTablePanel';
import DataPivot from './features/table/components/DataPivot';
import MapView, { type DrawStatus, type FileLayerInfo } from './features/map/components/MapView';
import type { SelectionStyle } from './features/map/fileLayers';
import { featureId, replacePageSelection, selectedFromTable, selectionKey, toggleFeature, type SelectedFeature } from './features/map/featureSelection';
import { readLayerOrder, readSelectionStyle, saveLayerOrder, saveSelectionStyle } from './features/workspace/scenePreferences';
import AnalysisAssistant from './features/agent/components/AnalysisAssistant';
import { useAnalysisWorkspace } from './features/analysis/components/AnalysisWorkspace';
import ProfessionalModels from './features/analysis/components/ProfessionalModels';
import { geoService, type PaginatedGeoResponse } from './services/geoService';
import { App as AntdApp, Input } from 'antd';

type LayerMetadata = Pick<FileLayerInfo, 'totalFeatures' | 'loadFailed' | 'tileVersion' | 'geometryTypes'>;
const EMPTY_FEATURES: GeoJSON.Feature[] = [];

function App() {
    const { message, modal } = AntdApp.useApp();
    const { changeView } = useAnalysisWorkspace();

    // 已加载的文件数据以稳定的文件 ID 索引，避免同名文件共用缓存。
    const [uploadedFilesData, setUploadedFilesData] = React.useState<Record<string, PaginatedGeoResponse>>({});
    const loadVersionByFileRef = useRef<Record<string, number>>({});
    const [activeSceneId, setActiveSceneId] = useState('');

    // 选中的所有文件 ID 列表（多图层分析用）
    const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
    // 选中的所有文件完整信息（含文件名）
    const [selectedFilesInfo, setSelectedFilesInfo] = useState<{ fileId: string; fileName: string }[]>([]);

    // 当前激活的主文件（表格/地图主视窗）
    const [activeFileId, setActiveFileId] = useState<string>('');
    const [activeFileName, setActiveFileName] = useState<string>('');
    const [layerFocus, setLayerFocus] = useState<{ fileId: string } | null>(null);
    const featureLookup = useRef<AbortController | null>(null);
    const [hiddenFileIds, setHiddenFileIds] = useState<string[]>([]);
    const [drawStatuses, setDrawStatuses] = useState<Record<string, DrawStatus>>({});
    const [sceneLayerOrder, setSceneLayerOrder] = useState<Record<string, string[]>>({});
    const [selectionStyle, setSelectionStyle] = useState(readSelectionStyle);

    const reportDrawStatus = useCallback((fileId: string, status?: DrawStatus) => {
        setDrawStatuses(prev => {
            if (prev[fileId] === status) return prev;
            const next = { ...prev };
            if (status) next[fileId] = status;
            else delete next[fileId];
            return next;
        });
    }, []);
    const toggleFileVisibility = (fileId: string) => setHiddenFileIds(prev =>
        prev.includes(fileId) ? prev.filter(id => id !== fileId) : [...prev, fileId]);

    // 选中的地图要素（表格 ↔ 地图联动）
    const [selectedFeatures, setSelectedFeatures] = useState<SelectedFeature[]>([]);
    const [focusedFeatureKey, setFocusedFeatureKey] = useState<string | null>(null);
    const [featureFocus, setFeatureFocus] = useState<SelectedFeature[] | null>(null);
    const [mapRowId, setMapRowId] = useState<string | null>(null);
    const focusedFeature = selectedFeatures.find(item => selectionKey(item) === focusedFeatureKey) ?? selectedFeatures.at(-1);
    const cancelFeatureLookup = () => {
        featureLookup.current?.abort();
        featureLookup.current = null;
    };
    const clearFeatureSelection = () => {
        cancelFeatureLookup();
        setSelectedFeatures([]);
        setFocusedFeatureKey(null);
        setFeatureFocus(null);
        setMapRowId(null);
    };

    // 地图只在文件选择、要素总数或加载状态变化时更新图层列表。
    const [layerMetadata, setLayerMetadata] = useState<Record<string, LayerMetadata>>({});
    const updateLayerMetadata = (fileId: string, metadata: LayerMetadata) => {
        setLayerMetadata(prev => {
            const current = prev[fileId] ?? {};
            const next = { ...current, ...metadata };
            if (current.totalFeatures === next.totalFeatures && current.loadFailed === next.loadFailed
                && current.tileVersion === next.tileVersion && current.geometryTypes === next.geometryTypes) return prev;
            return { ...prev, [fileId]: next };
        });
    };
    const refreshMapTiles = (fileId: string) => updateLayerMetadata(fileId, { tileVersion: Date.now() });

    // 当前主文件数据快捷引用
    const currentData = uploadedFilesData[activeFileId];
    const currentFeatures: GeoJSON.Feature[] = currentData?.features ?? EMPTY_FEATURES;
    const tableSelection = React.useMemo(() => new Set(selectedFeatures
        .filter(item => item.fileId === activeFileId).map(item => item.id)), [selectedFeatures, activeFileId]);

    // 当前文件的字段列表（传给左侧分析面板）
    const activeFileFields = React.useMemo(() => {
        if (currentData?.features?.length > 0) {
            return Object.keys(currentData.features[0].properties || {}).filter(
                k => !['_geometry', 'cp', '_lat', '_lng', '_geom_coords'].includes(k)
            );
        }
        return [];
    }, [currentData]);

    // ===== 数据加载 =====
    const loadFileData = async (
        fileId: string, fileName: string, page = 1, pageSize = 20, featureId?: number, signal?: AbortSignal,
    ) => {
        const requestVersion = (loadVersionByFileRef.current[fileId] || 0) + 1;
        loadVersionByFileRef.current[fileId] = requestVersion;
        if (!uploadedFilesData[fileId]) updateLayerMetadata(fileId, { loadFailed: false });
        try {
            const res = await geoService.getFileData(fileId, page, pageSize, activeSceneId || undefined, featureId, signal,
                !layerMetadata[fileId]?.geometryTypes);
            if (signal?.aborted) return;
            if (loadVersionByFileRef.current[fileId] !== requestVersion) return res;
            setUploadedFilesData(prev => ({ ...prev, [fileId]: res }));
            updateLayerMetadata(fileId, { totalFeatures: res.pagination.total, loadFailed: false,
                ...(res.geometryTypes ? { geometryTypes: res.geometryTypes } : {}) });
            return res;
        } catch (err: any) {
            if (signal?.aborted || loadVersionByFileRef.current[fileId] !== requestVersion) return;
            console.error(err);
            if (!uploadedFilesData[fileId]) updateLayerMetadata(fileId, { loadFailed: true });
            if (featureId !== undefined) message.warning(`无法在“${fileName}”的属性表中定位此要素`);
            else if (fileId === activeFileId) message.error(`“${fileName}”数据加载失败`);
        }
    };

    // ===== 回调函数 =====
    const handlePageChange = async (page: number, pageSize: number) => {
        if (!activeFileId || !activeFileName) return;
        cancelFeatureLookup();
        setMapRowId(null);
        await loadFileData(activeFileId, activeFileName, page, pageSize);
    };

    const handleDataChange = async (recordId: string | number, newRowData: any) => {
        if (!activeFileId || !activeFileName || !currentData) return;
        const oldFeatures = [...currentData.features];
        const targetIndex = oldFeatures.findIndex((f: any) =>
            String(f.id ?? f.properties?.id) === String(recordId)
        );
        if (targetIndex === -1) return;
        const oldFeature = oldFeatures[targetIndex];
        const newFeature = { ...oldFeature, properties: { ...oldFeature.properties, ...newRowData } };
        delete newFeature.properties._geometry;
        const newFeatures = [...oldFeatures];
        newFeatures[targetIndex] = newFeature;
        setUploadedFilesData(prev => ({
            ...prev,
            [activeFileId]: { ...prev[activeFileId], features: newFeatures }
        }));
        try {
            message.loading({ content: '保存中...', key: 'save' });
            await geoService.updateFileData(activeFileId, recordId, newRowData);
            refreshMapTiles(activeFileId);
            message.success({ content: '已保存', key: 'save' });
        } catch (error) {
            message.error({ content: '保存失败', key: 'save' });
            handlePageChange(currentData.pagination.page, currentData.pagination.pageSize);
        }
    };

    const handleAddRow = async () => {
        if (!activeFileId) return;
        try {
            message.loading({ content: '正在添加行...', key: 'row-op' });
            await geoService.addRow(activeFileId);
            refreshMapTiles(activeFileId);
            message.success({ content: '新增成功', key: 'row-op' });
            if (currentData) handlePageChange(currentData.pagination.page, currentData.pagination.pageSize);
        } catch (e: any) {
            message.error({ content: e.message, key: 'row-op' });
        }
    };

    const handleDeleteRow = async (recordID: string | number) => {
        if (!activeFileId) return;
        try {
            message.loading({ content: '正在删除行...', key: 'row-op' });
            await geoService.deleteRow(activeFileId, recordID);
            setSelectedFeatures(prev => prev.filter(item => item.fileId !== activeFileId || item.id !== String(recordID)));
            refreshMapTiles(activeFileId);
            message.success({ content: '删除成功', key: 'row-op' });
            if (currentData) handlePageChange(currentData.pagination.page, currentData.pagination.pageSize);
        } catch (e: any) {
            message.error({ content: e.message, key: 'row-op' });
        }
    };

    const handleAddColumn = () => {
        if (!activeFileId) return;
        let value = '';
        modal.confirm({
            title: '新增列',
            content: (
                <Input
                    placeholder="请输入新列名 (英文)"
                    onChange={(e) => value = e.target.value}
                />
            ),
            onOk: async () => {
                if (!value) return message.warning('列名不能为空');
                try {
                    message.loading({ content: '正在添加列...', key: 'col-op' });
                    await geoService.addColumn(activeFileId, value);
                    refreshMapTiles(activeFileId);
                    message.success({ content: '添加成功', key: 'col-op' });
                    if (currentData) handlePageChange(currentData.pagination.page, currentData.pagination.pageSize);
                } catch (e: any) {
                    message.error({ content: e.message, key: 'col-op' });
                }
            }
        });
    };

    const handleDeleteColumn = async (fieldName: string) => {
        if (!activeFileId) return;
        try {
            message.loading({ content: '正在删除列...', key: 'col-op' });
            await geoService.deleteColumn(activeFileId, fieldName);
            refreshMapTiles(activeFileId);
            message.success({ content: '删除成功', key: 'col-op' });
            if (currentData) handlePageChange(currentData.pagination.page, currentData.pagination.pageSize);
        } catch (e: any) {
            message.error({ content: e.message, key: 'col-op' });
        }
    };

    // 🌟 新增：批量删除列的处理函数
    const handleDeleteColumns = async (fieldNames: string[]) => {
        if (!activeFileId || fieldNames.length === 0) return;
        try {
            message.loading({ content: `正在批量删除 ${fieldNames.length} 列...`, key: 'col-op' });
            
            // 使用 Promise.all 并发调用现有的单列删除接口
            await Promise.all(fieldNames.map(fieldName => geoService.deleteColumn(activeFileId, fieldName)));
            refreshMapTiles(activeFileId);
            
            message.success({ content: '批量删除成功', key: 'col-op' });
            // 刷新当前页的数据
            if (currentData) handlePageChange(currentData.pagination.page, currentData.pagination.pageSize);
        } catch (e: any) {
            message.error({ content: e.message || '批量删除列失败', key: 'col-op' });
        }
    };

    const handleRenameColumn = async (oldName: string, newName: string) => {
        if (!activeFileId) { message.error("未选中文件"); return; }
        try {
            message.loading({ content: '正在重命名列...', key: 'renameMsg' });
            await geoService.renameColumn(activeFileId, oldName, newName);
            refreshMapTiles(activeFileId);
            if (currentData?.features) {
                const updatedFeatures = currentData.features.map((feature: any) => {
                    const properties = { ...feature.properties };
                    if (oldName in properties) {
                        properties[newName] = properties[oldName];
                        delete properties[oldName];
                    }
                    return { ...feature, properties };
                });
                setUploadedFilesData((prevData: any) => ({
                    ...prevData,
                    [activeFileId]: { ...prevData[activeFileId], features: updatedFeatures }
                }));
            }
            message.success({ content: `列名 [${oldName}] 已重命名为 [${newName}]`, key: 'renameMsg' });
        } catch (error: any) {
            message.error({ content: error.message || '重命名失败', key: 'renameMsg' });
        }
    };

    // ===== 多文件选择 =====
    const handleSelectFiles = async (fileNames: string[], fileIds: string[]) => {
        setSelectedFileIds(fileIds);
        setSelectedFilesInfo(fileNames.map((n, i) => ({ fileId: fileIds[i], fileName: n })));
        setSelectedFeatures(prev => prev.filter(item => fileIds.includes(item.fileId)));
        setHiddenFileIds(prev => {
            const remaining = prev.filter(id => fileIds.includes(id));
            return remaining.length === prev.length ? prev : remaining;
        });

        if (fileIds.length === 0) {
            clearFeatureSelection();
            setActiveFileId('');
            setActiveFileName('');
            setLayerFocus(null);
            return;
        }

        const added = fileIds.filter(id => !selectedFileIds.includes(id));
        const primaryId = added.at(-1) ?? (fileIds.includes(activeFileId) ? activeFileId : fileIds.at(-1)!);
        const primaryName = fileNames[fileIds.indexOf(primaryId)];
        setActiveFileName(primaryName);
        setActiveFileId(primaryId);
        if (primaryId !== activeFileId) {
            cancelFeatureLookup();
            setLayerFocus(added.includes(primaryId) ? { fileId: primaryId } : null);
            setMapRowId(null);
            setFeatureFocus(null);
            if (added.includes(primaryId)) changeView('map');
        }

        // 并行加载所有未缓存文件的第一页
        await Promise.all(
            fileIds.map((fid, i) => {
                const fname = fileNames[i];
                if (!uploadedFilesData[fid]) return loadFileData(fid, fname, 1, 20);
                return Promise.resolve();
            })
        );
    };

    const activateFile = (fileId: string, fileName: string) => {
        cancelFeatureLookup();
        changeView('map');
        setLayerFocus({ fileId });
        setMapRowId(null);
        setFeatureFocus(null);
        if (fileId !== activeFileId) {
            setActiveFileId(fileId);
            setActiveFileName(fileName);
        }
        if (!uploadedFilesData[fileId] && (fileId !== activeFileId || layerMetadata[fileId]?.loadFailed)) {
            void loadFileData(fileId, fileName);
        }
    };

    const handleMapFeature = (feature: SelectedFeature | null, additive: boolean) => {
        setLayerFocus(null);
        setFeatureFocus(null);
        if (!feature) {
            if (!additive) clearFeatureSelection();
            return;
        }
        const { fileId, id } = feature;
        const layer = selectedFilesInfo.find(item => item.fileId === fileId);
        if (!layer) return;
        const key = selectionKey(feature);
        if (additive && selectedFeatures.some(item => selectionKey(item) === key)) {
            setSelectedFeatures(prev => toggleFeature(prev, feature, true));
            setMapRowId(null);
            return;
        }
        if (!additive || fileId !== activeFileId) cancelFeatureLookup();
        setActiveFileId(fileId);
        setActiveFileName(layer.fileName);
        setFocusedFeatureKey(key);
        setMapRowId(id);
        const page = uploadedFilesData[fileId];
        const match = page?.features.find(item => featureId(item) === id);
        const canonical = match ? { ...selectedFromTable(fileId, match), anchor: feature.anchor } : feature;
        setSelectedFeatures(prev => toggleFeature(prev, canonical, additive));
        if (!match) {
            const controller = new AbortController();
            featureLookup.current = controller;
            void loadFileData(fileId, layer.fileName, 1, page?.pagination.pageSize ?? 20, Number(id), controller.signal)
                .then(result => {
                    const row = result?.features.find(item => featureId(item) === id);
                    if (row) setSelectedFeatures(prev => prev.map(item => selectionKey(item) === key
                        ? { ...selectedFromTable(fileId, row), anchor: item.anchor } : item));
                })
                .finally(() => { if (featureLookup.current === controller) featureLookup.current = null; });
        }
    };

    const handleTableRow = (id: string, additive: boolean) => {
        const row = currentFeatures.find(item => featureId(item) === id);
        if (!row) return;
        const feature = selectedFromTable(activeFileId, row);
        const key = selectionKey(feature);
        cancelFeatureLookup();
        setLayerFocus(null);
        setMapRowId(null);
        setFocusedFeatureKey(key);
        setSelectedFeatures(prev => toggleFeature(prev, feature, additive));
        setFeatureFocus(additive && tableSelection.has(id) ? null
            : toggleFeature(selectedFeatures, feature, additive).filter(item => !hiddenFileIds.includes(item.fileId)));
    };

    const handleTableChecks = (ids: string[]) => {
        cancelFeatureLookup();
        setLayerFocus(null);
        setMapRowId(null);
        const additions = ids.filter(id => !tableSelection.has(id));
        const nextFocus = currentFeatures.find(row => featureId(row) === additions.at(-1));
        const feature = nextFocus ? selectedFromTable(activeFileId, nextFocus) : null;
        const checkedIds = new Set(ids);
        setSelectedFeatures(prev => replacePageSelection(prev, activeFileId, currentFeatures, checkedIds));
        if (feature) setFocusedFeatureKey(selectionKey(feature));
        setFeatureFocus(feature
            ? replacePageSelection(selectedFeatures, activeFileId, currentFeatures, checkedIds)
                .filter(item => !hiddenFileIds.includes(item.fileId))
            : null);
    };

    const reorderLayers = (order: string[]) => {
        saveLayerOrder(activeSceneId, order);
        setSceneLayerOrder(prev => ({ ...prev, [activeSceneId]: order }));
    };
    const changeSelectionStyle = (style: SelectionStyle) => {
        saveSelectionStyle(style);
        setSelectionStyle(style);
    };

    const layerOrder = React.useMemo(() => {
        const saved = sceneLayerOrder[activeSceneId] ?? readLayerOrder(activeSceneId);
        return [...saved.filter(id => selectedFileIds.includes(id)), ...selectedFileIds.filter(id => !saved.includes(id))];
    }, [activeSceneId, sceneLayerOrder, selectedFileIds]);
    const mapLayersInfo = React.useMemo<FileLayerInfo[]>(() => {
        const files = new Map(selectedFilesInfo.map(file => [file.fileId, file]));
        return layerOrder.flatMap(id => {
            const file = files.get(id);
            return file ? [{ ...file, ...layerMetadata[id] }] : [];
        });
    }, [selectedFilesInfo, layerOrder, layerMetadata]);
    const workspaceLayers = React.useMemo(() => Object.fromEntries(mapLayersInfo.map(file => [file.fileId, {
        totalFeatures: file.totalFeatures,
        loadFailed: file.loadFailed,
        hidden: hiddenFileIds.includes(file.fileId),
        drawStatus: drawStatuses[file.fileId],
        geometryTypes: layerMetadata[file.fileId]?.geometryTypes,
    }])), [mapLayersInfo, hiddenFileIds, drawStatuses, layerMetadata]);
    const mapData = React.useMemo(() => currentData
        ? { type: 'FeatureCollection', features: currentData.features }
        : null, [currentData]);

    return (
        <MainLayout
            workspace={
                <LeftPanel
                    onSelectFiles={handleSelectFiles}
                    onSceneChange={scene => setActiveSceneId(scene.id)}
                    onActivateFile={activateFile}
                    onToggleFileVisibility={toggleFileVisibility}
                    layers={workspaceLayers}
                    layerOrder={layerOrder}
                    onReorderLayers={reorderLayers}
                    selectionStyle={selectionStyle}
                    onSelectionStyleChange={changeSelectionStyle}
                    selectedFileIds={selectedFileIds}
                    activeFileId={activeFileId}
                    activeFileFields={activeFileFields}
                />
            }
            models={<ProfessionalModels key={activeSceneId} sceneId={activeSceneId} />}
            map={
                <MapView
                    data={mapData}
                    fileId={activeFileId}
                    sceneId={activeSceneId}
                    layerFocus={layerFocus}
                    selectedFeatures={selectedFeatures}
                    focusedFeature={focusedFeature}
                    featureFocus={featureFocus}
                    selectionStyle={selectionStyle}
                    onFeatureClick={handleMapFeature}
                    hiddenFileIds={hiddenFileIds}
                    onDrawStatusChange={reportDrawStatus}
                    selectedFilesInfo={mapLayersInfo}
                />
            }
            table={
                <SplitTablePanel>
                    <DataPivot
                        data={currentFeatures}
                        fileName={activeFileName}
                        fileId={activeFileId}
                        pagination={currentData?.pagination}
                        emptyMessage={activeFileId
                            ? layerMetadata[activeFileId]?.loadFailed
                                ? '数据加载失败，请重新选择文件'
                                : currentData ? '暂无属性数据' : '正在读取属性数据…'
                            : undefined}
                        onPageChange={handlePageChange}
                        onRowClick={handleTableRow}
                        onCheckedRowsChange={handleTableChecks}
                        selectedIds={tableSelection}
                        scrollToId={mapRowId}
                        onClearSelection={clearFeatureSelection}
                        onDataChange={handleDataChange}
                        onAddRow={handleAddRow}
                        onDeleteRow={handleDeleteRow}
                        onAddColumn={handleAddColumn}
                        onDeleteColumn={handleDeleteColumn}
                        onDeleteColumns={handleDeleteColumns}
                        onRenameColumn={handleRenameColumn}
                    />
                </SplitTablePanel>
            }
            assistant={<AnalysisAssistant sceneId={activeSceneId} selectedFileIds={selectedFileIds} />}
        />
    );
}

export default App;
