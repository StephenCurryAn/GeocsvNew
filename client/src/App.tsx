import React, { useRef, useState } from 'react';
import './App.css';
import MainLayout from './layouts/MainLayout';
import LeftPanel from './features/workspace/components/LeftPanel';
import SplitTablePanel from './features/table/components/SplitTablePanel';
import DataPivot from './features/table/components/DataPivot';
import MapView, { type FileLayerInfo } from './features/map/components/MapView';
import GeoAIAgent from './features/agent/components/GeoAIAgent';
import { geoService, type PaginatedGeoResponse } from './services/geoService';
import { App as AntdApp, Input } from 'antd';

// 多文件 Tab 条目类型
export interface FileTabInfo {
    fileId: string;
    fileName: string;
    data: any[];
    pagination?: { total: number; page: number; pageSize: number; totalPages: number };
}

type LayerMetadata = Pick<FileLayerInfo, 'totalFeatures' | 'loadFailed' | 'tileVersion'>;

function App() {
    const { message, modal } = AntdApp.useApp();

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
    const [focusFileId, setFocusFileId] = useState('');

    // 选中的地图要素（表格 ↔ 地图联动）
    const [selectedFeature, setSelectedFeature] = useState<any>(null);
    const [selectionOrigin, setSelectionOrigin] = useState<'map' | 'table'>('table');

    // 地图只在文件选择、要素总数或加载状态变化时更新图层列表。
    const [layerMetadata, setLayerMetadata] = useState<Record<string, LayerMetadata>>({});
    const updateLayerMetadata = (fileId: string, metadata: LayerMetadata) => {
        setLayerMetadata(prev => {
            const current = prev[fileId] ?? {};
            const next = { ...current, ...metadata };
            if (current.totalFeatures === next.totalFeatures && current.loadFailed === next.loadFailed && current.tileVersion === next.tileVersion) return prev;
            return { ...prev, [fileId]: next };
        });
    };
    const refreshMapTiles = (fileId: string) => updateLayerMetadata(fileId, { tileVersion: Date.now() });

    // 当前主文件数据快捷引用
    const currentData = uploadedFilesData[activeFileId];

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
    const loadFileData = async (fileId: string, fileName: string, page = 1, pageSize = 20, featureId?: number) => {
        const requestVersion = (loadVersionByFileRef.current[fileId] || 0) + 1;
        loadVersionByFileRef.current[fileId] = requestVersion;
        if (!uploadedFilesData[fileId]) updateLayerMetadata(fileId, { loadFailed: false });
        try {
            const res = await geoService.getFileData(fileId, page, pageSize, undefined, featureId);
            if (loadVersionByFileRef.current[fileId] !== requestVersion) return;
            setUploadedFilesData(prev => ({ ...prev, [fileId]: res }));
            updateLayerMetadata(fileId, { totalFeatures: res.pagination.total, loadFailed: false });
            return res;
        } catch (err: any) {
            if (loadVersionByFileRef.current[fileId] !== requestVersion) return;
            console.error(err);
            if (!uploadedFilesData[fileId]) updateLayerMetadata(fileId, { loadFailed: true });
            if (featureId !== undefined) message.warning(`无法在“${fileName}”的属性表中定位此要素`);
            else if (fileId === activeFileId) message.error(`“${fileName}”数据加载失败`);
        }
    };

    // ===== 回调函数 =====
    const handleDataLoaded = (fileName: string, data: any, fileId: string) => {
        loadVersionByFileRef.current[fileId] = (loadVersionByFileRef.current[fileId] || 0) + 1;
        setUploadedFilesData(prev => ({ ...prev, [fileId]: data }));
        updateLayerMetadata(fileId, { totalFeatures: data.pagination.total });
        setActiveFileName(fileName);
        setActiveFileId(fileId);
        setFocusFileId(fileId);
        setSelectedFeature(null);
    };

    const handlePageChange = async (page: number, pageSize: number) => {
        if (!activeFileId || !activeFileName) return;
        setSelectedFeature(null);
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

        if (fileIds.length === 0) {
            setActiveFileId('');
            setActiveFileName('');
            setFocusFileId('');
            setSelectedFeature(null);
            return;
        }

        const added = fileIds.filter(id => !selectedFileIds.includes(id));
        const primaryId = added.at(-1) ?? (fileIds.includes(activeFileId) ? activeFileId : fileIds.at(-1)!);
        const primaryName = fileNames[fileIds.indexOf(primaryId)];
        setActiveFileName(primaryName);
        setActiveFileId(primaryId);
        if (primaryId !== activeFileId) {
            setFocusFileId(added.includes(primaryId) ? primaryId : '');
            setSelectedFeature(null);
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

    const activateFileTab = (fileId: string, fileName: string) => {
        if (fileId === activeFileId) return;
        setActiveFileId(fileId);
        setActiveFileName(fileName);
        setFocusFileId('');
        setSelectedFeature(null);
        if (!uploadedFilesData[fileId]) void loadFileData(fileId, fileName);
    };

    const handleMapFeature = (fileId: string, feature: Record<string, unknown> | null) => {
        if (!feature) {
            setSelectedFeature(null);
            return;
        }
        const layer = selectedFilesInfo.find(item => item.fileId === fileId);
        if (!layer) return;
        setActiveFileId(fileId);
        setActiveFileName(layer.fileName);
        setFocusFileId('');
        setSelectionOrigin('map');
        setSelectedFeature(feature);
        const page = uploadedFilesData[fileId];
        if (page?.features.some(item => String(item.id ?? item.properties?.id) === String(feature.id))) {
            // A slower lookup for a previous click must not replace the page already showing this feature.
            loadVersionByFileRef.current[fileId] = (loadVersionByFileRef.current[fileId] || 0) + 1;
        } else {
            void loadFileData(fileId, layer.fileName, 1, page?.pagination.pageSize ?? 20, Number(feature.id));
        }
    };

    // 构造传给 DataPivot 的多文件数据对象
    const selectedFilesData: FileTabInfo[] = selectedFilesInfo.map(f => ({
        fileId: f.fileId,
        fileName: f.fileName,
        data: uploadedFilesData[f.fileId]?.features || [],
        pagination: uploadedFilesData[f.fileId]?.pagination,
    }));

    const mapLayersInfo = React.useMemo<FileLayerInfo[]>(() => {
        const files = activeFileId && !selectedFilesInfo.some(file => file.fileId === activeFileId)
            ? [...selectedFilesInfo, { fileId: activeFileId, fileName: activeFileName }]
            : selectedFilesInfo;
        return files.map(file => ({ ...file, ...layerMetadata[file.fileId] }));
    }, [selectedFilesInfo, activeFileId, activeFileName, layerMetadata]);
    const mapData = React.useMemo(() => currentData
        ? { type: 'FeatureCollection', features: currentData.features }
        : null, [currentData]);

    return (
        <MainLayout
            workspace={
                <LeftPanel
                    onDataLoaded={handleDataLoaded}
                    onSelectFiles={handleSelectFiles}
                    onSceneChange={scene => setActiveSceneId(scene.id)}
                    selectedFileIds={selectedFileIds}
                    activeFileId={activeFileId}
                    activeFileFields={activeFileFields}
                />
            }
            map={
                <MapView
                    data={mapData}
                    fileId={activeFileId}
                    focusFileId={focusFileId}
                    selectedFeature={selectedFeature}
                    selectionOrigin={selectionOrigin}
                    onFeatureClick={handleMapFeature}
                    onFileTabChange={activateFileTab}
                    selectedFilesInfo={mapLayersInfo}
                />
            }
            table={
                <SplitTablePanel>
                    <DataPivot
                        data={currentData?.features || []}
                        fileName={activeFileName}
                        fileId={activeFileId}
                        pagination={currentData?.pagination}
                        emptyMessage={activeFileId
                            ? layerMetadata[activeFileId]?.loadFailed
                                ? '数据加载失败，请重新选择文件'
                                : currentData ? '暂无属性数据' : '正在读取属性数据…'
                            : undefined}
                        onPageChange={handlePageChange}
                        onRowClick={feature => {
                            setSelectionOrigin('table');
                            setSelectedFeature(feature);
                        }}
                        selectedFeature={selectedFeature}
                        scrollToSelectedFeature={selectionOrigin === 'map'}
                        onDataChange={handleDataChange}
                        onAddRow={handleAddRow}
                        onDeleteRow={handleDeleteRow}
                        onAddColumn={handleAddColumn}
                        onDeleteColumn={handleDeleteColumn}
                        onDeleteColumns={handleDeleteColumns}
                        onRenameColumn={handleRenameColumn}
                        selectedFilesData={selectedFilesData}
                        onFileTabChange={activateFileTab}
                    />
                </SplitTablePanel>
            }
            assistant={<GeoAIAgent sceneId={activeSceneId} selectedFileIds={selectedFileIds} />}
        />
    );
}

export default App;
