const activeSceneKey = 'geocsv:active-scene';
const selectionKey = (sceneId: string) => `geocsv:scene-selection:${sceneId}`;

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

export function readSceneSelection(sceneId: string): string[] {
  try {
    const ids: unknown = JSON.parse(readPreference(selectionKey(sceneId)) ?? '[]');
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export const saveSceneSelection = (sceneId: string, fileIds: string[]) =>
  writePreference(selectionKey(sceneId), JSON.stringify(fileIds));
