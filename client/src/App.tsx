import React, { useState } from 'react';
import './App.css';
import MainLayout from './layouts/MainLayout';
import LeftPanel from './features/workspace/components/LeftPanel';
import SplitTablePanel from './features/table/components/SplitTablePanel';
import DataPivot from './features/table/components/DataPivot';
import MapView from './features/map/components/MapView';
import GeoAIAgent from './features/agent/components/GeoAIAgent';
import { geoService, type PaginatedGeoResponse } from './services/geoService';
import { App as AntdApp } from 'antd';

// 多文件 Tab 条目类型
export interface FileTabInfo {
    fileId: string;
    fileName: string;
    data: any[];
    pagination?: { total: number; page: number; pageSize: number; totalPages: number };
}

// 地图多图层信息类型
export interface FileLayerInfo {
    fileId: string;
    fileName: string;
    totalFeatures: number;
}

function App() {
    const { message, modal } = AntdApp.useApp();

    // 已加载的文件数据 (按文件名索引)
    const [uploadedFilesData, setUploadedFilesData] = React.useState<Record<string, PaginatedGeoResponse>>({});

    // 选中的所有文件 ID 列表（多图层分析用）
    const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
    // 选中的所有文件完整信息（含文件名）
    const [selectedFilesInfo, setSelectedFilesInfo] = useState<{ fileId: string; fileName: string }[]>([]);

    // 当前激活的主文件（表格/地图主视窗）
    const [activeFileId, setActiveFileId] = useState<string>('');
    const [activeFileName, setActiveFileName] = useState<string>('');

    // 选中的地图要素（表格 ↔ 地图联动）
    const [selectedFeature, setSelectedFeature] = useState<any>(null);

    // AI 侧边栏开关
    const [aiPanelOpen, setAiPanelOpen] = useState<boolean>(false);

    // 当前主文件数据快捷引用
    const currentData = uploadedFilesData[activeFileName];

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
        try {
            message.loading({ content: '加载数据中...', key: 'loading' });
            const res = await geoService.getFileData(fileId, page, pageSize);
            setUploadedFilesData(prev => ({ ...prev, [fileName]: res }));
            message.success({ content: `加载第 ${page} 页成功`, key: 'loading' });
            return res;
        } catch (err: any) {
            console.error(err);
            message.error({ content: '数据加载失败', key: 'loading' });
        }
    };

    // ===== 回调函数 =====
    const handleDataLoaded = (fileName: string, data: any, fileId: string) => {
        setUploadedFilesData(prev => ({ ...prev, [fileName]: data }));
        setActiveFileName(fileName);
        setActiveFileId(fileId);
    };

    const handlePageChange = async (page: number, pageSize: number) => {
        if (!activeFileId || !activeFileName) return;
        await loadFileData(activeFileId, activeFileName, page, pageSize);
    };

    const handleDataChange = async (recordId: string | number, newRowData: any) => {
        if (!activeFileName || !currentData) return;
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
            [activeFileName]: { ...prev[activeFileName], features: newFeatures }
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
                <input
                    className="border p-1 w-full text-blue-100"
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
                    [activeFileName]: { ...prevData[activeFileName], features: updatedFeatures }
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
                if (!uploadedFilesData[fname]) return loadFileData(fid, fname, 1, 20);
                return Promise.resolve();
            })
        );
    };

    // 构造传给 DataPivot 的多文件数据对象
    const selectedFilesData: FileTabInfo[] = selectedFilesInfo.map(f => ({
        fileId: f.fileId,
        fileName: f.fileName,
        data: uploadedFilesData[f.fileName]?.features || [],
        pagination: uploadedFilesData[f.fileName]?.pagination,
    }));

    // 构造传给 MapView 的多图层信息
    const mapLayersInfo: FileLayerInfo[] = selectedFilesInfo.map(f => ({
        fileId: f.fileId,
        fileName: f.fileName,
        totalFeatures: uploadedFilesData[f.fileName]?.pagination?.total ?? 0,
    }));

    return (
        <MainLayout
            selectedFileIds={selectedFileIds}
            aiPanelOpen={aiPanelOpen}
            onToggleAI={() => setAiPanelOpen(p => !p)}
        >
            {/* 左侧：资源管理 + 分析工具 */}
            <LeftPanel
                onDataLoaded={handleDataLoaded}
                onSelectFiles={handleSelectFiles}
                selectedFileIds={selectedFileIds}
                activeFileId={activeFileId}
                activeFileFields={activeFileFields}
            />

            {/* 中间：多文件属性表 */}
            <SplitTablePanel>
                <DataPivot
                    data={currentData?.features || []}
                    fileName={activeFileName}
                    fileId={activeFileId}
                    pagination={currentData?.pagination}
                    onPageChange={handlePageChange}
                    onRowClick={(record) => setSelectedFeature(record)}
                    selectedFeature={selectedFeature}
                    onDataChange={handleDataChange}
                    onAddRow={handleAddRow}
                    onDeleteRow={handleDeleteRow}
                    onAddColumn={handleAddColumn}
                    onDeleteColumn={handleDeleteColumn}
                    onRenameColumn={handleRenameColumn}
                    // 多文件 Tab 支持
                    selectedFilesData={selectedFilesData}
                    onFileTabChange={async (fileId, fileName) => {
                        setActiveFileId(fileId);
                        setActiveFileName(fileName);
                        if (!uploadedFilesData[fileName]) {
                            await loadFileData(fileId, fileName, 1, 20);
                        }
                    }}
                />
            </SplitTablePanel>

            {/* 右侧：地图（多图层 + MVT）*/}
            <MapView
                data={currentData ? { type: 'FeatureCollection', features: currentData.features } : null}
                fileName={activeFileName}
                fileId={activeFileId}
                selectedFeature={selectedFeature}
                onFeatureClick={(feature) => setSelectedFeature(feature)}
                selectedFilesInfo={mapLayersInfo}
            />

            {/* AI 侧边栏（嵌入 MainLayout 右侧） */}
            <GeoAIAgent
                selectedFileIds={selectedFileIds}
                isOpen={aiPanelOpen}
                onClose={() => setAiPanelOpen(false)}
            />
        </MainLayout>
    );
}

export default App;