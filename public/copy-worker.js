// Copies a picked File into OPFS as "video" without blocking the page.
// Sync access handles are the one OPFS write API Chrome, Firefox and Safari
// all support, and they only exist in workers.
onmessage = async ({ data: file }) => {
  let handle;
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('video').catch(() => {});
    const fh = await root.getFileHandle('video', { create: true });
    handle = await fh.createSyncAccessHandle();
    const reader = file.stream().getReader();
    let at = 0;
    let lastReport = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      handle.write(value, { at });
      at += value.byteLength;
      if (at - lastReport > file.size / 100) {
        lastReport = at;
        postMessage({ p: at / file.size });
      }
    }
    handle.flush();
    handle.close();
    postMessage({ done: true });
  } catch (err) {
    try {
      handle?.close();
    } catch {}
    postMessage({ error: String(err) });
  }
};
