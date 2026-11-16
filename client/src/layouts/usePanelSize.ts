import { useLayoutEffect, useState, type RefObject } from 'react';

export function usePanelSize(ref: RefObject<HTMLElement>) {
    const [size, setSize] = useState({ width: 0, height: 0 });
    useLayoutEffect(() => {
        const panel = ref.current;
        if (!panel) return;
        const measure = () => {
            const { clientWidth: width, clientHeight: height } = panel;
            setSize(prev => prev.width === width && prev.height === height ? prev : { width, height });
        };
        const observer = new ResizeObserver(measure);
        observer.observe(panel);
        measure();
        return () => observer.disconnect();
    }, [ref]);
    return size;
}
