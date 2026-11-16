import React, { useRef, useState } from 'react';
import './App.css';
import MainLayout from './layouts/MainLayout';
import type { ThemePreference } from './layouts/WorkbenchTheme';
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

type LayerMetadata = Pick<FileLayerInfo, 'totalFeatures' | 'loadFailed'>;

function App({ themePreference, onThemeChange }: {
    themePreference: ThemePreference;
    onThemeChange: (preference: ThemePreference) => void;
}) {
    const { message, modal } = AntdApp.useApp();

    // 已加载的文件数据以稳定的文件 ID 索引，避免同名文件共用缓存。
    const [uploadedFilesData, setUploadedFilesData] = React.useState<Record<string, PaginatedGeoResponse>>({});
    const loadVersionByFileRef = useRef<Record<string, number>>({});

    // 选中的所有文件 ID 列表（多图层分析用）
    const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
    // 选中的所有文件完整信息（含文件名）
    const [selectedFilesInfo, setSelectedFilesInfo] = useState<{ fileId: string; fileName: string }[]>([]);

    // 当前激活的主文件（表格/地图主视窗）
    const [activeFileId, setActiveFileId] = useState<string>('');
    const [activeFileName, setActiveFileName] = useState<string>('');

    // 选中的地图要素（表格 ↔ 地图联动）
    const [selectedFeature, setSelectedFeature] = useState<any>(null);

    // 地图只在文件选择、要素总数或加载状态变化时更新图层列表。
    const [layerMetadata, setLayerMetadata] = useState<Record<string, LayerMetadata>>({});
    const updateLayerMetadata = (fileId: string, metadata: LayerMetadata) => {
        setLayerMetadata(prev => {
            const current = prev[fileId];
            if (current?.totalFeatures === metadata.totalFeatures && current?.loadFailed === metadata.loadFailed) return prev;
            return { ...prev, [fileId]: metadata };
        });
    };

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
    const loadFileData = async (fileId: string, fileName: string, page = 1, pageSize = 20) => {
        const requestVersion = (loadVersionByFileRef.current[fileId] || 0) + 1;
        loadVersionByFileRef.current[fileId] = requestVersion;
        if (!uploadedFilesData[fileId]) updateLayerMetadata(fileId, {});
        const messageKey = `loading-${fileId}`;
        try {
            if (fileId === activeFileId) message.loading({ content: '加载数据中...', key: messageKey });
            const res = await geoService.getFileData(fileId, page, pageSize);
            if (loadVersionByFileRef.current[fileId] !== requestVersion) return;
            setUploadedFilesData(prev => ({ ...prev, [fileId]: res }));
            updateLayerMetadata(fileId, { totalFeatures: res.pagination.total });
            if (fileId === activeFileId) message.success({ content: `加载第 ${page} 页成功`, key: messageKey });
            return res;
        } catch (err: any) {
            if (loadVersionByFileRef.current[fileId] !== requestVersion) return;
            console.error(err);
            if (!uploadedFilesData[fileId]) updateLayerMetadata(fileId, { loadFailed: true });
            if (fileId === activeFileId) message.error({ content: `“${fileName}”数据加载失败`, key: messageKey });
        }
    };

    // ===== 回调函数 =====
    const handleDataLoaded = (fileName: string, data: any, fileId: string) => {
        loadVersionByFileRef.current[fileId] = (loadVersionByFileRef.current[fileId] || 0) + 1;
        setUploadedFilesData(prev => ({ ...prev, [fileId]: data }));
        updateLayerMetadata(fileId, { totalFeatures: data.pagination.total });
        setActiveFileName(fileName);
        setActiveFileId(fileId);
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
            f.properties?.id == recordId || f.id == recordId
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
            setSelectedFeature(null);
            return;
        }

        const primaryId = fileIds[fileIds.length - 1];
        const primaryName = fileNames[fileNames.length - 1];
        setActiveFileName(primaryName);
        setActiveFileId(primaryId);
        setSelectedFeature(null);

        // 并行加载所有未缓存文件的第一页
        await Promise.all(
            fileIds.map((fid, i) => {
                const fname = fileNames[i];
                if (!uploadedFilesData[fid]) return loadFileData(fid, fname, 1, 20);
                return Promise.resolve();
            })
        );
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
            themePreference={themePreference}
            onThemeChange={onThemeChange}
            workspace={
                <LeftPanel
                    onDataLoaded={handleDataLoaded}
                    onSelectFiles={handleSelectFiles}
                    selectedFileIds={selectedFileIds}
                    activeFileId={activeFileId}
                    activeFileFields={activeFileFields}
                />
            }
            map={
                <MapView
                    data={mapData}
                    fileName={activeFileName}
                    fileId={activeFileId}
                    selectedFeature={selectedFeature}
                    onFeatureClick={setSelectedFeature}
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
                        onRowClick={setSelectedFeature}
                        selectedFeature={selectedFeature}
                        onDataChange={handleDataChange}
                        onAddRow={handleAddRow}
                        onDeleteRow={handleDeleteRow}
                        onAddColumn={handleAddColumn}
                        onDeleteColumn={handleDeleteColumn}
                        onDeleteColumns={handleDeleteColumns}
                        onRenameColumn={handleRenameColumn}
                        selectedFilesData={selectedFilesData}
                        onFileTabChange={async (fileId, fileName) => {
                            setActiveFileId(fileId);
                            setActiveFileName(fileName);
                            setSelectedFeature(null);
                            if (!uploadedFilesData[fileId]) {
                                await loadFileData(fileId, fileName, 1, 20);
                            }
                        }}
                    />
                </SplitTablePanel>
            }
            assistant={<GeoAIAgent selectedFileIds={selectedFileIds} />}
        />
    );
}

export default App;
