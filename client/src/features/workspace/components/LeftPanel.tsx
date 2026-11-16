// client/src/features/workspace/components/LeftPanel.tsx
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { App as AntdApp, Button, Input, Modal, Segmented, Select } from 'antd';
import { AppstoreOutlined, ToolOutlined } from '@ant-design/icons';
import { sceneService, type Scene } from '../../../services/sceneService';
import { readActiveSceneId, saveActiveSceneId } from '../scenePreferences';
import FileTree, { type WorkspaceLayer } from './FileTree';
// 1. 引入新组件
import AnalysisPanel from '../../analysis/components/AnalysisPanel';

// 定义接口，接收从 App.tsx 传下来的回调
interface LeftPanelProps {
  onSelectFiles?: (fileNames: string[], fileIds: string[]) => void;
  onSceneChange?: (scene: Scene) => void;
  onActivateFile: (fileId: string, fileName: string) => void;
  onToggleFileVisibility: (fileId: string) => void;
  layers: Record<string, WorkspaceLayer>;
  selectedFileIds: string[];
  activeFileId: string;
  activeFileFields: string[];
}

const LeftPanel: React.FC<LeftPanelProps> = ({ 
  onSceneChange,
  onSelectFiles,
  onActivateFile,
  onToggleFileVisibility,
  layers,
  selectedFileIds, 
  activeFileId, 
  activeFileFields 
}) => {
  // 控制显示哪个组件
  const [activeTab, setActiveTab] = useState<string>('workspace');
  const { message } = AntdApp.useApp();
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [activeScene, setActiveScene] = useState<Scene | null>(null);
  const [listError, setListError] = useState(false);
  const [listAttempt, setListAttempt] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [sceneName, setSceneName] = useState('');
  const [creating, setCreating] = useState(false);
  const activeSceneRef = useRef<Scene | null>(null);
  const callbacksRef = useRef({ onSceneChange, onSelectFiles });
  useLayoutEffect(() => {
    callbacksRef.current = { onSceneChange, onSelectFiles };
  }, [onSceneChange, onSelectFiles]);

  const notifySelection = useCallback((names: string[], ids: string[]) => {
    callbacksRef.current.onSelectFiles?.(names, ids);
  }, []);

  const activateScene = useCallback((scene: Scene) => {
    if (activeSceneRef.current?.id === scene.id) return;
    activeSceneRef.current = scene;
    saveActiveSceneId(scene.id);
    setActiveScene(scene);
    callbacksRef.current.onSceneChange?.(scene);
    notifySelection([], []);
  }, [notifySelection]);

  const isCurrentScene = useCallback((id: string) => activeSceneRef.current?.id === id, []);

  useEffect(() => {
    const controller = new AbortController();
    sceneService.list(controller.signal).then(list => {
      if (controller.signal.aborted) return;
      const scene = list.find(item => item.id === readActiveSceneId()) ?? list.find(item => item.isDefault);
      if (!scene) {
        setListError(true);
        return;
      }
      setScenes(list);
      activateScene(scene);
    }).catch(() => {
      if (!controller.signal.aborted) setListError(true);
    });
    return () => controller.abort();
  }, [activateScene, listAttempt]);

  const handleCreateScene = async () => {
    const name = sceneName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const scene = await sceneService.create(name);
      setScenes(list => [...list, scene]);
      activateScene(scene);
      setCreateOpen(false);
      setSceneName('');
    } catch {
      message.error('创建场景失败，请重试');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-[#111827] text-white">
      
      {/* 1. 顶部 Tab 切换 (始终显示) */}
      <div className="p-3 border-b border-gray-800">
        <Segmented
          block
          value={activeTab}
          onChange={(val) => setActiveTab(val as string)}
          options={[
            { 
              label: '资源管理', 
              value: 'workspace', 
              icon: <AppstoreOutlined /> 
            },
            { 
              label: '分析工具', 
              value: 'analysis', 
              icon: <ToolOutlined /> 
            },
          ]}
          className="bg-gray-800 text-gray-400 custom-segmented"
        />
        {/* CSS 穿透：强制  Segmented 样式适配深色模式 */}
        <style>{`
          .custom-segmented .ant-segmented-item-selected {
            background-color: #1677ff !important;
            color: white !important;
            box-shadow: 0 2px 4px rgba(0,0,0,0.4);
          }
          .custom-segmented .ant-segmented-item:hover:not(.ant-segmented-item-selected) {
            background-color: rgba(255,255,255,0.08) !important;
            color: white !important;
          }
          .custom-segmented .ant-segmented-item {
             color: #9ca3af; /* text-gray-400 */
          }
        `}</style>
      </div>

      <div className="flex-1 overflow-hidden relative">
        <div className="flex h-full flex-col" style={{ display: activeTab === 'workspace' ? undefined : 'none' }}>
          <div className="workspace-scene-controls flex items-center gap-2 border-b border-gray-800 p-3">
            <Select
              aria-label="活动场景"
              placeholder={listError ? '场景加载失败' : '加载场景中'}
              loading={!listError && !activeScene}
              disabled={!activeScene}
              value={activeScene?.id}
              options={scenes.map(scene => ({ value: scene.id, label: scene.name }))}
              onChange={id => {
                const scene = scenes.find(item => item.id === id);
                if (scene) activateScene(scene);
              }}
              className="min-w-0 flex-1"
            />
            {listError ? (
              <Button onClick={() => { setListError(false); setListAttempt(attempt => attempt + 1); }}>重试</Button>
            ) : (
              <Button disabled={!activeScene} onClick={() => setCreateOpen(true)}>新建场景</Button>
            )}
          </div>
          {activeScene && (
            <div className="min-h-0 flex-1">
              <FileTree
                key={activeScene.id}
                sceneId={activeScene.id}
                isCurrentScene={isCurrentScene}
                onSelectFiles={notifySelection}
                activeFileId={activeFileId}
                onActivateFile={onActivateFile}
                onToggleFileVisibility={onToggleFileVisibility}
                layers={layers}
              />
            </div>
          )}
        </div>
        {activeTab === 'analysis' && (
          <AnalysisPanel fileId={activeFileId} selectedFileIds={selectedFileIds} fields={activeFileFields} />
        )}
      </div>
      <Modal
        open={createOpen}
        title="新建场景"
        okText="创建"
        cancelText="取消"
        okButtonProps={{ disabled: !sceneName.trim() }}
        confirmLoading={creating}
        onOk={handleCreateScene}
        onCancel={() => {
          if (creating) return;
          setCreateOpen(false);
          setSceneName('');
        }}
      >
        <Input
          aria-label="场景名称"
          placeholder="场景名称"
          maxLength={255}
          value={sceneName}
          onChange={event => setSceneName(event.target.value)}
          onPressEnter={handleCreateScene}
        />
      </Modal>
    </div>
  );
};

export default LeftPanel;
