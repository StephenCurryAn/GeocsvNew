import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Tree, Button, Empty, Input, Dropdown, type InputRef, type MenuProps, App as AntdApp } from 'antd';
import { FolderAddOutlined, CloudUploadOutlined, FileTextOutlined, GlobalOutlined,
         FileImageOutlined, TableOutlined, FolderFilled, CheckOutlined,
         DownOutlined, DeleteOutlined, EditOutlined, ExclamationCircleOutlined,
         PictureOutlined } from '@ant-design/icons';
import { geoService } from '../../../services/geoService';
import { getApiUrl } from '../../../services/apiConfig';
import { sceneFilesPath } from '../../../services/sceneService';
import { readSceneSelection, saveSceneSelection } from '../scenePreferences';

interface FileTreeProps {
  sceneId: string;
  isCurrentScene: (sceneId: string) => boolean;
  onSelectFiles: (fileNames: string[], fileIds: string[]) => void;
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

const FileTree: React.FC<FileTreeProps> = ({ sceneId, isCurrentScene, onSelectFiles }) => {
  const { message, modal } = AntdApp.useApp();
  const endpoint = sceneFilesPath(sceneId);
  const [selectedKeys, setSelectedKeys] = useState(() => readSceneSelection(sceneId));
  const selectedKeysRef = useRef(selectedKeys);
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
      setSelectedKeys(validKeys);
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
  // 辅助函数:标题渲染逻辑：实现"右侧对勾"效果
  // node 参数是由 Ant Design 的 <Tree /> 组件在内部调用时自动传过来的
  const titleRender = (node: TreeNode) => {
    const isSelected = selectedKeys.includes(node.key);
    const isEditing = editingKey === node.key; // 判断是否处于编辑模式
    const icon = getIcon(node);

    // 定义右键菜单项
    const menuItems: MenuProps['items'] = [
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
            className="flex items-center w-full pr-2 group h-8"
            // 双击触发重命名
            onDoubleClick={(e) => {
                e.stopPropagation(); // 防止触发展开折叠
                setEditingKey(node.key);
                setEditingValue(node.title);
            }}
        >
            <span className="mr-2 flex items-center justify-center shrink-0 min-w-5">
                {icon}
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
                <span className={`flex-1 truncate transition-colors ${isSelected ? 'text-blue-300 font-medium' : 'text-gray-200 group-hover:text-blue-400'}`}>
                    {node.title}
                </span>
            )}

            {isSelected && !isEditing && <CheckOutlined className="text-blue-500 text-sm ml-2" />}
        </div>
    );
    // 如果正在编辑，不需要右键菜单（或者你可以保留）
    if (isEditing) {
        return content;
    }

    // 使用 Dropdown 实现右键菜单
    return (
        <Dropdown menu={{ items: menuItems }} trigger={['contextMenu']}>
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

  const selectedFolderId = () => selectedKeysRef.current
    .find(key => findNodeByKey(treeData, key)?.type === 'folder') ?? null;

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
      await refreshAfterMutation({ keys: uploaded.map(file => file._id), previous });
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

  const handleTreeClick = (event: React.MouseEvent) => {
    if (!(event.target as HTMLElement).closest('.ant-tree-treenode')) syncSelection([], treeData);
  };

  return (
    <div className="flex flex-col h-full bg-[#111827]">
      {/* 1. 工具栏区域 (Toolbar)
         这里放"新建文件夹"和"上传"按钮
      */}
      <div className="px-3 py-3 flex items-center justify-between border-b border-gray-800">
        <span className="font-bold text-gray-200 text-sm">资源</span>
        <div className="flex gap-2">
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
      <div className="min-h-0 flex-1 overflow-y-auto py-2" onClick={treeStatus === 'ready' ? handleTreeClick : undefined}>
        {/* 🎨 样式注入：覆盖 Ant Design 默认的白色样式，适配黑色炫酷主题 */}
        <style>{`
          /* 1.  ：强制移除 Tree 组件的默认白色背景和黑色文字 */
          .dark-tree.ant-tree {
            background: transparent !important;
            color: #ffffff !important; /* ✨ 从 #9ca3af 改为 #e5e7eb (更亮) */
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
          }

          /* 2. 节点行样式 */
          .dark-tree .ant-tree-node-content-wrapper {
            display: flex !important;
            align-items: center;
            transition: all 0.2s;
            height: 32px !important;
            padding: 0 6px !important;
            color: #e5e7eb !important; /* ✨ 同样改为 #e5e7eb */
            border-radius: 4px;
          }

          /* 3. 悬停效果 (Hover)：淡淡的白色微光 */
          .dark-tree .ant-tree-node-content-wrapper:hover {
            background-color: rgba(255, 255, 255, 0.08) !important;
            color: #e5e7eb !important; /* text-gray-200 */
          }

          /* 4. 选中效果 (Selected)：科技蓝背景 + 高亮文字 */
          .dark-tree .ant-tree-treenode-selected .ant-tree-node-content-wrapper {
            background-color: rgba(37, 99, 235, 0.15) !important; /* 深蓝透明背景 */
            color: #60a5fa !important; /* text-blue-400 */
          }

          /* 5. 选中时的左侧高亮指示条 (装饰性细节) */
          .dark-tree .ant-tree-treenode-selected .ant-tree-node-content-wrapper::before {
             content: '';
             position: absolute;
             left: 0;
             top: 50%;
             transform: translateY(-50%);
             height: 14px;
             width: 3px;
             background-color: #3b82f6; /* blue-500 */
             border-radius: 0 2px 2px 0;
             box-shadow: 0 0 8px rgba(59, 130, 246, 0.6); /* 加一点发光效果 */
          }

          /* 6. 修正图标位置 */
          .dark-tree .ant-tree-iconEle {
             display: flex !important;
             align-items: center;
             justify-content: center;
             margin-right: 8px !important;
          }

          /* 7. 修正展开/折叠小箭头的颜色 */
          .dark-tree .ant-tree-switcher {
            background: transparent !important;
          }
          .dark-tree .ant-tree-switcher-icon {
            color: #6b7280 !important; /* gray-500 */
          }
        `}</style>

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
          <Tree
            multiple // 允许多选
            blockNode // 这个很重要，让整行都能点击
            showIcon={false}
            expandedKeys={expandedKeys}
            onExpand={keys => setExpandedKeys(keys.map(String))}
            selectedKeys={selectedKeys}
            onSelect={keys => syncSelection(keys.map(String), treeData)}
            // 对于这一步的treeData中的数据，<Tree /> 组件在渲染时，会遍历 treeData 数组里的每一个元素
            // treeData在组件内部循环
            treeData={treeData}
            // icon={getIcon}
            titleRender={titleRender}
            // 是Ant Design 的父级容器带着小三角图标转了 90 度
            // 稍微美化一下展开的小三角
            switcherIcon={({ expanded }) => (
              <span
                className="
                  flex items-center justify-center
                  text-gray-400       /* 1.  颜色：这里改成浅灰色，你可以改 */
                  hover:text-white    /* 可选：鼠标悬停时变亮 */
                  transition-transform duration-200 /* 可选：添加平滑过渡效果 */
                "
              >
                {expanded ? (
                  <DownOutlined
                    /* 2.  粗细：Ant Design 图标默认很细，通过加描边来实现“加粗”效果 */
                    style={{ strokeWidth: '150', stroke: 'currentColor' }}
                  />
                ) : (
                  <DownOutlined
                    style={{ strokeWidth: '150', stroke: 'currentColor' }}
                  />
                )}
              </span>
            )}
          />
        )}
      </div>
    </div>
  );
};

export default FileTree;
