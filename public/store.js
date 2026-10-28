// Remembering the video file between visits.
//
// Chrome / Edge: keep a FileSystemFileHandle in IndexedDB and read the file
//   in place (no copy, any size). Chrome can grant read access "on every
//   visit"; otherwise one click re-grants it.
// Firefox / Safari: no file handles, so copy the file once into the site's
//   private storage (OPFS) and play it from there.

const DB = 'easysync';
const canHandle = 'showOpenFilePicker' in window;

function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('kv', mode);
      const req = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const get = (k) => idb('readonly', (s) => s.get(k));
const set = (k, v) => idb('readwrite', (s) => s.put(v, k));

export const remembersFiles = canHandle || 'storage' in navigator;

// Opens the file picker. Must be called from a click.
// onProgress(fraction) is called while a copy into OPFS runs.
export async function pickVideo(onProgress) {
  if (canHandle) {
    const [handle] = await showOpenFilePicker({
      id: 'easysync-video',
      types: [{ description: 'Video', accept: { 'video/*': ['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ogv'] } }],
    });
    await set('video', { kind: 'handle', handle, name: handle.name });
    return handle.getFile();
  }
  const file = await new Promise((resolve, reject) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'video/*' });
    input.onchange = () => (input.files[0] ? resolve(input.files[0]) : reject(new Error('no file')));
    input.oncancel = () => reject(new DOMException('cancelled', 'AbortError'));
    input.click();
  });
  const saved = await copyToOpfs(file, onProgress).catch(() => false);
  await set('video', saved ? { kind: 'opfs', name: file.name } : { kind: 'none', name: file.name });
  return file;
}

// Returns { file, name } on success, { needsClick: true } when the browser wants a
// click before re-granting access, or { missing: name|null } otherwise.
export async function loadVideo(fromClick = false) {
  const rec = await get('video').catch(() => null);
  if (!rec) return { missing: null };
  try {
    if (rec.kind === 'handle') {
      let perm = await rec.handle.queryPermission({ mode: 'read' });
      if (perm !== 'granted') {
        if (!fromClick) return { needsClick: true };
        perm = await rec.handle.requestPermission({ mode: 'read' });
        if (perm !== 'granted') return { needsClick: true };
      }
      return { file: await rec.handle.getFile(), name: rec.name };
    }
    if (rec.kind === 'opfs') {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle('video');
      return { file: await fh.getFile(), name: rec.name };
    }
  } catch {}
  return { missing: rec.name };
}

async function copyToOpfs(file, onProgress) {
  if (!navigator.storage?.getDirectory) return false;
  await navigator.storage.persist?.().catch(() => {});
  const { quota = Infinity, usage = 0 } = (await navigator.storage.estimate?.()) ?? {};
  if (quota - usage < file.size * 1.05) return false;
  return new Promise((resolve) => {
    const worker = new Worker(new URL('copy-worker.js', import.meta.url));
    worker.onmessage = ({ data }) => {
      if (data.p !== undefined) return onProgress?.(data.p);
      worker.terminate();
      resolve(!!data.done);
    };
    worker.onerror = () => {
      worker.terminate();
      resolve(false);
    };
    worker.postMessage(file);
  });
}
