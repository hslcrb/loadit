/* Loadit DevTools Protocol recorder: user-initiated local capture only.
   No cookies, authorization headers, POST bodies or browser storage are recorded. */
const LoaditCapture = (() => {
  const sessions = new Map();
  const MAX_TOTAL = 28 * 1024 * 1024;
  const MAX_BODY = 3 * 1024 * 1024;
  const MAX_EVENTS = 400;
  const kinds = new Set(["Document", "Stylesheet", "Script", "Image", "Font", "Media", "XHR", "Fetch", "Other"]);
  function allowedURL(url) {
    try { return ["http:", "https:"].includes(new URL(url).protocol); }
    catch { return false; }
  }
  function onEvent(source, method, params) {
    const s = sessions.get(source.tabId);
    if (!s || !s.attached) return;
    if (method === "Network.requestWillBeSent") {
      // Only the HTTP method is retained; never save POST bodies or headers.
      const prior = s.requestMethods.get(params.requestId);
      s.requestMethods.set(params.requestId, params.request?.method || prior || "GET");
    } else if (method === "Network.responseReceived") {
      const response = params.response || {};
      if (!kinds.has(params.type) || !allowedURL(response.url)) return;
      s.requests.set(params.requestId, {
        url: response.url,
        type: params.type,
        status: response.status,
        statusText: response.statusText || "",
        mime: String(response.mimeType || "application/octet-stream"),
        // Do not persist Set-Cookie, Authorization, or other response headers.
        contentType: response.headers?.["content-type"] || response.headers?.["Content-Type"] || "",
        method: s.requestMethods.get(params.requestId) || "GET",
        timestamp: params.timestamp || 0
      });
    } else if (method === "Network.loadingFinished") {
      const item = s.requests.get(params.requestId);
      s.requests.delete(params.requestId);
      s.requestMethods.delete(params.requestId);
      if (!item || s.used >= MAX_TOTAL || s.resources.length >= MAX_EVENTS) return;
      const task = chrome.debugger.sendCommand({ tabId: source.tabId }, "Network.getResponseBody", {
        requestId: params.requestId
      }).then(result => {
        if (!sessions.has(source.tabId) || !result || typeof result.body !== "string") return;
        if (result.body.length > MAX_BODY * (result.base64Encoded ? 1.4 : 1.1)) return;
        const size = result.base64Encoded ? Math.floor(result.body.length * 0.75) : new TextEncoder().encode(result.body).length;
        if (size > MAX_BODY || s.used + size > MAX_TOTAL) return;
        s.used += size;
        const entry = {
          url: item.url,
          method: item.method,
          type: item.type,
          status: item.status,
          statusText: item.statusText,
          mime: item.contentType || item.mime,
          body: result.body,
          base64: !!result.base64Encoded
        };
        s.resources.push(entry);
      }).catch(() => {});
      s.pending.add(task);
      task.finally(() => s.pending.delete(task));
    } else if (method === "Network.webSocketCreated") {
      if (!allowedURL(String(params.url || "").replace(/^ws/, "http"))) return;
      const socket = { id: params.requestId, url: params.url, events: [], started: params.timestamp || 0 };
      s.sockets.set(params.requestId, socket);
    } else if (method === "Network.webSocketFrameReceived" || method === "Network.webSocketFrameSent") {
      const socket = s.sockets.get(params.requestId);
      if (!socket || socket.events.length >= MAX_EVENTS) return;
      const frame = params.response || {};
      if (String(frame.payloadData || "").length > 512 * 1024) return;
      const time = params.timestamp || 0;
      if (!socket.started) socket.started=time;
      socket.events.push({
        direction: method.endsWith("Received") ? "in" : "out",
        opcode: frame.opcode,
        data: frame.payloadData || "",
        at: Math.max(0, Math.round((time - (socket.started || time)) * 1000))
      });
    } else if (method === "Network.webSocketClosed") {
      const socket = s.sockets.get(params.requestId);
      if (socket) socket.closed = true;
    }
  }
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.debugger.onDetach.addListener(source => {
    const session = sessions.get(source.tabId);
    if (session) { session.attached = false; session.detached = true; }
  });
  async function attach(tabId) {
    if (sessions.has(tabId)) throw new Error("이 탭에서는 이미 네트워크 기록 중입니다.");
    const session = {
      tabId, attached: false, detached: false, requests: new Map(), requestMethods: new Map(), pending: new Set(),
      resources: [], sockets: new Map(), used: 0, errors: []
    };
    sessions.set(tabId, session);
    try {
      await chrome.debugger.attach({tabId}, "1.3");
      session.attached = true;
      await chrome.debugger.sendCommand({tabId}, "Network.enable", {
        maxTotalBufferSize: 40 * 1024 * 1024,
        maxResourceBufferSize: 4 * 1024 * 1024
      });
      await chrome.debugger.sendCommand({tabId}, "Page.enable");
    } catch(error) {
      session.errors.push("CDP 디버거 접근 실패: " + error.message);
      try { if (session.attached) await chrome.debugger.detach({tabId}); } catch {}
      session.attached = false;
    }
    return session;
  }
  async function navigate(tabId, url) {
    const session = sessions.get(tabId);
    if (session?.attached) {
      await chrome.debugger.sendCommand({tabId}, "Page.navigate", {url});
    } else {
      await chrome.tabs.update(tabId,{url});
    }
  }
  async function finish(tabId) {
    const session = sessions.get(tabId);
    if (!session) return {resources:[],websockets:[],errors:[]};
    // Flush response-body reads before detaching, otherwise DevTools requestId expires.
    const deadline = Date.now() + 4500;
    while (session.pending.size && Date.now() < deadline) {
      await Promise.race([Promise.allSettled([...session.pending]),new Promise(r=>setTimeout(r,500))]);
    }
    if (session.attached) {
      try { await chrome.debugger.detach({tabId}); } catch {}
    }
    sessions.delete(tabId);
    return {
      resources: session.resources,
      websockets:[...session.sockets.values()].map(({url,events,closed})=>({url,events,closed:!!closed})),
      errors: session.errors,
      bytes: session.used,
      detached: session.detached
    };
  }
  return { attach, navigate, finish };
})();
self.LoaditCapture = LoaditCapture;
