import { DEFAULT_SELECTION_STYLE, type SelectionStyle } from '../map/fileLayers';

const activeSceneKey = 'geocsv:active-scene';
const selectionKey = (sceneId: string) => `geocsv:scene-selection:${sceneId}`;
const layerOrderKey = (sceneId: string) => `geocsv:layer-order:${sceneId}`;
const selectionStyleKey = 'geocsv:selection-style';
const deckPointLayerKey = 'geocsv:deck-point-layer';

function readPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The workspace remains usable if the browser disables local storage.
  }
}

export const readActiveSceneId = () => readPreference(activeSceneKey);
export const saveActiveSceneId = (sceneId: string) => writePreference(activeSceneKey, sceneId);
export const readDeckPointLayer = () => readPreference(deckPointLayerKey) || undefined;
export const saveDeckPointLayer = (fileId?: string) => writePreference(deckPointLayerKey, fileId ?? '');

function readIdList(key: string): string[] {
  try {
    const ids: unknown = JSON.parse(readPreference(key) ?? '[]');
    return Array.isArray(ids) ? [...new Set(ids.filter((id): id is string => typeof id === 'string'))] : [];
  } catch {
    return [];
  }
}

export const readSceneSelection = (sceneId: string) => readIdList(selectionKey(sceneId));
export const saveSceneSelection = (sceneId: string, fileIds: string[]) =>
  writePreference(selectionKey(sceneId), JSON.stringify(fileIds));

export const readLayerOrder = (sceneId: string) => readIdList(layerOrderKey(sceneId));
export const saveLayerOrder = (sceneId: string, fileIds: string[]) =>
  writePreference(layerOrderKey(sceneId), JSON.stringify(fileIds));

export function readSelectionStyle(): SelectionStyle {
  try {
    const style = JSON.parse(readPreference(selectionStyleKey) ?? 'null') as SelectionStyle | null;
    if (style && [style.point.color, style.line.color, style.polygon.color].every(color => /^#[\da-f]{6}$/i.test(color))
        && [style.point.radius, style.line.width, style.polygon.outlineWidth].every(size => Number.isFinite(size) && size >= 0 && size <= 40)
        && Number.isFinite(style.polygon.opacity) && style.polygon.opacity >= 0 && style.polygon.opacity <= 1) return style;
  } catch {
    // Restore defaults if a stored preference is obsolete.
  }
  return DEFAULT_SELECTION_STYLE;
}

export const saveSelectionStyle = (style: SelectionStyle) =>
  writePreference(selectionStyleKey, JSON.stringify(style));
