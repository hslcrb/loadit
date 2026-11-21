/* Loadit archive engine — no build tools, libraries, Node, or server required. */
/* Snapshot execution is deliberately self-contained because chrome.scripting serializes it. */
async function loaditSnapshot(options) {
  const failures = [];
  const assets = new Map();
  const recorded = new Map((options.resources || []).filter(x => x && x.url).map(x => [x.url,x]));
  const scripts = [];
  function fromCDP(url) { return recorded.get(url) || recorded.get(url.split("#")[0]); }
  function encodeRecorded(entry) {
    if (entry.base64) return "data:" + entry.mime + ";base64," + entry.body;
    const bytes = new TextEncoder().encode(entry.body);
    let binary = "";
    for (let i=0;i<bytes.length;i+=16384) binary += String.fromCharCode(...bytes.subarray(i,i+16384));
    return "data:" + entry.mime + ";base64," + btoa(binary);
  }
  let bytesUsed = 0;
  const maxTotal = Math.min(25 * 1024 * 1024, Math.max(2 * 1024 * 1024, options.maxBytes || 10 * 1024 * 1024));
  const maxAsset = Math.min(8 * 1024 * 1024, maxTotal);
  function absolute(value, base) {
    try { const u = new URL(value, base || document.baseURI); return ["https:", "http:", "blob:", "data:"].includes(u.protocol) ? u.href : null; }
    catch { return null; }
  }
  function mark(url, reason) { if (failures.length < 100) failures.push({ url: String(url).slice(0, 250), reason }); }
  async function asData(source, base) {
    const url = absolute(source, base);
    if (!url) return null;
    if (url.startsWith("data:")) return url;
    if (assets.has(url)) return assets.get(url);
    const cached = fromCDP(url);
    if (cached && cached.body.length < maxAsset * 1.4) return encodeRecorded(cached);
    const task = (async () => {
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 7000);
        let response;
        try { response = await fetch(url, { credentials: "include", signal: ctrl.signal }); }
        finally { clearTimeout(timeout); }
        if (!response.ok) throw new Error("HTTP " + response.status);
        const declared = Number(response.headers.get("content-length") || 0);
        if (declared > maxAsset) throw new Error("file-size limit");
        const blob = await response.blob();
        if (blob.size > maxAsset || bytesUsed + blob.size > maxTotal) throw new Error("archive-size limit");
        bytesUsed += blob.size;
        return await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("FileReader failed"));
          reader.readAsDataURL(blob);
        });
      } catch (error) { mark(url, error.message); return null; }
    })();
    assets.set(url, task);
    return task;
  }
  async function stylesheet(url) {
    const source = fromCDP(url);
    if (source && !source.base64 && source.type === "Stylesheet") return source.body;
    try {
      const ctrl = new AbortController(); const timeout = setTimeout(() => ctrl.abort(), 8000);
      let response;
      try { response = await fetch(url, { credentials: "include", signal: ctrl.signal }); }
      finally { clearTimeout(timeout); }
      if (!response.ok) throw Error("CSS HTTP " + response.status);
      const length = Number(response.headers.get("content-length") || 0);
      if (length > 2 * 1024 * 1024) throw Error("CSS too large");
      const text = await response.text();
      if (text.length > 2 * 1024 * 1024) throw Error("CSS too large");
      return text;
    } catch (error) { mark(url, error.message); return null; }
  }
  async function inlineCSS(css, base) {
    const expressions = [...css.matchAll(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]*?))\s*\)/gi)];
    const updates = await Promise.all(expressions.map(async match => {
      const raw = (match[1] || match[2] || match[3] || "").trim();
      if (!raw || raw.startsWith("#")) return "url(" + JSON.stringify(raw) + ")";
      const data = await asData(raw, base);
      return data ? "url(" + JSON.stringify(data) + ")" : "url(\"\")";
    }));
    let index = 0;
    const changed = css.replace(/url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]*?))\s*\)/gi, () => updates[index++]);
    return changed.replace(/@import\s+[^;]+;/gi, () => { mark(base, "CSS @import not available in offline export"); return ""; });
  }
  const originalLinks = [...document.querySelectorAll("a[href]")];
  const links = [...new Set(originalLinks.map(a => absolute(a.getAttribute("href"))).filter(x => {
    if (!x) return false;
    try { return ["http:", "https:"].includes(new URL(x).protocol); } catch { return false; }
  }).map(x => { const u = new URL(x); u.hash = ""; return u.href; }))].slice(0, 350);
  const root = document.documentElement.cloneNode(true);
  const head = root.querySelector("head");
  // Preserve original script source as inert templates. The viewer only runs it in opt-in replay mode.
  const originalScripts = [...document.querySelectorAll("script")];
  const placeholders = [...root.querySelectorAll("script")];
  let scriptBudget = 0;
  for (let i=0; i<placeholders.length; i++) {
    const original=originalScripts[i], holder=placeholders[i];
    const type=String(original?.type || "").toLowerCase();
    const supported = !type || ["text/javascript","application/javascript","module"].includes(type);
    if(!supported) { holder.remove(); continue; }
    let code = original?.src ? fromCDP(original.src)?.body : original?.textContent;
    let isModule = type === "module";
    if(original?.src && !code) { mark(original.src,"실행 스크립트 응답 수집 실패"); holder.remove(); continue; }
    if(original?.src && fromCDP(original.src)?.base64) { mark(original.src,"바이너리 스크립트"); holder.remove(); continue; }
    code=String(code||"");
    if(code.length>1100000 || scriptBudget+code.length>4000000) { mark(original?.src||"inline script","실행 스크립트 크기 제한"); holder.remove(); continue; }
    scriptBudget+=code.length;
    const placeholder=document.createElement("template");
    placeholder.setAttribute("data-loadit-script", String(scripts.length));
    holder.replaceWith(placeholder);
    scripts.push({code,type:isModule?"module":"text/javascript",src:original?.src||null});
  }
  if (head) {
    const policy = document.createElement("meta");
    policy.httpEquiv = "Content-Security-Policy";
    policy.content = "default-src 'none'; img-src data:; font-src data:; media-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
    head.prepend(policy);
  }
  for (const el of root.querySelectorAll("script,base,meta[http-equiv],link[rel~=preconnect],link[rel~=dns-prefetch],link[rel~=icon],link[rel~=manifest],iframe,object,embed")) {
    if (el.tagName === "IFRAME" || el.tagName === "OBJECT" || el.tagName === "EMBED") {
      const placeholder = document.createElement("div");
      placeholder.textContent = "Loadit: 내장 프레임/객체는 오프라인 페이지에 포함되지 않았습니다.";
      el.replaceWith(placeholder);
    } else if (!(el.tagName === "META" && el.getAttribute("http-equiv") === "Content-Security-Policy" && el === head?.firstChild)) {
      el.remove();
    }
  }
  // Existing external script execution and any inline on* event handlers are suppressed.
  for (const el of root.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      if (attr.name.toLowerCase().startsWith("on") || /^(?:javascript|vbscript):/i.test(attr.value.trim())) el.removeAttribute(attr.name);
    }
  }
  const origForms = [...document.querySelectorAll("input,textarea,select")];
  const copyForms = [...root.querySelectorAll("input,textarea,select")];
  for (let i = 0; i < Math.min(origForms.length, copyForms.length); i++) {
    const from = origForms[i], to = copyForms[i];
    if (from.tagName === "INPUT") {
      if (from.type === "password" || from.type === "hidden" || from.type === "file") to.removeAttribute("value");
      else if (from.type === "checkbox" || from.type === "radio") {
        if (from.checked) to.setAttribute("checked", ""); else to.removeAttribute("checked");
      } else to.setAttribute("value", from.value);
    } else if (from.tagName === "TEXTAREA") to.textContent = from.value;
    else { const a = [...from.options], b = [...to.options]; b.forEach((item,j) => {
      if (a[j]?.selected) item.setAttribute("selected", ""); else item.removeAttribute("selected");
    }); }
  }
  const originalStyles = [...document.querySelectorAll('link[rel~="stylesheet"]')];
  const copies = [...root.querySelectorAll('link[rel~="stylesheet"]')];
  for (let i = 0; i < copies.length; i++) {
    const copy = copies[i], source = originalStyles[i];
    const url = source?.href;
    let css = url ? await stylesheet(url) : null;
    if (css === null && source?.sheet) {
      try { css = [...source.sheet.cssRules].map(rule => rule.cssText).join("\n"); }
      catch { css = null; }
    }
    if (css !== null) {
      const style = document.createElement("style");
      style.textContent = await inlineCSS(css, url);
      copy.replaceWith(style);
    } else { if (url) mark(url, "stylesheet omitted"); copy.remove(); }
  }
  for (const style of root.querySelectorAll("style")) {
    // Newly inlined styles can have been processed already; data: URLs remain unchanged.
    style.textContent = await inlineCSS(style.textContent, document.baseURI);
  }
  for (const el of root.querySelectorAll("[style]")) el.setAttribute("style", await inlineCSS(el.getAttribute("style"), document.baseURI));
  const originalImages = [...document.querySelectorAll("img")];
  const copyImages = [...root.querySelectorAll("img")];
  // Capped parallelism avoids a 7-second serial delay for every unavailable image.
  let nextImage = 0;
  const imageWorkers = Array.from({ length: Math.min(6, copyImages.length) }, async () => {
    while (nextImage < copyImages.length) {
      const i = nextImage++;
      const copy = copyImages[i], orig = originalImages[i];
      const url = orig?.currentSrc || orig?.getAttribute("src") || copy.getAttribute("src");
      const data = await asData(url);
      if (data) copy.setAttribute("src", data);
      else copy.removeAttribute("src");
      copy.removeAttribute("srcset"); copy.removeAttribute("sizes"); copy.removeAttribute("loading");
    }
  });
  await Promise.all(imageWorkers);
  for (const source of root.querySelectorAll("picture source")) source.remove();
  // Media is captured when it fits the per-page byte budget.
  const originals = [...document.querySelectorAll("video,audio")];
  const copiesMedia = [...root.querySelectorAll("video,audio")];
  for (let i = 0; i < copiesMedia.length; i++) {
    const original = originals[i], copy = copiesMedia[i];
    const src = original?.currentSrc || original?.getAttribute("src");
    const data = src ? await asData(src) : null;
    if (data) copy.setAttribute("src", data);
    else copy.removeAttribute("src");
    for (const child of copy.querySelectorAll("source,track")) child.remove();
    if (copy.tagName === "VIDEO") {
      const poster = await asData(original?.poster);
      if (poster) copy.setAttribute("poster", poster); else copy.removeAttribute("poster");
    }
    copy.removeAttribute("autoplay");
  }
  const originalCanvases = [...document.querySelectorAll("canvas")];
  const copyCanvases = [...root.querySelectorAll("canvas")];
  for (let i = 0; i < copyCanvases.length; i++) {
    try {
      const data = originalCanvases[i].toDataURL("image/png");
      const image = document.createElement("img"); image.src = data;
      image.width = originalCanvases[i].width; image.height = originalCanvases[i].height;
      copyCanvases[i].replaceWith(image);
    } catch { mark("canvas", "tainted or unreadable canvas"); }
  }
  const svgSources = [...document.querySelectorAll("svg image")];
  const svgCopies = [...root.querySelectorAll("svg image")];
  for (let i=0; i<svgCopies.length; i++) {
    const uri = svgSources[i]?.getAttribute("href") || svgSources[i]?.getAttribute("xlink:href");
    const data = await asData(uri);
    if (data) svgCopies[i].setAttribute("href",data);
    else { svgCopies[i].removeAttribute("href"); svgCopies[i].removeAttribute("xlink:href"); }
  }
  for (const el of root.querySelectorAll("link[href],source[srcset],img[srcset]")) {
    if (el.tagName === "LINK") el.remove(); else el.removeAttribute("srcset");
  }
  // Deliberate: do not record cookies, localStorage, HTTP authorization headers, or request bodies.
  const html = "<!doctype html>\n" + root.outerHTML;
  if (html.length > 14 * 1024 * 1024) throw Error("HTML snapshot exceeded 14 MiB");
  return { url: location.href, title: document.title || location.pathname, html, scripts, links, failures, assetBytes: bytesUsed };
}
const LoaditArchive = {
  async run(config, progress) {
    const parsed = new URL(config.url);
    if (!["http:", "https:"].includes(parsed.protocol)) throw Error("HTTP(S) 웹사이트만 아카이빙할 수 있습니다.");
    const origin = parsed.origin;
    const maxPages = Math.max(1, Math.min(12, Number(config.maxPages || 5)));
    const depth = Math.max(0, Math.min(3, Number(config.depth || 1)));
    const queue = [{ url: parsed.href, depth: 0 }];
    const seen = new Set();
    const pages = [];
    const errors = [];
    let totalHtmlSize = 0;
    const overallLimit = 75 * 1024 * 1024;
    // Always open a disposable background tab so recording begins BEFORE navigation.
    // It shares the user's browser profile, but does not alter the currently viewed tab.
    const clean = value => { const u = new URL(value); u.hash = ""; return u.href; };
    while (queue.length && pages.length < maxPages) {
      const task = queue.shift();
      const url = clean(task.url);
      if (seen.has(url)) continue;
      seen.add(url);
      if (new URL(url).origin !== origin) continue;
      progress({ running: true, done: pages.length, maxPages, currentUrl: url, errors: errors.length });
      let tabId = null, recording = null;
      try {
        const tab = await chrome.tabs.create({url:"about:blank",active:false});
        tabId=tab.id;
        recording = await self.LoaditCapture.attach(tabId);
        const loaded = new Promise((resolve,reject) => {
          let settled=false;
          const timeout=setTimeout(()=>finish(new Error("페이지 로딩 시간 초과")),25000);
          const listener=(id,info)=>{ if(id===tabId && info.status==="complete") finish(); };
          function finish(error) { if(settled)return; settled=true;clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(listener);error?reject(error):resolve(); }
          chrome.tabs.onUpdated.addListener(listener);
        });
        await self.LoaditCapture.navigate(tabId,url);
        await loaded;
        await new Promise(resolve=>setTimeout(resolve,1300));
        recording=await self.LoaditCapture.finish(tabId);
        const result=await chrome.scripting.executeScript({
          target:{tabId},func:loaditSnapshot,
          args:[{maxBytes:10*1024*1024,resources:recording.resources}]
        });
        const snapshot = result?.[0]?.result;
        if (!snapshot?.html) throw Error("페이지 DOM을 캡처하지 못했습니다.");
        const pageNetwork = {
          resources:(recording.resources||[]).filter(x=>x.type==="XHR"||x.type==="Fetch"),
          websockets:recording.websockets||[],
          errors:recording.errors||[]
        };
        const pageSize = snapshot.html.length + JSON.stringify(pageNetwork).length + JSON.stringify(snapshot.scripts).length;
        if (totalHtmlSize + pageSize > overallLimit) {
          errors.push({url,reason:"단일 HTML 총 용량 35MiB 제한에 도달했습니다."});
          break;
        }
        pages.push({ url: snapshot.url, title: snapshot.title, html: snapshot.html, scripts: snapshot.scripts, network:pageNetwork });
        totalHtmlSize += pageSize;
        if(pageNetwork.errors.length)errors.push({url,reason:pageNetwork.errors.join("; ")});
        if (snapshot.failures.length) errors.push({ url, reason: snapshot.failures.length + "개 리소스 보존 실패", resources: snapshot.failures.slice(0, 12) });
        if (task.depth < depth) {
          for (const link of snapshot.links) {
            try {
              const target = new URL(link);
              target.hash = "";
              if (target.origin === origin && !seen.has(target.href) && !queue.some(x => x.url === target.href)) queue.push({ url: target.href, depth: task.depth + 1 });
            } catch { /* invalid link */ }
            if (queue.length > 250) break;
          }
        }
      } catch (error) { errors.push({ url, reason: error.message || String(error) }); }
      finally {
        if(tabId !== null){
          await self.LoaditCapture.finish(tabId).catch(()=>{});
          await chrome.tabs.remove(tabId).catch(()=>{});
        }
      }
    }
    if (!pages.length) throw Error(errors.map(x => x.reason).join("; ") || "보존된 페이지가 없습니다.");
    const template = await (await fetch(chrome.runtime.getURL("viewer.html"))).text();
    const safe = JSON.stringify({
      version: 1, created: new Date().toISOString(), source: parsed.href, pages, errors
    }).replace(/</g,"\\u003c").replace(/\u2028/g,"\\u2028").replace(/\u2029/g,"\\u2029");
    const html = template.replace("__LOADIT_PAGES__",safe);
    const domain = parsed.hostname.replace(/[^a-z0-9.-]/gi,"_").slice(0,80);
    return { html, filename: "Loadit/" + domain + "-" + new Date().toISOString().slice(0,10) + ".html", pages: pages.length, errors };
  }
};
self.LoaditArchive = LoaditArchive;
