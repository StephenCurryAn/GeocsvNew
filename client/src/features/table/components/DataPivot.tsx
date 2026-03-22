import 'ag-grid-community/styles/ag-grid.css'; 
import 'ag-grid-community/styles/ag-theme-alpine.css'; 
import React, { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom'; //   核心：引入传送门技术
import { AgGridReact } from 'ag-grid-react'; 
import { type ColDef, ModuleRegistry, AllCommunityModule } from 'ag-grid-community'; 
import { App, Empty, Button, Space, Popconfirm, Pagination } from 'antd'; // ... 引入 antd 组件
import { PlusOutlined, DeleteOutlined, TableOutlined, MinusSquareOutlined, DownloadOutlined } from '@ant-design/icons';
import { geoService } from '../../../services/geoService';
import apiClient from '../../../services/apiClient';

// 注册模块
// 向 AG Grid 的全局系统注册‘社区版’的所有功能模块，以便表格能正常运行
ModuleRegistry.registerModules([ AllCommunityModule ]);

interface DataPivotProps {
    data: any;          
    fileName: string;   
    //   新增 fileId，因为导出需要告诉后端是哪个文件
    fileId?: string;
    //   新增分页 Props
    pagination?: {
        total: number;
        page: number;
        pageSize: number;
    };
    onPageChange?: (page: number, pageSize: number) => void;

    // 接收父组件传来的回调，行点击
    onRowClick?: (record: any) => void;
    // 接收选中的 Feature
    selectedFeature?: any;
    // 数据变更回调 (通知父组件保存)
    onDataChange?: (recordId: string | number, newData: any) => void;
    // 行列操作回调
    onAddRow?: () => void;
    onDeleteRow?: (recordId: string | number) => void;
    onAddColumn?: () => void;
    onDeleteColumn?: (fieldName: string) => void;
    //   新增：重命名列回调
    onRenameColumn?: (oldFieldName: string, newFieldName: string) => void;
}

// ==========================================
//   纯净大圆满版：双段式智能公式编辑器 (支持模型+列名双重补全)
// ==========================================
const FormulaCellEditor = (props: any) => {
    const [value, setValue] = useState(props.value || '');
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const [focusedIndex, setFocusedIndex] = useState(0);
    const [showDropdown, setShowDropdown] = useState(false);
    const [dropdownRect, setDropdownRect] = useState({ top: 0, left: 0, width: 0 });
    
    //   新增状态：记录当前下拉框里显示的是“模型(model)”还是“列名(column)”
    const [suggestionType, setSuggestionType] = useState<'model' | 'column'>('column');

    const inputRef = useRef<HTMLInputElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLUListElement>(null);

    // 1. 获取当前表格所有的列名
    const availableColumns = props.api?.getColumnDefs()
        ?.map((col: any) => col.field)
        .filter((k: string) => k && !k.startsWith('_') && k !== 'id' && k !== 'cp' && !k.startsWith('__empty')) || [];

    //   核心修复 1：将 availableModels 改为 State，并使用外部传入的值作为初始缓存，彻底删除硬编码兜底！
    const [availableModels, setAvailableModels] = useState<string[]>(props.availableModels || []);

    //   核心修复 2：【JIT 实时刷新机制】
    // 每次双击单元格进入编辑状态时，静默向后端拉取一次最新模型列表！
    // 这样不用刷新网页，AI 刚生成的模型立刻出现，删掉的模型立刻消失！
    useEffect(() => {
        apiClient.get('/analysis/models').then(res => {
            if (res && res.data.code === 200 && Array.isArray(res.data.data)) {
                // 拿到数据库里最新活跃的模型
                setAvailableModels(res.data.data.map((m: any) => m.modelName));
            }
        }).catch(e => console.error("静默刷新实时模型列表失败", e));
    }, []);

    const isFormulaMode = String(value).startsWith('=');
    const defaultCellWidth = props.column ? props.column.getActualWidth() : 200;

    useEffect(() => {
        inputRef.current?.focus();
        if (String(props.value).startsWith('=')) {
            const len = String(props.value).length;
            setTimeout(() => inputRef.current?.setSelectionRange(len, len), 0);
        }
    }, [props.value]);

    const updateDropdownPosition = () => {
        if (containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            setDropdownRect({
                top: rect.bottom + 4,
                left: rect.left,
                width: Math.max(rect.width, 260)
            });
        }
    };

    useEffect(() => {
        if (showDropdown) {
            updateDropdownPosition();
            const handleScroll = (e: Event) => {
                if (listRef.current && (e.target === listRef.current || listRef.current.contains(e.target as Node))) return;
                setShowDropdown(false);
            };
            window.addEventListener('scroll', handleScroll, true);
            return () => window.removeEventListener('scroll', handleScroll, true);
        }
    }, [showDropdown, value]);

    useEffect(() => {
        if (showDropdown && listRef.current) {
            const focusedItem = listRef.current.children[focusedIndex] as HTMLElement;
            if (focusedItem) focusedItem.scrollIntoView({ block: 'nearest' });
        }
    }, [focusedIndex, showDropdown]);

    const getWordContext = (text: string, cursorPosition: number) => {
        let start = cursorPosition - 1;
        while (start >= 0 && !['(', ',', ' '].includes(text[start])) start--;
        start++;
        return { word: text.slice(start, cursorPosition), start, end: cursorPosition };
    };

    //   核心升级：智能判断当前该提示什么
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setValue(val);
        
        if (props.onValueChange) props.onValueChange(val);

        const cursor = e.target.selectionStart || 0;

        if (val.startsWith('=')) {
            const hasParen = val.includes('(');

            if (!hasParen) {
                // 🚀 模式 1：正在输入模型名称 (刚打了 '='，还没打 '(' )
                const typedModel = val.slice(1).toUpperCase(); // 提取 = 后面的文字
                const matchedModels = availableModels.filter((m: string) => m.toUpperCase().includes(typedModel));
                setSuggestions(matchedModels);
                setShowDropdown(matchedModels.length > 0);
                setFocusedIndex(0);
                setSuggestionType('model'); // 标记为模型提示模式
            } else {
                // 🚀 模式 2：正在输入参数/列名 (已经打出了 '(' )
                const { word } = getWordContext(val, cursor);
                if (val[cursor - 1] === '(' || val[cursor - 1] === ',' || val[cursor - 1] === ' ' || word.length > 0) {
                    const matched = availableColumns.filter((c: string) => c.toLowerCase().includes(word.toLowerCase()));
                    setSuggestions(matched);
                    setShowDropdown(matched.length > 0);
                    setFocusedIndex(0);
                    setSuggestionType('column'); // 标记为列名提示模式
                } else {
                    setShowDropdown(false);
                }
            }
        } else {
            setShowDropdown(false);
        }
    };

    //   核心升级：根据提示类型，执行不同的插入逻辑
    const insertSuggestion = (suggestion: string) => {
        let newVal = '';
        let newCursor = 0;

        if (suggestionType === 'model') {
            // 如果你选的是模型，直接补全模型名并自动加上左括号 "DBSCAN("
            newVal = '=' + suggestion + '(';
            newCursor = newVal.length;
        } else {
            // 如果你选的是列名，走原来的逻辑插入单词
            const cursor = inputRef.current?.selectionStart || 0;
            const { start, end } = getWordContext(value, cursor);
            newVal = value.slice(0, start) + suggestion + value.slice(end);
            newCursor = start + suggestion.length;
        }

        setValue(newVal);
        if (props.onValueChange) props.onValueChange(newVal);
        setShowDropdown(false);
        
        // 恢复焦点并让光标跟在刚插入的词后面
        setTimeout(() => {
            inputRef.current?.setSelectionRange(newCursor, newCursor);
            inputRef.current?.focus();
            
            //   极限体验优化：如果你刚补全了模型名并加了 "("，我们主动触发一次事件让它立刻弹出列名提示！
            if (suggestionType === 'model') {
                const fakeEvent = { target: { value: newVal, selectionStart: newCursor } } as any;
                handleChange(fakeEvent);
            }
        }, 10);
    };

    useEffect(() => {
        const inputEl = inputRef.current;
        if (!inputEl) return;
        const stopEditing = props.stopEditing;

        const handleNativeKeyDown = (e: KeyboardEvent) => {
            if (showDropdown) {
                if (e.key === 'ArrowDown') {
                    e.preventDefault(); e.stopImmediatePropagation(); setFocusedIndex(p => (p + 1) % suggestions.length);
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault(); e.stopImmediatePropagation(); setFocusedIndex(p => (p - 1 + suggestions.length) % suggestions.length);
                } else if (['Enter', 'Tab', ' '].includes(e.key)) {
                    e.preventDefault(); e.stopImmediatePropagation(); insertSuggestion(suggestions[focusedIndex]);
                } else if (e.key === 'Escape') {
                    e.stopImmediatePropagation(); setShowDropdown(false);
                }
            } else {
                if (['ArrowLeft', 'ArrowRight'].includes(e.key)) {
                    e.stopImmediatePropagation();
                }
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (stopEditing) stopEditing();
                }
            }
        };

        inputEl.addEventListener('keydown', handleNativeKeyDown, { capture: true });
        return () => inputEl.removeEventListener('keydown', handleNativeKeyDown, { capture: true });
    }, [showDropdown, suggestions, focusedIndex, value, props.stopEditing]); 

    const DropdownPortal = () => {
        if (!showDropdown || suggestions.length === 0) return null;
        return createPortal(
            <ul ref={listRef} className="ag-custom-component-popup fixed z-999999 bg-[#1a2332] border border-cyan-700/80 rounded-md shadow-[0_10px_40px_rgba(0,0,0,0.8)] max-h-56 overflow-y-auto custom-scrollbar m-0 p-1 list-none overscroll-contain"
                style={{ top: dropdownRect.top, left: dropdownRect.left, width: dropdownRect.width }}
                onMouseDown={(e) => {
                    e.stopPropagation(); e.nativeEvent.stopImmediatePropagation();
                    if (e.target !== listRef.current) e.preventDefault();
                    else {
                        const restoreFocus = () => { inputRef.current?.focus(); window.removeEventListener('mouseup', restoreFocus); };
                        window.addEventListener('mouseup', restoreFocus);
                    }
                }}
                onWheel={(e) => { e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); }}
            >
                {suggestions.map((s, i) => (
                    <li key={s} className={`px-3 py-2 cursor-pointer text-sm font-mono transition-all rounded flex items-center ${i === focusedIndex ? 'bg-cyan-600/90 text-white font-bold' : 'text-gray-300 hover:bg-cyan-900/40'}`}
                        onMouseDown={(e) => { e.preventDefault(); insertSuggestion(s); }}>
                        {/*   视觉优化：模型名前面用紫色圆点，列名前面用青色圆点，一眼区分！ */}
                        <span className={`w-2 h-2 rounded-full mr-2 shrink-0 ${
                            i === focusedIndex 
                                ? 'bg-white shadow-[0_0_5px_white]' 
                                : suggestionType === 'model' ? 'bg-purple-500 opacity-60' : 'bg-cyan-500 opacity-60'
                        }`}></span>
                        <span className="truncate">{s}</span>
                    </li>
                ))}
            </ul>, document.body
        );
    };

    return (
        <div ref={containerRef} className={`flex items-center w-full h-full px-2 transition-all duration-300 ease-out box-border ${isFormulaMode ? 'bg-geo-dark shadow-[inset_0_0_0_2px_#06b6d4]' : 'bg-[#1f2937] shadow-[inset_0_0_0_1px_#3b82f6]' }`}
            style={{ width: isFormulaMode ? Math.max(defaultCellWidth, 300) : defaultCellWidth, height: 40, borderRadius: '4px' }}>
            {isFormulaMode && <span className="text-cyan-400 font-mono text-sm mr-2 font-bold select-none shrink-0 drop-shadow-[0_0_4px_rgba(6,182,212,0.8)]">ƒx</span>}
            <input ref={inputRef} value={value} onChange={handleChange} placeholder={isFormulaMode ? "等待输入模型或参数..." : "输入数值..."} className={`w-full h-full bg-transparent outline-none font-mono text-sm border-none shadow-none ${isFormulaMode ? 'text-cyan-50' : 'text-gray-100'}`} style={{ minWidth: 0 }} />
            <DropdownPortal />
        </div>
    );
};

