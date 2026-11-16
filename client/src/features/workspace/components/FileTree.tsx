import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Tree, Button, ColorPicker, Empty, Input, Dropdown, type InputRef, type MenuProps, App as AntdApp } from 'antd';
import { FolderAddOutlined, CloudUploadOutlined, FileTextOutlined, GlobalOutlined,
         FileImageOutlined, TableOutlined, FolderFilled, EyeOutlined, EyeInvisibleOutlined,
         DownOutlined, DeleteOutlined, EditOutlined, ExclamationCircleOutlined,
         PictureOutlined } from '@ant-design/icons';
import { geoService } from '../../../services/geoService';
import { getApiUrl } from '../../../services/apiConfig';
import { sceneFilesPath } from '../../../services/sceneService';
import { readSceneSelection, saveSceneSelection } from '../scenePreferences';
import { useAnalysisStore } from '../../../stores/useAnalysisStore';
import { defaultLayerColor, LAYER_PALETTE } from '../../map/fileLayers';
import type { DrawStatus } from '../../map/components/MapView';

export interface WorkspaceLayer {
  totalFeatures?: number;
  loadFailed?: boolean;
  hidden: boolean;
  drawStatus?: DrawStatus;
}

interface FileTreeProps {
  sceneId: string;
  isCurrentScene: (sceneId: string) => boolean;
  onSelectFiles: (fileNames: string[], fileIds: string[]) => void;
  activeFileId: string;
  onActivateFile: (fileId: string, fileName: string) => void;
  onToggleFileVisibility: (fileId: string) => void;
  layers: Record<string, WorkspaceLayer>;
}

interface TreeNode {
  key: string;
  title: string;
  type: 'file' | 'folder';
  children?: TreeNode[];
  isLeaf?: boolean;
}

function findNodeByKey(nodes: TreeNode[], key: string): TreeNode | undefined {
  for (const node of nodes) {
    if (node.key === key) return node;
    const child = node.children && findNodeByKey(node.children, key);
    if (child) return child;
  }
}

function folderKeys(nodes: TreeNode[]): string[] {
  return nodes.flatMap(node => node.type === 'folder' ? [node.key, ...folderKeys(node.children ?? [])] : []);
}

