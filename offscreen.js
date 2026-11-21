/* Object URLs must be created in a document: MV3 service workers lack createObjectURL. */
const urls = new Map();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === "OFFSCREEN_BLOB") {
    const key = crypto.randomUUID();
    const blob = new Blob([message.content], { type: message.mime || "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    urls.set(key, url);
    respond({ ok: true, url, key, bytes: blob.size });
    return;
  }
  if (message?.type === "OFFSCREEN_RELEASE") {
    const url = urls.get(message.key);
    if (url) { URL.revokeObjectURL(url); urls.delete(message.key); }
    respond({ ok: true });
  }
});
