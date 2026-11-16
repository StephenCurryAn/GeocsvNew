import { useRef } from 'react';

export const SEPARATOR_SIZE = 6;

interface PanelSeparatorProps {
    label: string;
    controls: string;
    horizontal?: boolean;
    reverse?: boolean;
    value: number;
    min: number;
    max: number;
    collapsed?: boolean;
    onResize: (value: number, startValue: number, fromPointer: boolean) => void;
    onDraggingChange?: (dragging: boolean) => void;
}

export default function PanelSeparator({
    label, controls, horizontal = false, reverse = false, value, min, max, collapsed,
    onResize, onDraggingChange,
}: PanelSeparatorProps) {
    const drag = useRef<{ pointerId: number; start: number; value: number } | null>(null);
    const clamp = (next: number) => Math.min(max, Math.max(min, next));
    const direction = reverse ? -1 : 1;
    const forwardKey = horizontal ? 'ArrowDown' : 'ArrowRight';
    const backwardKey = horizontal ? 'ArrowUp' : 'ArrowLeft';

    return (
        <div
            className="panel-separator"
            role="separator"
            tabIndex={0}
            aria-label={label}
            aria-controls={controls}
            aria-orientation={horizontal ? 'horizontal' : 'vertical'}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuenow={value}
            aria-valuetext={collapsed ? '已收起' : value + ' 像素'}
            onPointerDown={event => {
                if (event.button !== 0 || !event.isPrimary) return;
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                drag.current = {
                    pointerId: event.pointerId, start: horizontal ? event.clientY : event.clientX, value,
                };
                onDraggingChange?.(true);
                event.preventDefault();
            }}
            onPointerMove={event => {
                const start = drag.current;
                if (!start || start.pointerId !== event.pointerId) return;
                const position = horizontal ? event.clientY : event.clientX;
                onResize(clamp(start.value + (position - start.start) * direction), start.value, true);
            }}
            onLostPointerCapture={() => {
                drag.current = null;
                onDraggingChange?.(false);
            }}
            onKeyDown={event => {
                let next: number;
                const step = event.shiftKey ? 32 : 8;
                switch (event.key) {
                    case forwardKey: next = value + direction * step; break;
                    case backwardKey: next = value - direction * step; break;
                    case 'Home': next = min; break;
                    case 'End': next = max; break;
                    default: return;
                }
                event.preventDefault();
                onResize(clamp(next), value, false);
            }}
        />
    );
}
