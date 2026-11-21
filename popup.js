/* Loadit popup — vanilla DOM and Chrome extension APIs only. */
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let tab = null;
let candidates = [];
let toastTimer;
async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw Error(result?.error || "요청을 처리하지 못했습니다.");
  return result;
}
function toast(message, bad=false) {
  const el=$("#toast");el.textContent=String(message);el.style.borderColor=bad?"#ca6d70":"#5483c8";
  clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.textContent="",4500);
}
async function task(fn) {
  try { await fn(); } catch(error) { toast(error.message||String(error),true); }
}
function switchTab(name) {
  for(const item of $$(".tab")) {
    const active=item.dataset.tab===name;
    item.classList.toggle("active",active);
    item.setAttribute("aria-selected",String(active));
  }
  for(const panel of $$(".panel")) panel.classList.toggle("active",panel.id==="panel-"+name);
}
for(const button of $$(".tab")) button.addEventListener("click",()=>switchTab(button.dataset.tab));
async function initialize(){
  const tabs = await chrome.tabs.query({active:true,currentWindow:true});
  tab = tabs[0] || null;
  if(/^https?:\/\//.test(tab?.url || "")){
    $("#url").value = tab.url;
    $("#archive-url").value = tab.url;
  }
  const settings = await chrome.storage.local.get(["loaditRepo","loaditPath"]);
  $("#gh-repo").value = settings.loaditRepo || "";
  $("#gh-path").value = settings.loaditPath || "notes/"+new Date().toISOString().slice(0,10)+"-note.md";
  const last = await request({type:"LAST_SELECTION"});
  if(last.text) $("#note-body").value=last.text;
  if(new URLSearchParams(location.search).get("tab")==="note")switchTab("note");
  await refreshDownloads();
  await refreshArchive();
}
$("#download").addEventListener("click",()=>task(async()=>{
  const result=await request({type:"DOWNLOAD_URL",url:$("#url").value.trim(),filename:$("#filename").value.trim()});
  toast("다운로드를 시작했습니다 · #"+result.downloadId);await refreshDownloads();
}));
$("#scan").addEventListener("click",()=>task(async()=>{
  if(!tab?.id)throw Error("현재 탭이 없습니다.");
  const result=await request({type:"COLLECT_LINKS",tabId:tab.id});
  candidates=result.items;renderCandidates();
  toast(candidates.length+"개 리소스 후보를 찾았습니다.");
}));
function renderCandidates(){
  const list=$("#candidates");list.replaceChildren();
  $("#download-selected").disabled=!candidates.length;
  if(!candidates.length){const p=document.createElement("p");p.className="muted";p.textContent="다운로드 가능한 링크를 발견하지 못했습니다.";list.append(p);return;}
  candidates.forEach((item,index)=>{
    const label=document.createElement("label");label.className="candidate";
    const input=document.createElement("input");input.type="checkbox";input.dataset.index=index;
    const wrapper=document.createElement("div");
    const name=document.createElement("div");name.className="name";name.textContent=item.label;
    const sub=document.createElement("div");sub.className="sub";sub.textContent=item.kind+" · "+item.url;
    wrapper.append(name,sub);label.append(input,wrapper);list.append(label);
  });
}
$("#download-selected").addEventListener("click",()=>task(async()=>{
  const indices=$$("#candidates input:checked").map(input=>Number(input.dataset.index));
  if(!indices.length)throw Error("파일을 선택하세요.");
  if(indices.length>30)throw Error("한 번에 최대 30개까지 다운로드할 수 있습니다.");
  let done=0,failed=0;
  for(const i of indices) {
    try { await request({type:"DOWNLOAD_URL",url:candidates[i].url});done++; }
    catch {failed++; }
  }
  toast(done+"개 다운로드 시작"+(failed?", "+failed+"개 실패":""));refreshDownloads();
}));
async function refreshDownloads(){
  const response=await request({type:"DOWNLOADS"});
  const list=$("#downloads");list.replaceChildren();
  const items=response.items.slice(0,16);
  if(!items.length){const p=document.createElement("p");p.className="muted";p.textContent="다운로드 기록이 없습니다.";list.append(p);return;}
  items.forEach(item=>{
    const line=document.createElement("div");line.className="history";
    const body=document.createElement("div");body.className="item";
    const name=document.createElement("div");name.className="name";name.textContent=(item.filename||item.url||"파일").split(/[\\/]/).pop();
    const sub=document.createElement("div");sub.className="sub";
    const percent = item.totalBytes>0 ? Math.round(item.bytesReceived*100/item.totalBytes)+"%" : "";
    sub.textContent=item.state+" "+percent+(item.error?" · "+item.error:"");
    body.append(name,sub);
    const actions=document.createElement("div");actions.className="actions";
    const controls=item.state==="in_progress"?
      [{label:item.paused?"계속":"정지",action:item.paused?"resume":"pause"},{label:"취소",action:"cancel"}]:
      item.state==="complete"?[{label:"보기",action:"show"}]:[];
    for(const ctrl of controls){
      const button=document.createElement("button");button.type="button";button.textContent=ctrl.label;
      button.addEventListener("click",()=>task(async()=>{await request({type:"DOWNLOAD_CONTROL",id:item.id,action:ctrl.action});await refreshDownloads();}));
      actions.append(button);
    }
    line.append(body,actions);list.append(line);
  });
}
$("#refresh").addEventListener("click",()=>task(refreshDownloads));
$("#save-local").addEventListener("click",()=>task(async()=>{
  const body=$("#note-body").value;
  if(!body.trim())throw Error("메모를 입력하세요.");
  const result=await request({type:"SAVE_TEXT",content:body,filename:$("#note-name").value});
  toast("메모 파일 저장을 시작했습니다 · "+result.bytes+" bytes");
}));
function drawGithubBrowser(items,kind,currentFolder=""){
  const node=$("#github-browser");node.replaceChildren();
  if(kind==="folder" && currentFolder){
    const back=document.createElement("button");back.type="button";back.className="small";
    back.textContent="← 상위 폴더";back.addEventListener("click",()=>task(()=>browseFolder(currentFolder.split("/").slice(0,-1).join("/"))));node.append(back);
  }
  if(!items.length){const note=document.createElement("p");note.className="muted";note.textContent="표시할 저장소/폴더가 없습니다.";node.append(note);return;}
  for(const item of items){
    if(kind==="folder" && item.type!=="dir")continue;
    const button=document.createElement("button");button.type="button";button.className="page";
    button.style.cssText="display:block;width:100%;text-align:left;border:0;border-bottom:1px solid #263956;background:transparent;color:#dae8ff;padding:9px;";
    button.textContent=(item.type==="dir"?"▣ ":"")+(item.name||item.path);
    button.addEventListener("click",()=>task(async()=>{
      if(kind==="repo"){
        $("#gh-repo").value=item.path;
        await browseFolder("");
      }else{
        const currentFile=$("#gh-path").value.split("/").pop()||"quick-note.md";
        $("#gh-path").value=item.path+"/"+currentFile;
        await browseFolder(item.path);
      }
    }));
    node.append(button);
  }
}
function tokenForBrowse(){const token=$("#gh-token").value.trim();if(!token)throw Error("저장소를 탐색하려면 GitHub 토큰을 입력하세요.");return token;}
async function browseFolder(folder){
  const repo=$("#gh-repo").value.trim();
  if(!repo)throw Error("owner/repo를 먼저 지정하세요.");
  const result=await request({type:"GITHUB_BROWSE",view:"folder",repo,folder,token:tokenForBrowse()});
  drawGithubBrowser(result.items,"folder",folder);
}
$("#browse-repos").addEventListener("click",()=>task(async()=>{
  const response=await request({type:"GITHUB_BROWSE",view:"repos",token:tokenForBrowse()});
  drawGithubBrowser(response.items,"repo");
}));
$("#browse-folder").addEventListener("click",()=>task(async()=>{
  const dir=$("#gh-path").value.split("/").slice(0,-1).join("/");
  await browseFolder(dir);
}));
$("#save-github").addEventListener("click",()=>task(async()=>{
  const repo=$("#gh-repo").value.trim(),path=$("#gh-path").value.trim();
  const content=$("#note-body").value;
  if(!content.trim())throw Error("메모를 입력하세요.");
  const token=$("#gh-token").value;
  const btn=$("#save-github");btn.disabled=true;btn.textContent="GitHub에 저장 중…";
  try{
    const saved=await request({type:"GITHUB_NOTE",repo,path,content,token});
    await chrome.storage.local.set({loaditRepo:repo,loaditPath:path});
    $("#gh-token").value="";
    toast("GitHub에 새 파일을 생성했습니다.");
    const a=document.createElement("a");a.href=saved.url;a.target="_blank";a.rel="noopener noreferrer";a.textContent="생성된 파일 확인 ↗";a.style.color="#a8c8ff";
    $("#toast").append(" ",a);
  }finally{btn.disabled=false;btn.textContent="GitHub에 새 파일 생성";}
}));
$("#archive").addEventListener("click",()=>task(async()=>{
  const target=new URL($("#archive-url").value.trim());
  if(!["https:","http:"].includes(target.protocol))throw Error("HTTP(S) 주소를 입력하세요.");
  const origin=target.origin+"/*";
  const granted=await chrome.permissions.contains({origins:[origin]}) ||
    await chrome.permissions.request({origins:[origin]});
  if(!granted)throw Error("사이트 캡처 권한이 허용되지 않았습니다.");
  await request({type:"ARCHIVE_START",url:target.href,maxPages:Number($("#max-pages").value),depth:Number($("#depth").value)});
  toast("아카이브 수집이 시작됐습니다.");
  await refreshArchive();
}));
async function refreshArchive(){
  const result=await request({type:"ARCHIVE_STATUS"});
  const s=result.status||{};const node=$("#archive-status");
  if(s.running){
    node.textContent="수집 중 · "+(s.done||0)+"/"+(s.maxPages||"?")+" 페이지 · "+(s.currentUrl||"");
    $("#archive").disabled=true;
  } else {
    $("#archive").disabled=false;
    if(s.error)node.textContent="실패 · "+s.error;
    else if(s.filename)node.textContent="완료 · "+s.done+"개 페이지 · "+s.filename+" · 다운로드 목록에서 확인하세요."+(s.errors?.length?" · 부분 보존 경고 "+s.errors.length+"건":"");
    else node.textContent="작업을 시작할 수 있습니다.";
  }
}
setInterval(()=>{refreshArchive().catch(()=>{});},1300);
initialize().catch(error=>toast(error.message||String(error),true));
