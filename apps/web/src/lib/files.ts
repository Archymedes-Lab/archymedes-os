/**
 * Document bytes. In the browser edition they stay on this device (IndexedDB);
 * in the cloud they go to the workspace's private storage.
 */
const DB = "archymedes-os-files";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("files");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putLocalFile(id: string, blob: Blob): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("files", "readwrite");
    tx.objectStore("files").put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getLocalFile(id: string): Promise<Blob | null> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction("files").objectStore("files").get(id);
    req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearLocalFiles(): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve) => {
    const tx = db.transaction("files", "readwrite");
    tx.objectStore("files").clear();
    tx.oncomplete = () => resolve();
  });
}

export async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const TEXT = /^(text\/|application\/(json|csv|xml|x-markdown))/;

/** First few thousand characters of a text document, kept for context and search. */
export async function textPreview(file: File): Promise<string> {
  if (!TEXT.test(file.type) && !/\.(md|txt|csv|json)$/i.test(file.name)) return "";
  return (await file.slice(0, 16_000).text()).replace(/\s+/g, " ").trim().slice(0, 4000);
}
