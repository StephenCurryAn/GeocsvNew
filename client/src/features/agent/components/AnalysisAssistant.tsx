import { useState } from 'react';
import { Segmented } from 'antd';
import UnifiedAnalysisAssistant from '../../analysis/components/UnifiedAnalysisAssistant';
import ExperimentalAnalysisAssistant from './ExperimentalAnalysisAssistant';

type AssistantMode = 'operator' | 'experimental';

export default function AnalysisAssistant({ sceneId, selectedFileIds }: {
    sceneId: string;
    selectedFileIds: string[];
}) {
    const [mode, setMode] = useState<AssistantMode>('operator');

    return (
        <div className="agent-panel">
            <div className="agent-mode">
                <Segmented<AssistantMode>
                    aria-label="助手模式"
                    options={[{ label: '自然语言', value: 'operator' }, { label: '实验流程', value: 'experimental' }]}
                    value={mode}
                    onChange={setMode}
                    size="small"
                    block
                />
            </div>
            <div className={`min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${mode === 'operator' ? 'flex' : 'hidden'}`}>
                <UnifiedAnalysisAssistant key={sceneId} sceneId={sceneId} onSwitchToLegacy={() => setMode('experimental')} />
            </div>
            <ExperimentalAnalysisAssistant active={mode === 'experimental'} selectedFileIds={selectedFileIds} />
        </div>
    );
}
