import React, { useState } from 'react';
import './App.css';
import MainLayout from './layouts/MainLayout';
import LeftPanel from './features/workspace/components/LeftPanel';
import SplitTablePanel from './features/table/components/SplitTablePanel'; // 1. 引入分屏组件
import DataPivot from './features/table/components/DataPivot';
import MapView from './features/map/components/MapView';
import { geoService , type PaginatedGeoResponse} from './services/geoService';
// import { message, Modal } from 'antd';
import { App as AntdApp } from 'antd'; // 1. 引入 App 组件 (重命名为 AntdApp 避免冲突)

function App() {
    // 核心修改：使用 useApp Hook 获取带上下文的实例
    // 这样弹出的 message 和 modal 就会跟随全局主题（变黑），且不会报错
    const { message, modal } = AntdApp.useApp();

    //  存储已加载的文件数据 (包括分页信息)
    // 结构变为: { "文件名": { features: [...], pagination: {...}, type: 'FeatureCollection' } }
    const [uploadedFilesData, setUploadedFilesData] = React.useState<Record<string, PaginatedGeoResponse>>({});
    
    // 保存当前文件的 ID，用于后续发请求
    const [activeFileId, setActiveFileId] = useState<string>('');
    // 当前激活的文件名 (用户正在看哪个文件)
    const [activeFileName, setActiveFileName] = useState<string>('');
    // 当前选中的要素属性（从表格点出来的）
    const [selectedFeature, setSelectedFeature] = useState<any>(null);
    // 辅助: 获取当前文件的数据对象
    const currentData = uploadedFilesData[activeFileName];

    //  计算当前文件的字段列表 (传递给左侧分析面板用)
    // 使用 useMemo 防止频繁重算，或者直接在渲染时计算
    const activeFileFields = React.useMemo(() => {
        if (currentData && currentData.features && currentData.features.length > 0) {
            // 获取第一个要素的 properties 的 key
            return Object.keys(currentData.features[0].properties || {}).filter(k => 
                // 过滤掉我们自己加的内部字段
                !['_geometry', 'cp', '_lat', '_lng', '_geom_coords'].includes(k)
            );
        }
        return [];
    }, [currentData]);

    /**
    * 一些辅助函数
    */
    // // 重新加载数据 (复用 handleSelectFile 的逻辑，但简化版)
    // const refreshFileData = async (fileId: string, fileName: string) => {
    //     const res = await geoService.getFileContent(fileId);
    //     if (res.code === 200) {
    //         setUploadedFilesData(prev => ({ ...prev, [fileName]: res.data }));
    //     }
    // };

    //  加载/刷新数据 (支持分页)
    const loadFileData = async (fileId: string, fileName: string, page = 1, pageSize = 20) => {
        try {
            message.loading({ content: '加载数据中...', key: 'loading' });
            
            //  调用新的分页接口
            // 返回的是：
            //     const result = {
            //     type: 'FeatureCollection',
            //     features: features,  // 这里的features是筛选了分页之后的
            //     pagination: {
            //         total,
            //         page,
            //         pageSize,
            //         // Math.ceil（向上取整）
            //         totalPages: Math.ceil(total / pageSize)
            //     }
            // };
            const res = await geoService.getFileData(fileId, page, pageSize);
            
            setUploadedFilesData(prev => ({
                ...prev,
                [fileName]: res // 保存整个分页响应对象
            }));
            
            message.success({ content: `加载第 ${page} 页成功`, key: 'loading' });
            return res;
        } catch (err: any) {
            console.error(err);
            message.error({ content: '数据加载失败', key: 'loading' });
        }
    };

    /**
    * 一些回调函数，传给子组件
    * 
    * 在 React 中，数据是单向流动的（从父到子）。
    * 父组件 (App)：持有数据（State）。
    * 子组件 (DataPivot, LeftPanel)：只负责显示，没有权利直接修改父组件的数据。
    * 那子组件想修改数据怎么办？ 父组件会写好一个函数（比如 handleDataChange），
    * 然后像传递数据一样，把这个函数传给子组件。
    * 当子组件发生操作（比如用户填了表），子组件就“打电话”给父组件（调用这个函数），让父组件自己去改。
    * 这个“打电话”的过程，就是 Call Back（回调）。
    */

    // 回调函数，后面根据需要再写相关的功能，传给表格，地图组件等之类的
    // 处理数据加载
    const handleDataLoaded = (fileName: string, data: any, fileId: string) => {
        console.log(`文件 ${fileName} 加载成功`, data);
        // 存储上传的文件数据
        setUploadedFilesData(prev => ({
            ...prev,
            [fileName]: data
        }));
        // 这里可以更新地图和表格的数据
        // 例如：setGridData(data.features || data.rows);
        // 例如：setMapData(data);

        // 上传成功后，自动选中该文件
        setActiveFileName(fileName);
        // 这里面的fileId来源是后端数据库 (MongoDB) 在执行 fileNode.save() 时候
        // 就在这一刻，MongoDB 自动为这条数据生成了一个唯一的 _id（类似于 65a1b2c... 这种字符串）
        // 后端在保存成功后，会将这个 _id 包装在响应数据中发回给前端
        setActiveFileId(fileId);
    };

    // 处理文件选择
    const handleSelectFile = async (fileName: string, fileId?: string) => {
        console.log(`选择了文件: ${fileName}`);

        // 1. 设置当前激活的文件名
        setActiveFileName(fileName);
        // 如果有 fileId，保存下来！
        if (fileId) {
            setActiveFileId(fileId);
        }
        setSelectedFeature(null); // 切换文件时，清空选中的要素
        // 检查是否是已上传的文件
        if (uploadedFilesData[fileName]) {
            // 如果是已上传的文件，使用之前上传的数据
            console.log(`使用已上传的 ${fileName} 数据`, uploadedFilesData[fileName]);
            // 此处因为传给表格和地图组件的都是currentData=uploadedFilesData[activeFileName];
            // 所以直接return就行了，因为相应组件的data变了，所以相应的可视化会变
            return;
        }
        
        if (fileId) {
            //  默认加载第一页
            await loadFileData(fileId, fileName, 1, 20);
        }

        // // 2. 内存里没有，说明是刷新过，或者新登录的
        // // 这时候不应该报错，而是应该去后端“捞”数据
        // // 先检查 fileId 是否存在
        // if (!fileId) {
        //     console.warn(`文件 ${fileName} 没有 ID，无法从后端获取内容`);
        //     return; // 如果没有 ID，直接结束，不再调用 getFileContent
        // }
        // try {
        //     message.loading('正在加载数据...', 1);
        //     // 假设你已经在 geoService 里写好了 getFileContent 方法
        //     const res = await geoService.getFileContent(fileId); 
            
        //     if (res.code === 200) {
        //         // 3. 捞回来了！存入内存，下次就不用捞了
        //         setUploadedFilesData(prev => ({
        //             ...prev,
        //             [fileName]: res.data
        //         }));
                
        //         // 4. 渲染地图
        //         console.log('数据加载完成，开始渲染');
        //     }
        // } catch (err) {
        //     console.error('无法加载文件数据');
        // }
    };

    // 回调: 表格翻页
    const handlePageChange = async (page: number, pageSize: number) => {
        if (!activeFileId || !activeFileName) return;
        // 重新请求后端
        await loadFileData(activeFileId, activeFileName, page, pageSize);
    };

    // 处理表格数据修改
    const handleDataChange = async (recordId: string | number, newRowData: any) => {
        if (!activeFileName || !currentData) return;
        
        // 1. 乐观更新 (UI Update)
        // 只能更新当前页的数据
        const oldFeatures = [...currentData.features];
        const targetIndex = oldFeatures.findIndex((f: any) => 
            f.properties?.id == recordId || f.id == recordId
        );

        if (targetIndex === -1) return;

        // 构造新 Feature
        const oldFeature = oldFeatures[targetIndex];
        const newFeature = {
            ...oldFeature,
            properties: {
                ...oldFeature.properties,
                ...newRowData
            }
        };
        // 清理临时字段
        delete newFeature.properties._geometry;
        // delete newFeature.properties.cp;

        // 更新 State
        const newFeatures = [...oldFeatures];
        newFeatures[targetIndex] = newFeature;
        
        setUploadedFilesData(prev => ({
            ...prev,
            [activeFileName]: {
                ...prev[activeFileName],
                features: newFeatures
            }
        }));

        // 2. 发送请求
        try {
            message.loading({ content: '保存中...', key: 'save' });
            await geoService.updateFileData(activeFileId, recordId, newRowData);
            message.success({ content: '已保存', key: 'save' });
        } catch (error) {
            message.error({ content: '保存失败', key: 'save' });
            // 回滚逻辑 (简单重载当前页)
            handlePageChange(currentData.pagination.page, currentData.pagination.pageSize);
        }
    };

    // 1. 新增行处理
    const handleAddRow = async () => {
        if (!activeFileId) return;
        try {
            message.loading({ content: '正在添加行...', key: 'row-op' });
            // 这里的 res.data 通常是更新后的整个 features 数组或者新数据
            // 为了简单，我们直接重新加载一次整个文件，或者后端返回整个新数据
            await geoService.addRow(activeFileId);
            
            message.success({ content: '新增成功', key: 'row-op' });
            // 刷新当前页
            if (currentData) {
                handlePageChange(currentData.pagination.page, currentData.pagination.pageSize);
            }
        } catch (e: any) {
            message.error({ content: e.message, key: 'row-op' });
        }
    };

    // 2. 删除行处理
    const handleDeleteRow = async (recordID: string | number) => {
        if (!activeFileId) return;
        try {
            message.loading({ content: '正在删除行...', key: 'row-op' });
            await geoService.deleteRow(activeFileId, recordID);
            message.success({ content: '删除成功', key: 'row-op' });
            if (currentData) {
                handlePageChange(currentData.pagination.page, currentData.pagination.pageSize);
            }
        } catch (e: any) {
            message.error({ content: e.message, key: 'row-op' });
        }
    };

    // 3. 新增列处理
    const handleAddColumn = () => {
        if (!activeFileId) return;
        // 使用 Antd Modal 获取输入
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

    // 4. 删除列处理
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

    // 重命名列名
    const handleRenameColumn = async (oldName: string, newName: string) => {
        // 假设你有 fileId，如果没有，需要从当前的选中文件状态中获取
        if (!activeFileId) {
            message.error("未选中文件");
            return;
        }

        try {
            message.loading({ content: '正在修改列名...', key: 'renameMsg' });

            // 发送请求给后端持久化保存 (稍后在 geoService 中实现)
            await geoService.renameColumn(activeFileId, oldName, newName);
            
            //   本地乐观更新 (Optimistic UI update)
            // 不需要重新请求整个文件，直接修改前端内存里的数据，让表格瞬间刷新
            if (currentData && currentData.features) {
                const updatedFeatures = currentData.features.map((feature: any) => {
                    const properties = { ...feature.properties };
                    // 如果这个要素有旧字段，就把值赋给新字段，并删掉旧字段
                    if (oldName in properties) {
                        properties[newName] = properties[oldName];
                        delete properties[oldName];
                    }
                    return { ...feature, properties };
                });
                
                // 更新你的本地状态（假设你的 set 状态方法叫 setCurrentData）
                setUploadedFilesData((prevData: any) => ({
                    ...prevData, // 保留其他文件的完全不变
                    [activeFileName]: { 
                        ...prevData[activeFileName], // 保留当前文件的其他属性（如 type="FeatureCollection" 等）
                        features: updatedFeatures    // 替换更新后的 features 数组
                    }
                }));
            }

            message.success({ content: `列名 [${oldName}] 已修改为 [${newName}]`, key: 'renameMsg' });
        } catch (error: any) {
            console.error(error);
            message.error({ content: error.message || '修改列名失败', key: 'renameMsg' });
        }
    };

  return (
    <MainLayout>
      {/* 第 1 个子元素：左侧 */}
      <LeftPanel
        onDataLoaded={handleDataLoaded}
        onSelectFile={handleSelectFile}
        activeFileId={activeFileId}      
        activeFileFields={activeFileFields}
      />

      {/* 第 2 个子元素：中间 (直接放组件，不需要再包 div 了) */}
      <SplitTablePanel>
        <DataPivot 
            //   data 这里只传 features 数组给表格显示  
            data={currentData?.features || []} 
            fileName={activeFileName} 
            fileId={activeFileId}
            //   传入分页对象
            pagination={currentData?.pagination}
            //   传入翻页回调
            onPageChange={handlePageChange}

            // 当表格行被点击时，更新 App 的状态
            onRowClick={(record) => setSelectedFeature(record)}
            selectedFeature={selectedFeature}
            // 传入修改回调
            onDataChange={handleDataChange}
            // 传入行列增删
            onAddRow={handleAddRow}
            onDeleteRow={handleDeleteRow}
            onAddColumn={handleAddColumn}
            onDeleteColumn={handleDeleteColumn}
            onRenameColumn={handleRenameColumn}
        />
      </SplitTablePanel>

      {/* 第 3 个子元素：右侧 (直接放组件) */}
      <MapView 
          // data={uploadedFilesData[activeFileName]} 
          data={currentData ? { type: 'FeatureCollection', features: currentData.features } : null} 
          fileName={activeFileName}
          //  必须把当前的 fileId 传给地图组件，否则它不知道去拉哪个文件的全量数据
          fileId={activeFileId}
          // 传入选中的要素，用于高亮和弹窗
          selectedFeature={selectedFeature}
          // React 中最核心的父子组件通信模式，具体来说是子组件向父组件传递数据
          // “父组件给子组件一个‘对讲机’（函数），当子组件里发生点击事件时，
          // 子组件通过这个对讲机把‘被点击的数据’（feature）传回给父组件，
          // 父组件再把它存起来(使用setSelectedFeature存在selectedFeature中)”
          onFeatureClick={(feature) => setSelectedFeature(feature)}
      />
    </MainLayout>
  )
}

export default App;