const DataPivot: React.FC<DataPivotProps> = ({ data, fileName, fileId, pagination, onPageChange, 
    onRowClick, selectedFeature, onDataChange, 
    onAddRow, onDeleteRow, onAddColumn, onDeleteColumn, onRenameColumn }) => {
    //   修改 2: 获取上下文感知的 message 实例
    // 注意：MapView 必须被包裹在 <App> 组件中（通常在 main.tsx 或 App.tsx 已经包了）
    const { message } = App.useApp();
    // Grid 引用，用于调用 API
    const gridRef = useRef<AgGridReact>(null);
    // 表格的行数据   
    const [rowData, setRowData] = useState<any[]>([]);
    // 表格列的配置蓝图
    const [columnDefs, setColumnDefs] = useState<ColDef[]>([]);
    // 记录当前选中的行索引，用于删除行
    const [selectedRecordId, setSelectedRecordId] = useState<string | number | null>(null);
    //   1. 新增：存储后端真实模型列表的状态
    const [modelList, setModelList] = useState<string[]>([]);
    
    //   2. 新增：组件初始化时，向后端请求活跃模型列表
    useEffect(() => {
        const fetchModels = async () => {
            try {
                // 调用我们在 geoService 中写好的方法
                const res = await apiClient.get('/analysis/models');
                
                // 严格按照你后端的结构 { code: 200, data: models } 解析
                if (res && res.data.code === 200 && Array.isArray(res.data.data)) {
                    // 提取出所有的 modelName (如 "LSI_AHP") 供编辑器补全使用
                    const modelNames = res.data.data.map((model: any) => model.modelName);
                    setModelList(modelNames);
                    console.log("  成功拉取真实模型列表:", modelNames);
                }
            } catch (error) {
                console.error("❌ 获取真实模型列表失败:", error);
                // 兜底方案：如果请求失败，留几个默认的防止功能直接瘫痪
                setModelList(['DBSCAN_SPATIAL_CLUSTERING', 'KMEANS_CLUSTERING']);
            }
        };
        fetchModels();
    }, []); // 空依赖数组，确保只加载一次 

    // data 现在直接是数组了，不需要判断 FeatureCollection 
    useEffect(() => {
    if (!data || data.length === 0) {
        setRowData([]);
        setColumnDefs([]);
        return;
    }
    //  data 是 features 数组，直接处理
    // 因为App组件中是data={currentData?.features || []}传过来的数组 
    processGeoJSONFeatures(data, modelList);

    }, [data, fileName, modelList]);

    // 监听 selectedFeature，同步高亮表格行
    useEffect(() => {
    // 先把 API 赋值给局部变量，解决 "gridRef.current is possibly null" 报错
    // 使用可选链 ?. 确保安全访问
    // api 的值是 AG Grid 库在组件初始化完成后，自动挂载到你的 Ref 对象上的
    // api对象里包含了数百个函数，全是用来控制表格的，“万能操作面板”
    const api = gridRef.current?.api;
    // 如果 api 不存在，直接结束
    if (!api) return;

    if (selectedFeature) {
        // 使用局部变量 api 进行操作，TS 就不会报错了
        api.forEachNode((node) => {
            const nodeData = node.data;
            // 匹配逻辑：优先比对 ID，没有 ID 比对 Name
            const isMatch = (nodeData.id && nodeData.id === selectedFeature.id) || 
                            (nodeData.name && nodeData.name === selectedFeature.name);
            if (isMatch) {
                node.setSelected(true);
                api.ensureNodeVisible(node, 'middle'); // 滚动到该行
            }
        });
    } else {
        // 如果 selectedFeature 为空，取消所有选中
        api.deselectAll();
    }
    }, [selectedFeature]);

    /**
     * 通用列定义生成函数 (修复 Warning #48)
     */
    const generateColumnDefs = (rows: any[], models: string[]) => {
        if (rows.length === 0) return [];
        // 定义不可编辑的字段 (例如 ID 和 坐标)
        const readOnlyFields = ['id', '_geometry', 'cp', '_cp', '_lng', '_lat', '_geom_coords'];
        const keys = Object.keys(rows[0]);

        // 1. 生成基于数据的真实列
        const baseCols = keys
            .filter(k => !['_cp'].includes(k) && !k.startsWith('__empty_col_'))
            .map(key => {
                //   判断当前列是否为那个包含超级长字符串的“几何坐标列”
                const isGeomCoordsCol = (key === '_geom_coords');

                return {
                    field: key,
                    headerName: (() => {
                        if (key === '_geometry') return '图层类型';
                        if (key === 'center') return '中心坐标';
                        if (key === '_lng') return '经度 (Lng)';
                        if (key === '_lat') return '纬度 (Lat)';
                        if (isGeomCoordsCol) return '几何坐标数据 (Geometry)';
                        return key;
                    })(),
                    sortable: true,
                    filter: true,
                    resizable: true,
                    minWidth: 100,

                    //   新增：如果是几何坐标列，初始宽度设为 200，且最高不超过 300
                    width: isGeomCoordsCol ? 200 : 150,
                    maxWidth: isGeomCoordsCol ? 300 : undefined,
                    //   新增核心防御：禁止该列参与表格外层的 autoSizeStrategy="fitCellContents"
                    suppressAutoSize: isGeomCoordsCol, 

                    editable: !readOnlyFields.includes(key),
                    cellEditor: FormulaCellEditor, //   修改为智能编辑器
                    cellEditorPopup: true, //   新增：显式声明为弹窗模式
                    //   修改 2：把这里写死的数组替换为传入的真实模型数组！
                    cellEditorParams: { 
                        availableModels: models
                    },
                    valueFormatter: (params: any) => {
                        const val = params.value;
                        if (typeof val === 'object' && val !== null) {
                            return JSON.stringify(val); 
                        }
                        return val;
                    }
                };
            });

        // 2. 动态生成 5 列预留空列，专门用于随意输入公式
        const emptyCols = Array.from({ length: 5 }).map((_, i) => ({
            field: `__empty_col_${i}`,
            headerName: ` `,
            editable: true,
            minWidth: 100,
            width: 150,
            cellEditor: FormulaCellEditor, //   修改为智能编辑器
            cellEditorPopup: true, //   新增：显式声明为弹窗模式
            //   修改 3：把这里写死的数组替换为传入的真实模型数组！
            cellEditorParams: { 
                availableModels: models
            }
        }));

        // 返回合并后的表头
        return [...baseCols, ...emptyCols];
    };

    //  把 processGeoJSON 改造一下，只处理 features 数组
    const processGeoJSONFeatures = (features: any[], models: string[]) => {
        const rows = features.map((feature: any) => {
        
        let cp = feature.properties?.cp;
        if (typeof cp === 'string') {
            try { cp = JSON.parse(cp); } catch(e) {}
        }

        //   终极防死修复：如果后端没传 id，强行生成一个唯一 ID，绝不允许出现 undefined！
        let uniqueId = feature.properties?.id || feature._id || feature.id;
        if (uniqueId === undefined || uniqueId === null) {
            uniqueId = `tmp_${Math.random().toString(36).substr(2, 9)}`;
        }

        // --- 2. 构造基础行数据 ---
        const row = {
          ...feature.properties,
          id: uniqueId, // 👈 绑定绝对唯一的 ID
          cp: cp, 
          _geometry: feature.geometry?.type || 'Unknown'
        };
        
        // --- 3. 注入导出用的几何字段 ---
        if (feature.geometry) {
            const gType = feature.geometry.type;
            const coords = feature.geometry.coordinates;
            if (gType === 'Point' && Array.isArray(coords) && coords.length >= 2) {
                row['_lng'] = coords[0];
                row['_lat'] = coords[1];
            } else {
                row['_geom_coords'] = JSON.stringify(coords);
            }
        }
        return row;
      });

      setRowData(rows);
      setColumnDefs(generateColumnDefs(rows, models));
    };

    /**
     * 导出 CSV 处理函数
     */
    const handleExportCSV = async () => {
        // 安全检查
        if (!fileId) {
            message.error('未找到文件 ID，无法进行服务器端导出');
            return;
        }

        try {
            message.loading({ content: '正在请求服务器生成最新数据...', key: 'exportMsg' });
            
            // 调用 Service 下载
            await geoService.exportFile(fileId, fileName);
            
            message.success({ content: '导出成功，开始下载', key: 'exportMsg' });
        } catch (error) {
            console.error(error);
            message.error({ content: '导出失败', key: 'exportMsg' });
        }
    };

    if (!data || rowData.length === 0) {
    return (
        <div className="h-full flex flex-col items-center justify-center bg-[#1f2937] rounded text-gray-400">
            <Empty description={<span className="text-gray-400">请在左侧选择文件以查看属性表</span>} />
        </div>
    );
    }

    return (
    <div className="flex flex-col h-full">
        {/* <div className="mb-2 px-2 text-xs text-blue-400 font-mono flex justify-between">
        <span>当前文件: {fileName}</span>
        <span>记录数: {rowData.length}</span>
        </div> */}

        {/* 工具栏 */}
        <div className="bg-[#1f2937] p-2 border-b border-gray-700 flex justify-between items-center">
        <div className="text-xs text-blue-400 font-mono">
            <span>{fileName}</span>
            <span className="ml-2 text-gray-500">({rowData.length} records)</span>
        </div>
        
        {/* 操作按钮组 */}
        <Space size="small">
            {/* 在“增行”左边添加“导出CSV”按钮 */}
            <Button 
                size="small" 
                icon={<DownloadOutlined />} 
                className="bg-green-700! text-gray-200! border-green-600! hover:bg-green-600! hover:border-green-500!"
                onClick={handleExportCSV}
                disabled={rowData.length === 0} // 无数据时禁用
            >
                导出CSV
            </Button>

            <Button 
                type="primary" 
                size="small" 
                icon={<PlusOutlined />} 
                onClick={onAddRow}
                disabled={!onAddRow}
            >
                增行
            </Button>
            
            <Popconfirm 
                title="确定删除选中行吗？" 
                onConfirm={() => {
                    // 不再使用 selectedRowIndex，而是直接获取选中行的数据对象
                    const selectedRows = gridRef.current?.api.getSelectedRows();
                    if (selectedRows && selectedRows.length > 0 && onDeleteRow) {
                        const selectedData = selectedRows[0]; // 获取选中行的完整数据
                        
                        // 确保有 ID
                        if (selectedData.id) {
                            // 传 ID 给父组件，而不是行号
                            onDeleteRow(selectedData.id); 
                            setSelectedRecordId(null); // 重置选中状态
                        } else {
                            message.error('该行数据缺失 ID，无法删除');
                        }
                    } else {
                        message.warning('请先选中一行');
                    }
                }}
            >
                <Button 
                    type="primary" 
                    danger 
                    size="small" 
                    icon={<DeleteOutlined />}
                    disabled={selectedRecordId === null}
                >
                    删行
                </Button>
            </Popconfirm>

            <div className="w-px h-4 bg-gray-600 mx-1"></div>

            <Button 
                size="small" 
                icon={<TableOutlined />} 
                className="bg-gray-700 text-white border-gray-600"
                onClick={onAddColumn}
            >
                增列
            </Button>
            
            <Button 
                size="small" 
                icon={<MinusSquareOutlined />} 
                className="bg-gray-700 text-white border-gray-600"
                onClick={() => {
                    // 简单的交互：让用户输入要删除的列名 (进阶版应该做一个下拉选框Modal)
                    const col = prompt("请输入要删除的列名（注意：id, name, cp 禁止删除）:");
                    if (col && onDeleteColumn) onDeleteColumn(col);
                }}
            >
                删列
            </Button>
        </Space>
        </div>

        <div 
            className="ag-theme-alpine-dark flex-1 w-full h-full"
            onDoubleClick={(e) => {
                // 1. 获取当前双击的 DOM 元素
                const target = e.target as HTMLElement;

                // 2. 只有双击在表头文字区域（.ag-header-cell-label）才触发，避免双击调整列宽（.ag-header-cell-resize）时误触
                const headerLabel = target.closest('.ag-header-cell-label');
                if (headerLabel) {
                    // 3. 向上找到表头单元格容器，获取列名 (col-id 默认就是 field)
                    const headerCell = target.closest('.ag-header-cell');
                    const colId = headerCell?.getAttribute('col-id');

                    // 过滤掉空白公式列和空值
                    if (!colId || colId.startsWith('__empty_col_')) return;

                    // 4. 系统核心字段保护
                    const readOnlyFields = ['id', '_geometry', 'cp', '_cp', '_lng', '_lat', '_geom_coords', 'name'];
                    if (readOnlyFields.includes(colId)) {
                        message.warning(`[${colId}] 是系统保留字段，禁止修改！`);
                        return;
                    }

                    // 5. 弹窗询问新列名（输入框默认填入原列名）
                    const newCol = prompt(`修改列名 [${colId}] 为：`, colId);
                    
                    // 6. 校验输入并触发回调
                    if (newCol && newCol.trim() !== '' && newCol.trim() !== colId && onRenameColumn) {
                        onRenameColumn(colId, newCol.trim());
                    }
                }
            }}
        >
        {/* 注入炫酷的选中样式 */}
        <style>{`
            .ag-header-cell-label {
                font-weight: 600;
                cursor: pointer;
                transition: color 0.2s;
            }
            .ag-header-cell-label:hover {
                color: #00e5ff !important; /* 悬浮时变青色，提示可操作 */
            }
            .ag-theme-alpine-dark {
                --ag-background-color: #111827; 
                --ag-header-background-color: #1f2937; 
                --ag-odd-row-background-color: #111827;
                --ag-row-border-color: #374151;
                --ag-header-foreground-color: #9ca3af;
                --ag-foreground-color: #e5e7eb;
                
                /* 覆盖默认的选中行背景色 (改为半透明青色) */
                --ag-selected-row-background-color: rgba(0, 229, 255, 0.15) !important;
            }

            /* 表头加粗 */
            .ag-header-cell-label {
                font-weight: 600;
            }

            /* 自定义选中行的左侧高亮条 */
            .ag-theme-alpine-dark .ag-row-selected {
                border-left: 4px solid #00e5ff !important; /* 左侧亮条 */
                transition: all 0.2s;
            }

            /* 选中时文字变亮白，增加对比度 */
            .ag-theme-alpine-dark .ag-row-selected .ag-cell {
                color: white !important;
                text-shadow: 0 0 10px rgba(0, 229, 255, 0.3); /* 微微发光 */
            }

            /* 去掉单元格聚焦时的那个难看的蓝色粗框 */
            .ag-theme-alpine-dark .ag-cell-focus {
                border-color: transparent !important;
            }

            /* 修复复选框在暗色模式下的可见性 */
            .ag-checkbox-input-wrapper {
                font-size: 14px;
            }
        `}</style>
        
        <AgGridReact

            // 绑定 ref
            ref={gridRef}

            // 解决 Error #239
            // 加上这个属性，允许你继续使用 ag-theme-alpine.css 和你的自定义样式
            theme="legacy" 
            
            rowData={rowData}
            columnDefs={columnDefs}
            
            //   灵魂属性新增：告诉 AG Grid 如何唯一识别每一行！
            getRowId={(params) => {
                return String(params.data.id);
            }}

            //  关闭 AG Grid 的全量分页，因为只给了它一页数据
            pagination={false}
            // paginationPageSize={20}

            animateRows={true}

            //  自动调整列宽策略
            // 当表格数据准备好后，自动根据 [表头内容] 和 [单元格内容] 计算最佳宽度
            // 这会让列宽自动撑开，如果总宽度超过容器，AG Grid 会自动出现横向滚动条
            autoSizeStrategy={{
                type: 'fitCellContents' // 适应单元格内容
            }}
            // 明确配置选择模式和复选框
            // checkboxes: true 确保每行前面都有框 (虽然你可能通过其他方式实现了，但这样写最稳)
            // headerCheckbox: false 禁用全选，因为我们做的是单选联动
            rowSelection={{ 
                mode: 'singleRow', 
                checkboxes: true,
            }}
            
            // 无论点击行、复选框还是键盘操作，只要选中变了，这里都会触发
            onSelectionChanged={(event) => {
                // 防死循环：如果选中操作是由 API 触发的（比如点击地图导致表格更新），就不再回传
                if (event.source === 'api') return;

                const selectedRows = event.api.getSelectedRows();
                // 更新本地状态 (为的是控制删行按钮的禁用状态)
                if (selectedRows.length > 0) {
                    setSelectedRecordId(selectedRows[0].id); // 存 ID !
                } else {
                    setSelectedRecordId(null);
                }
                // 通知父组件
                if (onRowClick) {
                    if (selectedRows.length > 0) {
                        onRowClick(selectedRows[0]);
                    } else {
                        // 如果取消选中（点击复选框取消），通知父组件清空
                        onRowClick(null);
                    }
                }
            }}

            //   修改：升级单元格修改事件，拦截公式输入并触发微服务计算
            onCellValueChanged={async (event) => {
                console.log("👉 [事件触发] onCellValueChanged 被成功唤醒！新值是:", event.newValue);
                const { newValue, oldValue, colDef, node, data } = event;
                const field = colDef.field;

                // 如果值没变，不触发任何操作
                if (newValue === oldValue) return;

                //   新增核心逻辑：检测是否输入了类 Excel 公式 (以 = 开头)
                if (typeof newValue === 'string' && newValue.startsWith('=')) {
                    if (!fileId) {
                        message.error("未找到文件 ID，无法执行公式计算");
                        node.setDataValue(field!, oldValue); // 恢复原值
                        return;
                    }

                    // 正则解析：形如 =ADD_COLS(灾害_1, 灾害_12)
                    const regex = /^=([a-zA-Z0-9_]+)\((.*)\)$/;
                    const match = newValue.match(regex);

                    if (match) {
                        const modelName = match[1];
                        
                        // 1. 提取用户输入的原始参数数组
                        const rawArgs = match[2]
                            .split(/[,，]/)
                            .map((s: string) => s.trim())
                            .filter((s: string) => s.length > 0);
                        
                        const allRealFields = event.api.getColumnDefs()?.map((col: any) => col.field) || [];

                        //   2. 核心修复：智能参数放行
                        // 如果它匹配到了某个列名，就矫正大小写；如果匹配不到（比如是 "0.1"），直接原样保留，不再报错！
                        const processedArgs = rawArgs.map(arg => {
                            const cleanArg = arg.replace(/^['"]|['"]$/g, ''); // 尝试去掉引号对比列名
                            const realCol = allRealFields.find(field => 
                                field && field.toLowerCase() === cleanArg.toLowerCase()
                            );
                            
                            // 找不到列名不报错！把它当成超参数发给后端
                            return realCol ? realCol : arg; 
                        });

                        console.log("🔥 准备发给后端的真实模型名:", modelName);
                        console.log("🔥 发给后端的动态参数数组:", processedArgs);

                        // 界面反馈：临时改变当前格子的文字
                        node.setDataValue(field!, "⏳ 计算中...");

                        try {
                            //   3. 修改接口调用，传入统一的 rawArgs 对象
                            const responseData = await geoService.executeModelFormula({
                                fileId: fileId,
                                modelName: modelName,
                                rawArgs: processedArgs 
                            });

                            const resultData = responseData.resultData;
                            
                            // 兼容旧版接口(resultColName) 和 新版多列接口(resultColNames)
                            const rawCols = responseData.resultColNames || responseData.resultColName;
                            
                            // 不管后端传过来的是字符串还是数组，我们统一包成数组
                            const finalColNames = Array.isArray(rawCols) 
                                ? rawCols 
                                : (typeof rawCols === 'string' ? [rawCols] : []);

                            if (!resultData || !Array.isArray(resultData)) {
                                throw new Error("后端返回的数据结构不正确，缺少 resultData 数组！");
                            }
                            
                            if (finalColNames.length === 0) {
                                throw new Error("后端没有返回有效的列名字段，请检查控制台网络请求！");
                            }

                            // 转换成字典 Map (支持多字段与单字段的自适应)
                            const scoreMap = new Map();
                            resultData.forEach((item: any) => {
                                // 提取 id，剩余的所有属性作为 scores
                                const { id, score, ...otherScores } = item;
                                
                                // 如果发现后端还在传老的 "score" 字段，主动帮它映射到列名上
                                if (score !== undefined && typeof rawCols === 'string') {
                                    scoreMap.set(String(id), { [rawCols]: score, ...otherScores });
                                } else {
                                    scoreMap.set(String(id), { score, ...otherScores });
                                }
                            });

                            //   第一步：动态批量追加表头配置
                            setColumnDefs(prev => {
                                const newCols = [...prev];
                                finalColNames.forEach((colName: string) => {
                                    if (!newCols.some(col => col.field === colName)) {
                                        newCols.push({ 
                                            field: colName, 
                                            headerName: colName, 
                                            sortable: true, filter: true, resizable: true, editable: true, minWidth: 100, width: 150 
                                        });
                                    }
                                });
                                return newCols;
                            });

                            //   第二步：纯 React 状态重绘行数据 
                            setRowData(prev => {
                                return prev.map(row => {
                                    const matchScores = scoreMap.get(String(row.id));
                                    if (matchScores !== undefined) {
                                        return { ...row, ...matchScores }; 
                                    }
                                    return row;
                                });
                            });

                            node.setDataValue(field!, "  公式完成");
                            // 这里使用 finalColNames.join 就绝对不会报错了
                            message.success(`模型计算成功！新增列 [${finalColNames.join(', ')}] 已渲染`);

                        } catch (error: any) {
                            console.error("公式计算失败", error);
                            node.setDataValue(field!, "❌ 公式错误");
                            message.error(error.response?.data?.error || error.response?.data?.details || "计算失败，请检查模型名称和参数列");
                        }
                    } else {
                        node.setDataValue(field!, "❌ 格式错误");
                        message.warning("公式格式错误，请输入形如 =MODEL(col1, col2)");
                    }
                    
                    return; //   公式处理完毕，直接 return，不要触发下方普通的保存逻辑
                }

                // --- 以下保持你原有的普通数据修改和保存逻辑 ---
                console.log('普通单元格已修改:', event);
                const recordId = data.id;
                if (recordId && onDataChange) {
                    onDataChange(recordId, data);
                }
            }}
        />
        </div> 
        {/* 3.   新增：底部服务器分页条 */}
        {pagination && (
            <div className="bg-[#111827] border-t border-gray-700 p-2 flex justify-end">
                <Pagination 
                    size="small"
                    current={pagination.page}
                    total={pagination.total}
                    pageSize={pagination.pageSize}
                    onChange={(page, pageSize) => {
                        if (onPageChange) onPageChange(page, pageSize);
                    }}
                    showSizeChanger
                    showTotal={(total) => <span className="text-gray-400">共 {total} 条数据</span>}
                    className="custom-pagination"
                />
                {/* 注入分页条样式适配暗色模式 */}
                <style>{`
                    .custom-pagination .ant-pagination-item a { color: #e5e7eb; }
                    .custom-pagination .ant-pagination-item-active { background: transparent; border-color: #3b82f6; }
                    .custom-pagination .ant-pagination-item-active a { color: #3b82f6; }
                    .custom-pagination .ant-pagination-prev .ant-pagination-item-link,
                    .custom-pagination .ant-pagination-next .ant-pagination-item-link { color: #9ca3af; }
                    .custom-pagination .ant-select-selector { background: #1f2937 !important; color: white !important; border-color: #374151 !important; }
                `}</style>
            </div>
        )}
    </div>
    );
};

export default DataPivot;