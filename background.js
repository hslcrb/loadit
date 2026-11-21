/* Loadit MV3 background: download manager + local/GitHub quick save + archive orchestration. */
importScripts("capture.js", "archive.js");
const ARCHIVE_KEY = "loaditArchiveStatus";
let archiveRunning = false;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  try { await chrome.offscreen.createDocument({
    url: "offscreen.html", reasons: ["BLOBS"],
    justification: "Create object URLs for offline archive and note downloads in a document context."
  }); } catch (error) {
    if (!(await chrome.offscreen.hasDocument())) throw error;
  }
}
function safeName(value, fallback) {
  const parts = String(value || fallback).replace(/\\/g, "/").split("/").filter(Boolean);
  const cleaned = parts.map(part => part.replace(/[<>:"|?*\x00-\x1f]/g,"_").replace(/^\.+$/, "_").trim().slice(0, 130));
  if (cleaned.some(x => x === "..") || cleaned.join("/").length > 240) throw Error("유효하지 않은 저장 경로");
  return cleaned.join("/") || fallback;
}
async function saveBlob(content, filename, mime) {
  await ensureOffscreen();
  const obj = await chrome.runtime.sendMessage({ type: "OFFSCREEN_BLOB", content, mime });
  if (!obj?.ok || !obj.url) throw Error("다운로드 객체를 만들지 못했습니다.");
  try {
    const id = await chrome.downloads.download({
      url: obj.url, filename: safeName(filename,"Loadit/file.txt"), conflictAction: "uniquify", saveAs: false
    });
    await chrome.storage.session.set({["loaditBlob_" + id]: obj.key});
    return { ok: true, downloadId: id, bytes: obj.bytes };
  } catch (error) {
    await chrome.runtime.sendMessage({ type:"OFFSCREEN_RELEASE", key:obj.key }).catch(()=>{});
    throw error;
  }
}
chrome.downloads.onChanged.addListener(async change => {
  if (change.state?.current !== "complete" && change.state?.current !== "interrupted") return;
  const keyName = "loaditBlob_" + change.id;
  const stored = await chrome.storage.session.get(keyName).catch(()=>({}));
  if (stored[keyName]) {
    await chrome.runtime.sendMessage({type:"OFFSCREEN_RELEASE",key:stored[keyName]}).catch(()=>{});
    await chrome.storage.session.remove(keyName).catch(()=>{});
  }
});
async function downloadURL(url, filename) {
  const target = new URL(url);
  if (!["https:","http:"].includes(target.protocol)) throw Error("HTTP(S) 다운로드만 지원합니다.");
  const options = { url: target.href, conflictAction:"uniquify", saveAs:false };
  if (filename?.trim()) options.filename = safeName(filename.trim(),"Loadit/file");
  const id = await chrome.downloads.download(options);
  return {ok:true, downloadId:id};
}
async function saveGithubNote(args) {
  const token = String(args.token || "").trim();
  const repo = String(args.repo || "").trim();
  const path = String(args.path || "").trim().replace(/^\/+/, "");
  const body = String(args.content || "");
  if (!token) throw Error("GitHub 토큰이 필요합니다. 이 토큰은 확장 저장소에 보관하지 않습니다.");
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) throw Error("저장소를 owner/repo 형식으로 입력하세요.");
  if (!path || path.split("/").some(part => !part || part === "." || part === "..") || path.length > 180) throw Error("GitHub 저장 경로가 올바르지 않습니다.");
  if (!body.trim()) throw Error("저장할 텍스트가 비어 있습니다.");
  const bytes = new TextEncoder().encode(body);
  if (bytes.length > 900 * 1024) throw Error("GitHub 빠른 저장은 900 KiB 이하의 텍스트를 지원합니다.");
  let binary = "";
  for (let i=0;i<bytes.length;i+=16384) binary += String.fromCharCode(...bytes.subarray(i,i+16384));
  const endpoint = "https://api.github.com/repos/" + repo + "/contents/" + path.split("/").map(encodeURIComponent).join("/");
  const response = await fetch(endpoint, {
    method:"PUT",
    headers:{"Authorization":"Bearer "+token,"Accept":"application/vnd.github+json","Content-Type":"application/json","X-GitHub-Api-Version":"2022-11-28"},
    body:JSON.stringify({message:"docs(loadit): 빠른 저장 " + path, content:btoa(binary)})
  });
  if (!response.ok) {
    const result = await response.json().catch(()=>({}));
    throw Error("GitHub " + response.status + ": " + String(result.message || "쓰기 실패").slice(0,200));
  }
  const result = await response.json();
  return {ok:true,url:result.content?.html_url || "https://github.com/"+repo};
}
async function browseGithub(args) {
  const token=String(args.token||"").trim();
  if(!token)throw Error("저장소/폴더 조회를 위해 GitHub 토큰을 입력하세요.");
  const headers={"Authorization":"Bearer "+token,"Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"};
  let endpoint;
  if(args.view==="repos") endpoint="https://api.github.com/user/repos?per_page=100&sort=updated";
  else {
    const repo=String(args.repo||"");
    const pieces=repo.split("/");
    if(pieces.length!==2 || pieces.some(x=>!x || !Array.from(x).every(c=>("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-").includes(c))))throw Error("owner/repo 형식으로 입력하세요.");
    const folder=String(args.folder||"").split("/").filter(Boolean);
    if(folder.some(x=>x==="."||x===".."))throw Error("잘못된 폴더 경로");
    endpoint="https://api.github.com/repos/"+repo+"/contents/"+folder.map(encodeURIComponent).join("/");
  }
  const response=await fetch(endpoint,{headers});
  if(!response.ok)throw Error("GitHub "+response.status+" · 저장소/폴더 조회에 실패했습니다.");
  const data=await response.json();
  if(!Array.isArray(data))throw Error("폴더 목록 대신 파일이 반환되었습니다.");
  return {ok:true,items:data.slice(0,100).map(x=>args.view==="repos"?{
    name:x.full_name,type:"repo",path:x.full_name
  }:{name:x.name,type:x.type,path:x.path})};
}
async function collectCandidates(tabId) {
  const [{result}] = await chrome.scripting.executeScript({
    target:{tabId},
    func:()=>{
      const urls = new Map();
      const allowed = /\.(?:pdf|zip|7z|rar|tar|gz|png|jpe?g|webp|gif|svg|mp3|wav|ogg|mp4|webm|mov|txt|csv|json|xml|docx?|xlsx?|pptx?|hwp|hwpx|epub|apk|exe|msi)(?:$|[?#])/i;
      function add(url, label, kind) {
        try {
          const href = new URL(url,location.href);
          if (!["http:","https:"].includes(href.protocol)) return;
          if (!urls.has(href.href)) urls.set(href.href,{url:href.href,label:String(label||href.pathname.split("/").pop()||href.hostname).slice(0,120),kind});
        } catch {}
      }
      for(const a of document.querySelectorAll("a[href]")) {
        if(a.hasAttribute("download") || allowed.test(a.href)) add(a.href,a.getAttribute("download") || a.textContent.trim() || a.href,"link");
      }
      for(const img of document.querySelectorAll("img[src]")) if(img.currentSrc) add(img.currentSrc,img.alt||"이미지","image");
      for(const media of document.querySelectorAll("video,audio,source")) {
        if(media.currentSrc || media.src) add(media.currentSrc||media.src,"미디어","media");
      }
      return [...urls.values()].slice(0,180);
    }
  });
  return {ok:true,items:result||[]};
}
function contextMenus() {
  chrome.contextMenus.removeAll().then(() => {
    chrome.contextMenus.create({id:"loadit-link",title:"Loadit · 링크 파일 다운로드",contexts:["link"]});
    chrome.contextMenus.create({id:"loadit-image",title:"Loadit · 이미지 다운로드",contexts:["image"]});
    chrome.contextMenus.create({id:"loadit-media",title:"Loadit · 미디어 다운로드",contexts:["video","audio"]});
    chrome.contextMenus.create({id:"loadit-selection",title:"Loadit · 선택 텍스트 로컬 저장",contexts:["selection"]});
    chrome.contextMenus.create({id:"loadit-selection-github",title:"Loadit · 선택 텍스트 GitHub 빠른 저장",contexts:["selection"]});
    chrome.contextMenus.create({id:"loadit-page",title:"Loadit · 현재 주소 다운로드",contexts:["page"]});
  }).catch(()=>{});
}
chrome.runtime.onInstalled.addListener(contextMenus);
chrome.runtime.onStartup.addListener(contextMenus);
chrome.contextMenus.onClicked.addListener(async info => {
  try {
    if (info.menuItemId === "loadit-selection-github") {
      await chrome.storage.session.set({loaditSelection:info.selectionText || ""});
      await chrome.tabs.create({url:chrome.runtime.getURL("popup.html") + "?tab=note"});
      return;
    }
    if (info.menuItemId === "loadit-selection") {
      const text = info.selectionText || "";
      await chrome.storage.session.set({loaditSelection:text});
      await saveBlob(text,"Loadit/selection-" + Date.now() + ".txt","text/plain;charset=utf-8");
      return;
    }
    const url = info.linkUrl || info.srcUrl || info.pageUrl;
    if (url) await downloadURL(url,"");
  } catch (error) { console.warn("Loadit context menu:",error.message); }
});
async function setStatus(status) { await chrome.storage.session.set({[ARCHIVE_KEY]:status}); }
async function startArchive(args) {
  if (archiveRunning) throw Error("이미 아카이빙 작업이 진행 중입니다.");
  archiveRunning = true;
  await setStatus({running:true,done:0,currentUrl:args.url,started:new Date().toISOString()});
  (async()=>{
    try {
      const result = await self.LoaditArchive.run(args, update => { setStatus(update).catch(()=>{}); });
      const download = await saveBlob(result.html,result.filename,"text/html;charset=utf-8");
      await setStatus({running:false,done:result.pages,downloadId:download.downloadId,errors:result.errors,filename:result.filename});
    } catch (error) { await setStatus({running:false,error:error.message || String(error)}); }
    finally { archiveRunning=false; }
  })();
  return {ok:true,started:true};
}
chrome.runtime.onMessage.addListener((message,sender,respond) => {
  if (!message?.type || message.type.startsWith("OFFSCREEN_")) return false;
  (async()=>{
    switch(message.type) {
      case "DOWNLOAD_URL":return downloadURL(message.url,message.filename);
      case "COLLECT_LINKS":return collectCandidates(message.tabId);
      case "DOWNLOADS":return {ok:true,items:await chrome.downloads.search({limit:35,orderBy:["-startTime"]})};
      case "DOWNLOAD_CONTROL":{
        const id=Number(message.id);
        if(!Number.isInteger(id))throw Error("다운로드 ID 오류");
        if(message.action==="pause")await chrome.downloads.pause(id);
        else if(message.action==="resume")await chrome.downloads.resume(id);
        else if(message.action==="cancel")await chrome.downloads.cancel(id);
        else if(message.action==="show")await chrome.downloads.show(id);
        else throw Error("알 수 없는 동작");
        return {ok:true};
      }
      case "SAVE_TEXT":return saveBlob(String(message.content||""),message.filename || "Loadit/note.txt","text/plain;charset=utf-8");
      case "GITHUB_NOTE":return saveGithubNote(message);
      case "GITHUB_BROWSE":return browseGithub(message);
      case "ARCHIVE_START":return startArchive(message);
      case "ARCHIVE_STATUS":return {ok:true,status:(await chrome.storage.session.get(ARCHIVE_KEY))[ARCHIVE_KEY] || {running:false}};
      case "LAST_SELECTION":return {ok:true,text:(await chrome.storage.session.get("loaditSelection")).loaditSelection || ""};
      default:throw Error("알 수 없는 요청");
    }
  })().then(respond).catch(error=>respond({ok:false,error:error.message || String(error)}));
  return true;
});
