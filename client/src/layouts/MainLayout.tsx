import React, { useState, useRef, useEffect } from 'react';
import GeoAIAgent from '../features/agent/components/GeoAIAgent'; //   引入新组件

const MIN_SIDEBAR_WIDTH = 150; // 侧边栏最小展开宽度
const MIN_TABLE_WIDTH = 200;   // 中间表格最小展开宽度
const SNAP_THRESHOLD = 80;     // 拖动小于此像素时，自动折叠隐藏

// children?的意思是：children 是 React 的保留字，代表**“写在组件标签中间的内容”**
// React.ReactNode是 React 中最宽泛的类型
// = ({ children }) => { ... }解构赋值，直接把 props 对象里的 children 拿出来，方便后面直接用
const MainLayout: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  // 1. 定义宽度状态 (统一使用 px，比百分比更精确且计算简单)
  const [sidebarWidth, setSidebarWidth] = useState<number>(260); // 左侧面板一个初始像素宽
  const [tableWidth, setTableWidth] = useState<number>(500); // 中间面板一个初始像素宽

  // 2. 使用 ref 存储拖拽过程中的临时数据，避免闭包陷阱
  // 最后面的（null）表示初始值，意味着组件刚加载时，没有进行拖拽操作，所以这个“口袋”是空的
  // Ref类型不会导致组件重新渲染，适合存储拖拽等临时状态
  const dragInfoRef = useRef<{
    type: 'sidebar' | 'table';
    startX: number;
    startWidth: number;
  } | null>(null);

  // 3. 开始拖拽
  //e.preventDefault() 阻止默认行为，避免拖拽时选中文字等问题 
  const handleMouseDown = (type: 'sidebar' | 'table', e: React.MouseEvent) => {
    e.preventDefault();
    dragInfoRef.current = {
      type,
      startX: e.clientX,
      startWidth: type === 'sidebar' ? sidebarWidth : tableWidth,
    };
    
    // 拖拽时添加鼠标全局样式，并防止选中文字，提升体验
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    
    // 绑定事件到 document，保证鼠标移出组件也能响应
    // mousemove表示鼠标移动；mouseup表示鼠标释放（一旦松手，就触发 handleMouseUp 函数）
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  // 4. 拖拽移动 (提取出来，不依赖 state)
  const handleMouseMove = (e: MouseEvent) => {
    if (!dragInfoRef.current) return;

    const { type, startX, startWidth } = dragInfoRef.current;
    const deltaX = e.clientX - startX; // 计算鼠标移动距离

    // 计算原始的目标宽度（不带限制的）
    const rawWidth = startWidth + deltaX;

    if (type === 'sidebar') {
      // 逻辑：如果宽度小于阈值，直接变成 0；否则，限制在 [MIN, MAX] 之间
      // 限制左侧面板最小 150px，最大 500px
      if (rawWidth < SNAP_THRESHOLD) {
        setSidebarWidth(0);
      } else {
        // Math.max 保证展开时至少是 150，防止出现 10px 这种极窄的情况
        // 设置最小值MIN_SIDEBAR_WIDTH限制，是为了防止用户一拖到阈值的宽度，就立马收缩，从而导致体验感不好
        const newWidth = Math.max(MIN_SIDEBAR_WIDTH, Math.min(500, rawWidth));
        setSidebarWidth(newWidth);
      }
    } else if (type === 'table') {
      // 限制中间面板最小 200px，最大剩余空间的 80% (简单做个最大限制)
      // 注意：这里是调整 Table 的宽度
      if (rawWidth < SNAP_THRESHOLD) {
        setTableWidth(0);
      } else {
        const newWidth = Math.max(MIN_TABLE_WIDTH, Math.min(window.innerWidth - sidebarWidth - 100, rawWidth));
        setTableWidth(newWidth);
      }
    }
  };

  // 5. 结束拖拽
  const handleMouseUp = () => {
    dragInfoRef.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    
    // 移除监听器
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  };
  
  // 6. 清理副作用 (组件卸载时确保监听器被移除)
  // []空数组表示这个副作用只在组件挂载时候运行一次，并且只在卸载时运行一次
  // return () => { ... } 这是一个清理函数，在组件卸载时候调用 
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  const childrenArray = React.Children.toArray(children);

  return (
    <div className="w-screen h-screen overflow-hidden flex flex-row bg-geo-dark select-none">
      
      {/* --- 左侧面板 --- */}
      <div
        className="shrink-0 flex flex-col bg-geo-panel border-r border-geo-border"
        style={{ width: `${sidebarWidth}px`, 
          // 当宽度为 0 时，隐藏边框以避免出现一条难看的细线（可选优化）
          borderRightWidth: sidebarWidth === 0 ? 0 : '1px',
          transition: dragInfoRef.current ? 'none' : 'width 0.1s ease-out' // 加一点 ease-out 让松手后的潜在动画更顺滑 
        }}
      >
        <div className={`w-full h-full flex flex-col ${sidebarWidth < MIN_SIDEBAR_WIDTH ? 'opacity-0' : 'opacity-100'} transition-opacity duration-100`}>
          <div className="h-12 flex items-center px-4 border-b border-geo-border">
            <h2 className="text-sm font-medium text-geo-text-primary">工作空间</h2>
          </div>
          <div className="flex-1 overflow-auto p-2">
            {childrenArray[0]}
          </div>
        </div>
      </div>

      {/* --- 拖拽条 1 (左侧 <-> 中间) --- */}
      {/* 如果你确实希望左侧固定，可以移除 onMouseDown 事件，或者保留它用来调整左侧宽度 */}
      <div
        className="w-1 hover:w-2 -ml-0.5 z-10 cursor-col-resize hover:bg-geo-accent transition-all flex items-center justify-center group"
        onMouseDown={(e) => handleMouseDown('sidebar', e)}
        // 可选：双击拖拽条快速还原/折叠
        onDoubleClick={() => setSidebarWidth(prev => prev === 0 ? 260 : 0)}
      >
         <div className="w-0.5 h-full bg-transparent group-hover:bg-geo-accent opacity-50 transition-opacity" />
      </div>

      {/* --- 中间面板 --- */}
      <div
        className="shrink-0 flex flex-col bg-geo-dark"
        style={{ 
          width: `${tableWidth}px`,
          transition: dragInfoRef.current ? 'none' : 'width 0.1s ease-out'
        }}
      >
        {/* 同样增加内容隐藏逻辑 */}
         <div className={`w-full h-full flex flex-col ${tableWidth < MIN_TABLE_WIDTH ? 'opacity-0' : 'opacity-100'} transition-opacity duration-100`}>
            <div className="h-12 flex items-center px-4 border-b border-geo-border">
              <h2 className="text-sm font-medium text-geo-text-primary">数据透视</h2>
            </div>
            <div className="flex-1 overflow-hidden p-2">
              {childrenArray[1]}
            </div>
        </div>
      </div>

      {/* --- 拖拽条 2 (中间 <-> 右侧) --- */}
      <div
        className="w-1 hover:w-2 -ml-0.5 z-10 cursor-col-resize hover:bg-geo-accent transition-all flex items-center justify-center group"
        onMouseDown={(e) => handleMouseDown('table', e)}
        onDoubleClick={() => setTableWidth(prev => prev === 0 ? 500 : 0)}
      >
         <div className="w-0.5 h-full bg-transparent group-hover:bg-geo-accent opacity-50 transition-opacity" />
      </div>

      {/* --- 右侧面板 (自动填充剩余空间) --- */}
      <div className="flex-1 flex flex-col min-w-50 bg-linear-to-br from-geo-panel to-black">
        <div className="h-12 flex items-center px-4 border-b border-geo-border">
          <h2 className="text-sm font-medium text-geo-text-primary">地图可视化</h2>
        </div>
        <div className="flex-1 overflow-hidden relative">
          {childrenArray[2]}
        </div>
      </div>

      {/*   放置悬浮 GeoAI 智能体 */}
      <GeoAIAgent />

    </div>
  );
};

export default MainLayout;