let activeUserId: string | null = null;

export function setAudioStorageUser(userId: string | null | undefined): void {
    activeUserId = typeof userId === "string" && userId.trim() ? userId.trim() : null;
}

export function audioStorageDatabaseName(userId = activeUserId): string {
    if (!userId?.trim()) {
        throw new Error("An authenticated audio cache scope is required.");
    }
    return `FilmScoreStudioAudio:${encodeURIComponent(userId.trim())}`;
}

export async function initAudioDB(userId?: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let databaseName: string;
    try {
        databaseName = audioStorageDatabaseName(userId);
    } catch (error) {
        reject(error);
        return;
    }
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('audio-chunks')) {
        request.result.createObjectStore('audio-chunks');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveAudioBlob(id: string, blob: Blob, userId?: string): Promise<void> {
    const db = await initAudioDB(userId);
  return new Promise((resolve, reject) => {
    const tx = db.transaction('audio-chunks', 'readwrite');
    const store = tx.objectStore('audio-chunks');
    const req = store.put(blob, id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export async function getAudioBlob(id: string, userId?: string): Promise<Blob | null> {
    const db = await initAudioDB(userId);
  return new Promise((resolve, reject) => {
    const tx = db.transaction('audio-chunks', 'readonly');
    const store = tx.objectStore('audio-chunks');
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteAudioBlob(id: string, userId?: string): Promise<void> {
    const db = await initAudioDB(userId);
  return new Promise((resolve, reject) => {
    const tx = db.transaction('audio-chunks', 'readwrite');
    const store = tx.objectStore('audio-chunks');
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}
