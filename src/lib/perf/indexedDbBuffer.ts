/**
 * Buffer mínimo en IndexedDB para snapshots de PerfTracker cuando no hay red
 * o el usuario aún no está autenticado. Sin dependencias externas.
 */

const DB_NAME = 'perf-telemetry';
const STORE = 'snapshots';
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function bufferSnapshot(payload: Record<string, unknown>): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).add({ payload, ts: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* almacenamiento no disponible — descartar silenciosamente */
  }
}

export async function drainBuffer(): Promise<Array<{ id: number; payload: Record<string, unknown> }>> {
  try {
    const db = await open();
    const items = await new Promise<Array<{ id: number; payload: Record<string, unknown> }>>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as Array<{ id: number; payload: Record<string, unknown> }>);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return items;
  } catch {
    return [];
  }
}

export async function deleteIds(ids: number[]): Promise<void> {
  if (!ids.length) return;
  try {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      ids.forEach((id) => store.delete(id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* noop */
  }
}