const FileTree: React.FC<FileTreeProps> = ({
  sceneId, isCurrentScene, onSelectFiles, activeFileId, onActivateFile, onToggleFileVisibility, layers,
}) => {
  const { message, modal } = AntdApp.useApp();
  const layerColors = useAnalysisStore(state => state.layerColors);
  const setLayerColor = useAnalysisStore(state => state.setLayerColor);
  const endpoint = sceneFilesPath(sceneId);
  const [initialSelection] = useState(() => readSceneSelection(sceneId));
  const selectedKeysRef = useRef(initialSelection);
  const [uploadFolder, setUploadFolder] = useState<string | null>(null);
  const publishedFilesRef = useRef<TreeNode[]>([]);
  const [treeData, setTreeData] = useState<TreeNode[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const hasLoadedTree = useRef(false);
  const [treeStatus, setTreeStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [uploading, setUploading] = useState(false);
  const mountedRef = useRef(false);
  const treeRequestRef = useRef<AbortController | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const renamePendingRef = useRef(false);
  const inputRef = useRef<InputRef>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isActive = useCallback(() => mountedRef.current && isCurrentScene(sceneId), [isCurrentScene, sceneId]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      treeRequestRef.current?.abort();
    };
  }, []);

  const syncSelection = useCallback((keys: string[], nodes: TreeNode[]) => {
    const selected = keys.map(key => findNodeByKey(nodes, key)).filter(node => node !== undefined);
    const validKeys = selected.map(node => node.key);
    const previousKeys = selectedKeysRef.current;
    if (previousKeys.length !== validKeys.length || previousKeys.some((key, index) => key !== validKeys[index])) {
      selectedKeysRef.current = validKeys;
    }

    const files = selected.filter(node => node.type === 'file');
    const fileIds = files.map(node => node.key);
    saveSceneSelection(sceneId, fileIds);
    const previous = publishedFilesRef.current;
    if (files.length !== previous.length || files.some((node, index) =>
      node.key !== previous[index].key || node.title !== previous[index].title
    )) {
      publishedFilesRef.current = files;
      onSelectFiles(files.map(node => node.title), fileIds);
    }
  }, [onSelectFiles, sceneId]);

  const fetchFileTree = useCallback(async (preferred?: { keys: string[]; previous: string[] }) => {
    if (!isActive()) return;
    treeRequestRef.current?.abort();
    const controller = new AbortController();
    treeRequestRef.current = controller;
    try {
      const response = await fetch(getApiUrl(endpoint + '/tree'), { signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message);
      if (controller.signal.aborted || !isActive()) return;
      const nodes: TreeNode[] = result.data;
      if (!hasLoadedTree.current) {
        setExpandedKeys(folderKeys(nodes));
        hasLoadedTree.current = true;
      }
      setTreeData(nodes);
      setTreeStatus('ready');
      const keys = preferred?.previous === selectedKeysRef.current ? preferred.keys : selectedKeysRef.current;
      syncSelection(keys, nodes);
    } catch {
      if (!controller.signal.aborted && isActive()) setTreeStatus('error');
    }
  }, [endpoint, isActive, syncSelection]);

  useEffect(() => {
    void fetchFileTree();
    const handleRefresh = (event: Event) => {
      const targetScene = (event as CustomEvent<{ sceneId?: string }>).detail?.sceneId;
      if (!targetScene || targetScene === sceneId) void fetchFileTree();
    };
    window.addEventListener('REFRESH_FILE_TREE', handleRefresh);
    return () => window.removeEventListener('REFRESH_FILE_TREE', handleRefresh);
  }, [fetchFileTree, sceneId]);

  const refreshAfterMutation = (preferred?: { keys: string[]; previous: string[] }) => {
    if (isActive()) return fetchFileTree(preferred);
    // Re-entering the same scene before a mutation finishes may have loaded an earlier snapshot.
    window.dispatchEvent(new CustomEvent('REFRESH_FILE_TREE', { detail: { sceneId } }));
  };
  // 辅助函数：根据文件名获取图标
  // 图标逻辑：根据文件类型返回不同颜色图标
  const getIcon = (props: TreeNode) => {
    if (props.type === 'folder') {
      return <FolderFilled className="text-yellow-500! text-lg" />;
    }
    const ext = (props.title || '').toLowerCase().split('.').pop();
    switch (ext) {
      case 'csv': return <TableOutlined className="text-green-400! " />;
      case 'xlsx': return <TableOutlined className="text-green-400!" />;
      case 'json': return <FileImageOutlined className="text-gray-400!" />;
      case 'geojson': return <FileImageOutlined className="text-gray-400!" />;
      case 'shp': return <GlobalOutlined className="text-blue-400!" />;
      case 'tif': 
      case 'tiff': 
        return <PictureOutlined className="text-purple-400! text-lg" title="栅格数据 (用于空间计算)" />;
      default: return <FileTextOutlined className="text-gray-400!" />;
    }
  };
  const titleRender = (node: TreeNode) => {
    const isEditing = editingKey === node.key; // 判断是否处于编辑模式
    const icon = getIcon(node);
    const layer = node.type === 'file' ? layers[node.key] : undefined;
    const color = layerColors[node.key] || defaultLayerColor(node.key);
    const status = !layer ? '' : layer.loadFailed ? '数据加载失败' : layer.totalFeatures === 0 ? '无要素'
        : layer.hidden ? '' : layer.drawStatus === 'error' ? '瓦片加载失败'
        : layer.drawStatus !== 'ready' ? '加载中…' : '';
    const visibilityAction = layer?.hidden ? '显示地图图层' : '隐藏地图图层';

    // 定义右键菜单项
    const menuItems: MenuProps['items'] = [
        ...(layer ? [{
            key: 'remove-layer',
            label: '从工作台移除',
            onClick: () => syncSelection(selectedKeysRef.current.filter(key => key !== node.key), treeData),
        }] : []),
        {
            key: 'rename',
            label: '重命名',
            icon: <EditOutlined />,
            onClick: () => {
                setEditingKey(node.key);
                setEditingValue(node.title); // 初始值为当前标题
                // 稍微延迟一下聚焦，等待 DOM 渲染 Input
                setTimeout(() => inputRef.current?.focus(), 100);
            }
        },
        {
            key: 'delete',
            label: '删除',
            icon: <DeleteOutlined />,
            danger: true,
            onClick: () => handleDelete(node.key, node.title)
        }
    ];

    // 渲染内容
    const content = (
        <div 
            className="resource-tree-row"
            // 双击触发重命名
            onDoubleClick={(e) => {
                e.stopPropagation(); // 防止触发展开折叠
                setEditingKey(node.key);
                setEditingValue(node.title);
            }}
        >
            <span className="resource-tree-icon">
                {layer && !isEditing ? (
                    <span onClick={event => event.stopPropagation()}
                        onDoubleClick={event => event.stopPropagation()}
                        onKeyDown={event => event.stopPropagation()}>
                        <ColorPicker
                            size="small"
                            value={color}
                            defaultFormat="rgb"
                            disabledAlpha
                            disabled={layer.loadFailed || !layer.totalFeatures}
                            presets={[{ label: '柔和主题色', colors: LAYER_PALETTE }]}
                            onChangeComplete={value => setLayerColor(node.key, value.toHexString())}
                        >
                            <button type="button" className="resource-layer-swatch" aria-label={`图层颜色 ${node.title}`}
                                title="图层颜色" disabled={layer.loadFailed || !layer.totalFeatures}>
                                <span style={{ backgroundColor: color }} />
                            </button>
                        </ColorPicker>
                    </span>
                ) : icon}
            </span>

            {/* 编辑模式 vs 浏览模式 */}
            {isEditing ? (
                <Input
                    ref={inputRef}
                    size="small"
                    value={editingValue}
                    onChange={(e) => setEditingValue(e.target.value)}
                    onPressEnter={() => handleRenameSave(node.key)}
                    onBlur={() => {
                         // 失去焦点时，保存还是取消？通常是保存。
                         // 如果不想自动保存，可以写 setEditingKey(null)
                         handleRenameSave(node.key); 
                    }}
                    onClick={(e) => e.stopPropagation()} // 防止点击输入框时触发树节点的选中
                    className="flex-1 h-6 text-xs"
                />
            ) : (
                <div className="resource-tree-label">
                    <span className="resource-tree-name" title={node.title}>{node.title}</span>
                    {status && <span className="resource-tree-status" role="status" data-error={status.endsWith('失败') || undefined}>
                        {status}
                    </span>}
                </div>
            )}

            {layer && !isEditing && (
                <div className="resource-tree-actions"
                    onClick={event => event.stopPropagation()}
                    onDoubleClick={event => event.stopPropagation()}
                    onKeyDown={event => event.stopPropagation()}>
                    <Button
                        type="text" size="small" className="resource-layer-visibility"
                        icon={layer.hidden ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                        aria-label={`${visibilityAction} ${node.title}`}
                        title={layer.hidden ? visibilityAction : '隐藏地图图层（仍可参与分析）'}
                        disabled={layer.loadFailed || layer.totalFeatures === 0}
                        onClick={() => onToggleFileVisibility(node.key)}
                    />
                </div>
            )}
        </div>
    );
    // 如果正在编辑，不需要右键菜单（或者你可以保留）
    if (isEditing) {
        return content;
    }

    // 使用 Dropdown 实现右键菜单
    return (
        <Dropdown menu={{ items: menuItems, onClick: ({ domEvent }) => domEvent.stopPropagation() }} trigger={['contextMenu']}>
            {content}
        </Dropdown>
    );
  };

  const handleRenameSave = async (key: string) => {
    if (!isActive() || renamePendingRef.current) return;
    const name = editingValue.trim();
    if (!name) {
      message.warning('名称不能为空');
      setEditingKey(null);
      return;
    }
    renamePendingRef.current = true;
    try {
      await geoService.renameNode(key, name, sceneId);
      if (isActive()) {
        message.success('重命名成功');
        setEditingKey(null);
      }
      await refreshAfterMutation();
    } catch (error) {
      if (isActive()) message.error((error as Error).message);
    } finally {
      renamePendingRef.current = false;
    }
  };

  const handleDelete = (key: string, title: string) => {
    modal.confirm({
      title: '确认删除',
      icon: <ExclamationCircleOutlined />,
      content: `确定要删除 “${title}” 吗？文件夹内的资源也会被删除。`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        if (!isActive()) return;
        try {
          await geoService.deleteNode(key, sceneId);
          if (isActive()) message.success('删除成功');
          await refreshAfterMutation();
        } catch (error) {
          if (isActive()) message.error((error as Error).message);
        }
      },
    });
  };

  const selectedFolderId = () => uploadFolder && findNodeByKey(treeData, uploadFolder) ? uploadFolder : null;

  const openResource = (node: TreeNode) => {
    if (node.type === 'folder') {
      setUploadFolder(folder => folder === node.key ? null : node.key);
      return;
    }
    setUploadFolder(null);
    if (selectedKeysRef.current.includes(node.key)) onActivateFile(node.key, node.title);
    else syncSelection([...selectedKeysRef.current, node.key], treeData);
  };

  const expandFolder = (parentId: string | null) => {
    if (parentId) setExpandedKeys(keys => keys.includes(parentId) ? keys : [...keys, parentId]);
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length || uploading || !isActive()) return;

    const parentId = selectedFolderId();
    const previous = selectedKeysRef.current;
    setUploading(true);
    try {
      const uploaded = await geoService.uploadSceneFiles(sceneId, files, parentId);
      if (isActive()) {
        expandFolder(parentId);
        message.success(`已上传 ${uploaded.length} 个资源`);
      }
      await refreshAfterMutation({ keys: [...previous, ...uploaded.map(file => file._id)], previous });
    } catch (error) {
      if (isActive()) {
        const description = (error as { response?: { data?: { message?: string } } }).response?.data?.message;
        message.error(description || '上传失败');
      }
    } finally {
      if (isActive()) setUploading(false);
    }
  };

  const handleCreateFolder = async () => {
    const name = window.prompt('请输入文件夹名称')?.trim();
    if (!name || !isActive()) return;
    const parentId = selectedFolderId();
    try {
      const response = await fetch(getApiUrl(endpoint + '/folder'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parentId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || '创建文件夹失败');
      if (isActive()) {
        expandFolder(parentId);
        message.success('文件夹创建成功');
      }
      await refreshAfterMutation();
    } catch (error) {
      if (isActive()) message.error((error as Error).message);
    }
  };

  const focusedId = selectedFolderId() ?? activeFileId;

  return (
    <div className="flex flex-col h-full bg-[#111827]">
      {/* 1. 工具栏区域 (Toolbar)
         这里放"新建文件夹"和"上传"按钮
      */}
      <div className="resource-toolbar px-3 py-3 flex items-center justify-between border-b border-gray-800">
        <span className="font-bold text-gray-200 text-sm">资源</span>
        <div className="resource-toolbar-actions flex gap-2">
          {/* 新建文件夹 */}
          <Button
            size="small"
            type="primary"
            icon={<FolderAddOutlined />}
            className="text-gray-200! bg-blue-600 hover:bg-blue-500 border-none text-xs shadow-md"
            disabled={treeStatus !== 'ready'}
            onClick={handleCreateFolder}
          >
            新建文件夹
          </Button>

          {/* 上传数据 */}
          {/* 隐藏的原生 input */}
          <input 
            type="file" 
            ref={fileInputRef}
            style={{ display: 'none' }}
            multiple // 允许选多个
            accept=".json,.geojson,.csv,.shp,.dbf,.shx,.prj,.cpg,.tif,.tiff" // 限制文件类型
            onChange={handleFileChange}
          />
          {/* 触发 input 点击的按钮 */}
          <Button
              type="primary"
              size="small"
              icon={<CloudUploadOutlined />}
              className="text-gray-200! bg-blue-600 hover:bg-blue-500 border-none text-xs shadow-md"
              loading={uploading}
              disabled={treeStatus !== 'ready'}
              onClick={() => fileInputRef.current?.click()} // 触发点击
          >
              上传
          </Button>
        </div>
      </div>

      {/* 2. 树形列表区域 (Tree)
      */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-2">
        {treeStatus === 'error' ? (
          <div className="flex items-center justify-center gap-2 p-2 text-sm">
            <span>资源加载失败</span>
            <Button size="small" onClick={() => void fetchFileTree()}>重试</Button>
          </div>
        ) : treeStatus === 'loading' ? (
          <p className="p-3 text-sm text-gray-400" role="status">加载资源中</p>
        ) : treeData.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center">
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={<span className="text-gray-500">暂无数据</span>} />
          </div>
        ) : (
          <Tree<TreeNode>
            className="workspace-resource-tree"
            blockNode
            showIcon={false}
            expandedKeys={expandedKeys}
            onExpand={keys => setExpandedKeys(keys.map(String))}
            selectedKeys={focusedId ? [focusedId] : []}
            onSelect={(_, { node }) => openResource(node)}
            treeData={treeData}
            titleRender={titleRender}
            switcherIcon={<DownOutlined />}
          />
        )}
      </div>
    </div>
  );
};

export default FileTree;
