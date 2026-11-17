import { useEffect, useRef, useState } from 'react';
import type { Map } from 'maplibre-gl';
import type { DeckPointOptions, DeckPointLayer } from './deckPointLayer';

export function useDeckPointLayer(
  map: Map | null, options: DeckPointOptions | undefined, onReady: (fileId: string) => void,
  onError: (fileId: string) => void,
) {
  const layer = useRef<DeckPointLayer>();
  const [ready, setReady] = useState<DeckPointOptions>();

  useEffect(() => {
    if (!map || !options) return;
    let cancelled = false;
    let added: DeckPointLayer | undefined;
    let failed = false;
    const handleError = (error: unknown) => {
      if (cancelled || failed) return;
      failed = true;
      console.warn('deck.gl 点图层加载失败', error);
      onError(options.fileId);
    };

    void import('./deckPointLayer').then(({ addDeckPointLayer }) => {
      if (cancelled) return;
      added = addDeckPointLayer(map, options, () => {
        if (cancelled || failed) return;
        setReady(options);
        onReady(options.fileId);
      }, handleError);
      layer.current = added;
    }).catch(handleError);

    return () => {
      cancelled = true;
      layer.current = undefined;
      added?.dispose();
      setReady(previous => previous === options ? undefined : previous);
    };
  }, [map, options, onReady, onError]);

  return { layer, ready: !!options && ready === options };
}
