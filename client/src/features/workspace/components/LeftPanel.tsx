// client/src/features/workspace/components/LeftPanel.tsx
import React, { useState } from 'react';
import { Segmented } from 'antd';
import { AppstoreOutlined, ToolOutlined } from '@ant-design/icons';
import FileTree from './FileTree';
// 1. 引入新组件
import AnalysisPanel from '../../analysis/components/AnalysisPanel';

// 定义接口，接收从 App.tsx 传下来的回调
interface LeftPanelProps {
  onDataLoaded: (fileName: string, data: any, fileId: string) => void;
  onSelectFile?: (fileName: string, fileId?: string) => void;
  // ✅ 新增
  activeFileId: string;
  activeFileFields: string[];
}

const LeftPanel: React.FC<LeftPanelProps> = ({ onDataLoaded, onSelectFile, activeFileId, activeFileFields }) => {
  // 控制显示哪个组件
  const [activeTab, setActiveTab] = useState<string>('workspace');

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
        {/* CSS 穿透：强制修改 Segmented 样式适配深色模式 */}
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

      {/* 2. 内容区域 (根据 Tab 切换) */}
      <div className="flex-1 overflow-hidden relative">
        {activeTab === 'workspace' ? (
          // A. 显示文件树组件 (包含上传、新建、列表)
          <FileTree 
            onDataLoaded={onDataLoaded}
            onSelectFile={onSelectFile}
          />
        ) : (
          // ✅ 4. 替换原来的占位符
          <AnalysisPanel 
             fileId={activeFileId} 
             fields={activeFileFields}
          />
        )}
      </div>
    </div>
  );
};

export default LeftPanel;