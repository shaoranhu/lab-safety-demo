'use strict';
const $=s=>document.querySelector(s), sources=['monitor','robot'];
const names={monitor:'监控摄像头',robot:'机器人'}, states={};
let api='',token='',email='',types=[],events=[],tab='final',mode='login',lastShot='',shotURL='';
let savedSources={},recognitionEnabled={},viewsPaused=false,defaultApi='';
let updates;
let framePeriod=200,livePeriod=0;
let resumeSavedSources=false;
const eventsPerTab=15;
const previewErrors={}, motions={}, localMedia={}, liveFrames={}, sourceChanges={}, statusPeriod=1500;
const activeStates=['online','connecting'];
const stateLabels={offline:'未连接',connecting:'正在读取',online:'在线',error:'错误',stopping:'正在停止',stopped:'已停止',disconnected:'连接中断'};
const parameterDefaults={confidence:.4,crowd_count:3,region_percent:50,lying_ratio:1.25,hold_seconds:1,alert_interval:3};
const behaviorKeys=['leaving_seconds','access_count','unattended_seconds','experiment_count'];
const requestedCatalog=[["ppe", "安全防护服异常"], ["fall", "人员摔倒"], ["eating", "实验室饮食"], ["sleeping", "实验室睡觉"], ["unattended_equipment", "仪器开启但无人看管"], ["leaving", "实验过程中外出"], ["open_container", "试剂瓶瓶口敞开"], ["understaffed", "独自实验／人数不足"], ["waste_disposal", "废液直接倒入下水道"], ["unreturned_reagent", "试剂用完未归位"], ["equipment_left_on", "实验结束后设备未关闭"], ["spill", "打翻实验用品／液体洒落"], ["outside_protection", "防护设施外进行危险操作"], ["access", "准入异常"]];
for(const [id,name] of requestedCatalog){const label=document.createElement('label');label.className='check';const input=document.createElement('input');input.type='checkbox';input.value=id;input.disabled=true;const span=document.createElement('span');span.textContent=name;const small=document.createElement('small');small.textContent='待接入';span.append(small);label.append(input,span);$('#requested-types').append(label)}
function markAvailableTypes(){
  document.querySelectorAll('#requested-types .check').forEach(item=>{
    const active=types.some(type=>type.id===item.querySelector('input').value);
    item.querySelector('small').textContent=active?'已接入':'待接入';
  });
}
const normalBanner='';
const text=(el,value)=>{el.textContent=value;if(el.id==="banner")el.hidden=!value;};
function toast(message){const dialog=document.querySelector('dialog[open]');if(dialog){let notice=dialog.querySelector('.toast-inline');if(!notice){notice=document.createElement('p');notice.className='toast-inline';notice.setAttribute('role','status');dialog.append(notice)}text(notice,message)}text($('#toast'),message);$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,5000);}
function openDialog(id){const dialog=document.getElementById(id);dialog.querySelector('.toast-inline')?.remove();dialog.showModal()}
document.querySelectorAll('[data-open]').forEach(button=>button.onclick=()=>openDialog(button.dataset.open));
document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>button.closest('dialog').close());
function authState(){
  text($('#account'),token?'退出 '+email:'注册 / 登录');
  $('#account').title=$('#account').textContent;
  $('#save-types').disabled=$('#behavior-parameters').disabled=$('#download').disabled=!token;
  $('#parameters').disabled=!token||$('#parameters').dataset.baseline==='false';
  document.querySelectorAll('#types input,#requested-types input').forEach(x=>x.disabled=!token);
  for(const source of sources) renderSourceControls(source);
  $('#toggle-views').disabled=!token;
}
function clearWorkspace(){
  updates?.abort();
  viewsPaused=false;
  text($('#toggle-views'),'暂停画面');
  $('#toggle-views').setAttribute('aria-pressed','false');
  for(const source of sources){
    resetPreview(source);
    delete localMedia[source];
    delete states[source];
    delete previewErrors[source];
    sourceChanges[source]?.controller.abort();
    delete sourceChanges[source];
    $('#file-'+source).value='';
    sourceNotice(source,'');
  }
  events=[];savedSources={};recognitionEnabled={};lastShot='';
  if(shotURL)URL.revokeObjectURL(shotURL);
  shotURL='';
  text($('#snapshot'),'暂无异常截图');
  text($('#snapshot-detail'),'');
  text($('#types'),'等待登录');
  types=[];
  markAvailableTypes();metrics();eventList();
}
async function request(path,{timeout=15000,signal,headers,...options}={}){
  const session=token;
  const deadline=timeout===null?null:AbortSignal.timeout(timeout);
  const response=await fetch(api+path,{
    ...options,
    headers:{...(session?{Authorization:'Bearer '+session}:{}),...headers},
    signal:signal&&deadline?AbortSignal.any([deadline,signal]):signal||deadline
  });
  if(!response.ok){
    let error;
    try{error=(await response.json()).error}catch{error='服务返回 '+response.status}
    if(response.status===401 && session && session===token){
      token='';
      sessionStorage.removeItem('lab-session');
      clearWorkspace();
      authState();
      text($('#connection'),'后端可连接');
    }
    throw Error(error);
  }
  return response;
}
async function json(path,options){return (await request(path,options)).json();}
const post=(path,body)=>json(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const put=(path,body)=>json(path,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
function drawCards(){
  for(const result of [false,true]) for(const source of sources){
    const id=source+(result?'-result':'');
    const card=document.createElement('article');
    card.className='video';
    card.innerHTML=`<div class="video-head"><strong>${names[source]} · ${result?'识别结果':'原始视频'}</strong>${result?'':`<div class="video-actions">
      <button id="recognition-${source}" class="secondary" disabled>开始识别</button>
      <button class="configure-source" aria-label="设置${names[source]}来源">设置来源</button>
    </div>`}</div><div class="screen"><div class="placeholder" id="placeholder-${id}">${result?'等待识别画面':'请设置视频来源'}</div>
      <img id="image-${id}" hidden alt="${names[source]}${result?'识别结果':'原始画面'}">
      <canvas id="motion-${id}" aria-label="${names[source]}${result?'识别结果':'原始画面'}" hidden></canvas>
    </div><div class="frame-bar"><span id="stamp-${id}">尚无画面</span></div>`;
    $('#videos').append(card);
    if(!result) card.querySelector('.configure-source').onclick=()=>{
      openDialog('sources-dialog');
      $('#file-'+source).focus();
    };
  }
  for(const source of sources){
    const controls=document.createElement('section');
    controls.className='source-controls';
    controls.innerHTML=`<h3>${names[source]}</h3>
      <p class="current-source" id="source-current-${source}">当前未设置来源</p>
      <p class="source-notice" id="notice-${source}" role="status"></p>
      <label>MP4 视频<input id="file-${source}" type="file" accept="video/mp4,.mp4"></label>
      <div class="button-row"><button id="upload-${source}" class="primary">上传视频</button>
      <button id="clear-${source}" class="secondary">清除当前来源</button></div>
      <label>RTSP 视频源<select id="rtsp-${source}"><option value="">尚未配置</option></select></label>
      <button id="rtsp-save-${source}" class="secondary full">设为 RTSP 来源</button>`;
    $('#source-settings').append(controls);
    $('#upload-'+source).onclick=()=>uploadVideo(source);
    $('#file-'+source).onchange=()=>{
      sourceNotice(source,'');
      renderSourceControls(source);
    };
    $('#rtsp-save-'+source).onclick=()=>{
      const id=$('#rtsp-'+source).value;
      changeSource(source,'正在保存 RTSP 来源…',async()=>({
        state:await put('/api/source/'+source,{rtsp_id:id}),
        message:'已保存 RTSP 来源',reset:true
      }));
    };
    $('#rtsp-'+source).onchange=()=>renderSourceControls(source);
    $('#clear-'+source).onclick=()=>changeSource(source,'正在清除来源…',async()=>({
      state:await put('/api/source/'+source,{}),message:'已清除当前来源和画面',reset:true
    }));
    $('#recognition-'+source).onclick=()=>toggleRecognition(source);
  }
}
$('#toggle-views').onclick=()=>{
  viewsPaused=!viewsPaused;
  text($('#toggle-views'),viewsPaused?'继续画面':'暂停画面');
  $('#toggle-views').setAttribute('aria-pressed',String(viewsPaused));
  toast(viewsPaused?'四路画面已暂停，后台继续识别':'四路画面已继续');
};
function renderSourceControls(source){
  const saved=savedSources[source];
  const state=states[source]?.state;
  const busy=sourceChanges[source]?.busy;
  const running=activeStates.includes(state);
  const message=busy?'处理中…':state==='stopping'?'正在停止…':running?'停止识别':'开始识别';
  const button=$('#recognition-'+source), select=$('#rtsp-'+source), file=$('#file-'+source);
  text(button,message);
  button.setAttribute('aria-label',message+'（'+names[source]+'）');
  button.disabled=!token||busy||state==='stopping'||(!saved&&!running);
  button.classList.toggle('recognition-running',running);
  file.disabled=select.disabled=!token||busy;
  $('#upload-'+source).disabled=file.disabled||!file.files.length;
  $('#clear-'+source).disabled=file.disabled||!saved;
  $('#rtsp-save-'+source).disabled=select.disabled||!select.value;
  const rtspName=Array.from(select.options).find(option=>option.value===saved?.rtsp_id)?.text;
  const current=saved?.rtsp_id?'RTSP · '+(rtspName||saved.rtsp_id):saved?'已上传 MP4 视频':'未设置';
  text($('#source-current-'+source),'当前来源 · '+current);
  for(const id of [source,source+'-result']){
    const placeholder=saved
      ? (running||busy?'正在等待视频画面':'已保存来源，点击「开始识别」')
      : (id===source?'请设置视频来源':'等待识别画面');
    text($('#placeholder-'+id),placeholder);
  }
}
function sourceNotice(source,message,kind='info'){
  const notice=$('#notice-'+source);
  notice.dataset.kind=kind;
  text(notice,message);
}
async function changeSource(source,pending,change){
  if(sourceChanges[source]?.busy) return;
  const session=token, path='/api/source/'+source;
  const action={busy:true,controller:new AbortController()};
  sourceChanges[source]=action;
  renderSourceControls(source);
  const inSettings=$('#sources-dialog').open;
  const notify=(message,kind)=>inSettings&&$('#sources-dialog').open
    ? sourceNotice(source,message,kind) : toast(names[source]+' · '+message);
  if(inSettings) sourceNotice(source,pending);
  try{
    const {state,message,reset,media}=await change(path,session,action.controller.signal);
    if(token!==session||!state) return;
    if(reset){
      resetPreview(source);
      if(media) localMedia[source]=media;
      else delete localMedia[source];
      $('#file-'+source).value='';
    }
    savedSources[source]=state.source;
    recognitionEnabled[source]=state.enabled;
    delete previewErrors[source];
    states[source]={...(reset?{}:states[source]),state:state.state,error:''};
    metrics();
    eventList();
    if(state.error||message){
      let notice=state.error||message;
      if(!state.error&&reset&&state.source){
        notice+=state.enabled?'，正在读取画面':'。识别已停止，可在主页点击「开始识别」。';
      }
      notify(notice,state.error?'error':'success');
    }
  }catch(error){
    if(token===session) notify(error.message,'error');
  }finally{
    if(sourceChanges[source]===action){
      action.busy=false;
      renderSourceControls(source);
    }
  }
}
function uploadVideo(source){
  const file=$('#file-'+source).files[0];
  if(!file) return;
  return changeSource(source,'正在上传视频…',async(path,session,signal)=>{
    const {id}=await json('/api/upload',{method:'POST',body:file,headers:{'Content-Type':'application/octet-stream'},signal,timeout:null});
    if(session!==token) return {};
    const state=await put(path,{video_id:id});
    return {state,message:'视频上传完成，已设为当前来源',reset:true,media:{id,file}};
  });
}
function toggleRecognition(source){
  const running=activeStates.includes(states[source]?.state);
  return changeSource(source,'',async path=>{
    if(running){
      const state=await json(path,{method:'DELETE'});
      return {state,message:state.state==='stopping'?'正在停止识别':'识别已停止'};
    }
    return {state:await post(path,{}),message:'正在启动识别'};
  });
}
function restoreSource(source){
  if(resumeSavedSources&&savedSources[source]&&recognitionEnabled[source]!==false){
    return changeSource(source,'正在恢复已保存的来源…',async path=>({
      state:await post(path,{resume:true})
    }));
  }
}
function metrics(){
  const body=$('#metrics');
  body.replaceChildren();
  const online=sources.filter(source=>states[source]?.state==='online').length;
  text($('#source-summary'),online+' / 2 路运行中');
  for(const source of sources){
    const state=states[source]||{};
    const packet=state.packet||{};
    const disabled=state.state==='offline'&&savedSources[source]&&recognitionEnabled[source]===false;
    const label=disabled?'已停止':stateLabels[state.state]||'未连接';
    const fps=state.state==='online'?packet.fps:null;
    const cost=packet.process_ms?`${packet.process_ms} ms`:'—';
    const row=document.createElement('tr');
    for(const value of [names[source],label,packet.people??'—',packet.resolution||'—',fps??'—',cost,packet.frame_id??'—']){
      const cell=document.createElement('td');
      cell.textContent=value;
      row.append(cell);
    }
    if(state.error) row.title=state.error;
    body.append(row);
  }
}
function eventList(){
  const box=$('#events');box.replaceChildren();$('#fusion-note').hidden=tab!=='final';
  const current=sources.filter(s=>tab==='final'||s===tab).filter(s=>states[s]?.packet);
  for(const source of current){
    const state=states[source],p=state.packet,row=document.createElement('div');row.className='current-result';
    const title=document.createElement('strong');
    title.textContent=names[source]+(state.state==='online'?' · 当前 ':' · 最后一帧 ')+p.people+' 人 · '+(p.findings.length?'命中已启用的检测项':'未命中已启用的检测项');
    const detail=document.createElement('p');
    detail.textContent=new Date(p.time).toLocaleString()+' · 帧 '+p.frame_id+' · '+(p.findings.map(f=>f.pose).join(' / ')||'姿态尚未分类');
    const description=document.createElement('p');description.textContent=p.description||'等待行为描述';
    row.append(title,detail,description);box.append(row);
  }
  const list=events.filter(e=>tab==='final'||e.source===tab);
  if(!list.length){const p=document.createElement('p');text(p,token?'暂无异常记录':'登录后查看识别结果');box.append(p);return}
  for(const event of list.slice(0,eventsPerTab)){
    const row=document.createElement('div');row.className='event';
    const left=document.createElement('div'),right=document.createElement('div');right.className='event-type';
    left.textContent=names[event.source]+' · '+event.people+' 人';
    const detail=document.createElement('small');detail.textContent=new Date(event.time).toLocaleString()+' · 帧 '+event.frame_id;
    const description=document.createElement('small');description.textContent=event.description||event.findings.map(f=>f.pose||'未分类').join(' / ');
    left.append(detail,description);
    right.textContent=event.findings.map(f=>(types.find(t=>t.id===f.type)?.name||f.type)+' · 检测分数 '+Math.round(f.confidence*100)+'%').join(' / ');
    row.append(left,right);box.append(row);
  }
}
async function snapshot(signal){if(!events.length||events[0].id===lastShot)return;const e=events[0];const response=await request('/api/snapshot/'+e.id,{signal});const blob=await response.blob();if(signal.aborted)return;if(shotURL)URL.revokeObjectURL(shotURL);shotURL=URL.createObjectURL(blob);const image=new Image();image.alt='最近一次异常截图';image.src=shotURL;$('#snapshot').replaceChildren(image);text($('#snapshot-detail'),new Date(e.time).toLocaleString()+' · '+names[e.source]+' · 帧 '+e.frame_id+' · '+e.findings.map(f=>(types.find(t=>t.id===f.type)?.name||f.type)+' · 检测分数 '+Math.round(f.confidence*100)+'%').join(' / '));lastShot=e.id;}
function displayFrame(source,packet){
  if(viewsPaused||!packet?.raw)return;
  for(const [id,jpeg] of [[source,packet.raw],[source+'-result',packet.result]]){
    const image=$('#image-'+id);
    // The timestamp distinguishes a replacement video that starts at the same frame number.
    if(image.dataset.frame===String(packet.frame_id)&&image.dataset.time===packet.time)continue;
    image.src='data:image/jpeg;base64,'+jpeg;
    image.dataset.frame=packet.frame_id;
    image.dataset.time=packet.time;
    image.hidden=false;
    $('#motion-'+id).hidden=true;
    text($('#stamp-'+id),'帧 '+packet.frame_id+' · '+new Date(packet.time).toLocaleTimeString());
  }
}
function closeMotion(source,preserve=false){
  motions[source]?.close(preserve);
  delete motions[source];
}
function resetPreview(source){
  closeMotion(source);
  delete liveFrames[source];
  for(const id of [source,source+'-result']){
    const image=$('#image-'+id), canvas=$('#motion-'+id);
    image.hidden=canvas.hidden=true;
    image.removeAttribute('src');
    delete image.dataset.frame;
    delete image.dataset.time;
    delete canvas.dataset.time;
    delete canvas.dataset.detectionFrame;
    canvas.width=0;
    text($('#stamp-'+id),'尚无画面');
  }
}
function updateMotion(source,state){
  let current=motions[source];
  if(!state.playback||!activeStates.includes(state.state)){
    closeMotion(source,viewsPaused);
    return false;
  }
  if(current?.playback.stream_id!==state.playback.stream_id){
    closeMotion(source,viewsPaused);
    const playback=state.playback;
    const motion=new FileMotionPreview(source,playback,()=>viewsPaused,()=>{
      if(motions[source]!==motion||motion.abort.signal.aborted)return;
      motion.close(viewsPaused);
    });
    motions[source]=motion;
    current=motion;
    const cached=localMedia[source];
    const file=cached?.id===playback.video_id
      ? Promise.resolve(cached.file)
      : request('/api/media/'+encodeURIComponent(playback.video_id),{signal:motion.abort.signal,timeout:null}).then(response=>response.blob());
    file.then(data=>motion.open(data)).catch(()=>motion.onFailure());
  }
  if(!current.abort.signal.aborted)current.addPacket(state.packet);
  return current.ready;
}
async function displayLiveFrame(source,state,isCurrent){
  if(viewsPaused||!state.preview) return;
  const {frame_id,captured_at,raw}=state.preview;
  const bytes=Uint8Array.fromBase64?Uint8Array.fromBase64(raw):Uint8Array.from(atob(raw),char=>char.charCodeAt(0));
  const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/jpeg'}));
  try{
    if(viewsPaused||!isCurrent()) return;
    const age=captured_at-state.packet?.captured_at;
    const packet=age>=0&&age<=.45?state.packet:null;
    for(const [index,id] of [source,source+'-result'].entries()){
      const canvas=$('#motion-'+id), still=$('#image-'+id);
      const {width,height}=bitmap;
      if(canvas.width!==width||canvas.height!==height){
        canvas.width=width;canvas.height=height;
      }
      const ctx=canvas.getContext('2d',{alpha:false});
      ctx.drawImage(bitmap,0,0);
      if(index) drawRecognition(ctx,packet,width,height);
      canvas.dataset.time=String(frame_id);
      if(index) canvas.dataset.detectionFrame=packet?.frame_id??'';
      text($('#stamp-'+id),index?(packet?'识别帧 '+packet.frame_id:'等待识别结果'):'实时帧 '+frame_id);
      canvas.hidden=false;
      still.hidden=true;
    }
    liveFrames[source]=state.stream_id+'/'+frame_id;
  }finally{
    bitmap.close();
  }
}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function updateFrames(source,signal){
  while(token&&!signal.aborted){
    const started=performance.now();
    const action=sourceChanges[source];
    if(action?.busy){await wait(100);continue}
    const isCurrent=()=>!signal.aborted&&sourceChanges[source]===action&&!action?.busy;
    const live=Boolean(livePeriod&&savedSources[source]?.rtsp_id);
    try{
      const motion=motions[source];
      const query=new URLSearchParams();
      const headers={};
      if(motion?.ready) query.set('metadata',motion.playback.stream_id);
      if(live){
        query.set('live','1');
        if(viewsPaused) query.set('preview','0');
        else headers['X-Lab-Preview-After']=liveFrames[source]||'';
      }
      const state=await json('/api/frame/'+source+'?'+query,{signal,headers,timeout:4500});
      if(!isCurrent())continue;
      const previous=states[source];
      states[source]=state;
      delete previewErrors[source];
      if(state.state!==previous?.state){
        renderSourceControls(source);
        if(state.error&&$('#sources-dialog').open) sourceNotice(source,state.error,'error');
      }
      if(state.state==='offline'&&previous?.stream_id) restoreSource(source);
      if(!updateMotion(source,state)){
        if(state.preview) await displayLiveFrame(source,state,isCurrent);
        else if(!live||!activeStates.includes(state.state)||!liveFrames[source]) displayFrame(source,state.packet);
      }
    }catch(error){
      if(!isCurrent())continue;
      states[source]={...states[source],state:'disconnected',error:''};
      previewErrors[source]=error.message;
      renderSourceControls(source);
    }
    const active=!document.hidden&&activeStates.includes(states[source]?.state);
    const interval=active?(live&&!viewsPaused?livePeriod:framePeriod):statusPeriod;
    // Keep one request in flight per source. Slow connections skip frames instead of queuing them.
    await wait(active?Math.max(0,interval-(performance.now()-started)):interval);
  }
}
async function updateStatus(signal){
  while(token&&!signal.aborted){
    let alertError='';
    try{
      const latest=await json('/api/events',{signal,timeout:4500});
      if(signal.aborted)return;
      events=latest;
      await snapshot(signal);
    }catch(error){alertError=error.message}
    if(signal.aborted)return;
    metrics();
    eventList();
    const issues=sources.flatMap(source=>{
      const issue=previewErrors[source]||states[source]?.error;
      return issue?[names[source]+'：'+issue]:[];
    });
    if(alertError)issues.push('告警记录：'+alertError);
    text($('#connection'),Object.keys(previewErrors).length?'服务连接异常':'服务已连接');
    text($('#banner'),issues.length?issues.join('；'):normalBanner);
    await wait(statusPeriod);
  }
}
function startUpdates(){
  updates?.abort();
  updates=new AbortController();
  const signal=updates.signal;
  for(const source of sources)updateFrames(source,signal);
  updateStatus(signal);
}
async function loadAccount(){
  types=await json('/api/abnormal-types');
  markAvailableTypes();
  const config=await json('/api/settings');
  for(const [key,value] of Object.entries(parameterDefaults)) $('#param-'+key).value=config.parameters?.[key]??value;
  for(const key of behaviorKeys) $('#behavior-'+key).value=config.behavior_parameters?.[key]??'';
  document.querySelectorAll('#requested-types input').forEach(x=>x.checked=(config.requested_types||[]).includes(x.value));
  savedSources=config.sources;
  recognitionEnabled=config.recognition_enabled||{};
  const streams=await json('/api/rtsp-sources');
  for(const source of sources){
    const select=$('#rtsp-'+source);
    select.replaceChildren();
    if(!streams.length)select.add(new Option('管理员尚未配置',''));
    for(const stream of streams)select.add(new Option(stream.name,stream.id));
    select.value=[savedSources[source]?.rtsp_id,source+'-demo',streams[0]?.id].find(id=>streams.some(stream=>stream.id===id))||'';
  }
  const box=$('#types');
  box.replaceChildren();
  for(const type of types){
    const label=document.createElement('label');
    label.className='check';
    const input=document.createElement('input');
    input.type='checkbox';
    input.value=type.id;
    input.checked=config.enabled.includes(type.id);
    const span=document.createElement('span');
    span.textContent=type.name;
    const small=document.createElement('small');
    small.textContent=type.description;
    span.append(small);label.append(input,span);box.append(label);
  }
  authState();startUpdates();
  for(const source of sources) restoreSource(source);
}
function showUsageLimits(limits){
  $('#usage-rules').hidden=!limits;
  $('#usage-status').hidden=Boolean(limits);
  if(!limits)return;
  const values={...limits,events_per_tab:eventsPerTab};
  document.querySelectorAll('[data-limit]').forEach(element=>{
    text(element,values[element.dataset.limit]??'—');
  });
}
async function health(){
  showUsageLimits(null);
  try{
    const health=await json('/api/health');
    framePeriod=health.process_fps?Math.max(84,Math.min(200,1000/health.process_fps)):200;
    livePeriod=health.rtsp_preview_fps?1000/health.rtsp_preview_fps:0;
    resumeSavedSources=health.resume_saved_sources===true;
    showUsageLimits(health.limits);
    $('#parameters').dataset.baseline=String(health.baseline_parameters!==false);
    text($('#connection'),'后端可连接');text($('#banner'),'');
    if(token)await loadAccount();
  }catch{
    authState();text($('#connection'),'后端未连接');
    text($('#banner'),'当前识别服务未连接，旧画面可能已停止更新。网页仍可浏览；请稍后点击“恢复默认连接”重试。');
  }
}
$('#settings-form').onsubmit=async e=>{
  e.preventDefault();
  try{
    const config={
      enabled:[...document.querySelectorAll('#types input:checked')].map(x=>x.value),
      requested_types:[...document.querySelectorAll('#requested-types input:checked')].map(x=>x.value),
      behavior_parameters:Object.fromEntries(behaviorKeys.map(key=>{
        const input=$('#behavior-'+key);
        return [key,input.value===''?null:input.valueAsNumber];
      }))
    };
    if(!$('#parameters').disabled){
      config.parameters=Object.fromEntries(Object.keys(parameterDefaults).map(key=>[key,Number($('#param-'+key).value)]));
    }
    await put('/api/settings',config);
    toast('检测配置已保存');
  }catch(error){toast(error.message)}
};
const logRanges=[
  {date:$('#start'),hour:$('#start-hour'),minute:$('#start-minute'),label:'开始时间',lastMinute:false},
  {date:$('#end'),hour:$('#end-hour'),minute:$('#end-minute'),label:'结束时间',lastMinute:true}
];
for(const range of logRanges){
  for(const [select,count,unit] of [[range.hour,24,'时'],[range.minute,60,'分']]){
    for(let i=0;i<count;i++){
      const value=String(i).padStart(2,'0');
      select.add(new Option(value+' '+unit,value,i===0 || (range.lastMinute && i===count-1)));
    }
    select.selectedIndex=range.lastMinute?count-1:0;
  }
  const display=range.date.parentElement.querySelector('.log-date-value');
  range.sync=()=>{
    const value=range.date.value;
    range.hour.disabled=range.minute.disabled=!value;
    if(display){
      const [year,month,day]=value.split('-');
      display.textContent=value?year+'年'+month+'月'+day+'日':'选择日期';
      display.classList.toggle('empty',!value);
    }
  };
  if(display){
    const openPicker=event=>{
      try{
        range.date.showPicker();
        event.preventDefault();
      }catch{
        // Keep the browser's own picker action when showPicker is unavailable.
      }
    };
    range.date.addEventListener('click',openPicker);
    range.date.addEventListener('keydown',event=>{
      if(event.key===' '||event.key==='Enter')openPicker(event);
    });
  }
  range.date.addEventListener('input',range.sync);
  range.date.addEventListener('change',range.sync);
  range.sync();
}
$('#clear-log-range').onclick=()=>{
  for(const range of logRanges){
    range.date.value='';
    range.hour.selectedIndex=range.lastMinute?23:0;
    range.minute.selectedIndex=range.lastMinute?59:0;
    range.sync();
  }
  $('#logs-dialog .toast-inline')?.remove();
};
function selectedLogTime(range){
  if(!range.date.validity.valid)throw Error(range.label+'的日期无效');
  if(!range.date.value)return null;
  const [year,month,day]=range.date.value.split('-').map(Number);
  const hour=Number(range.hour.value),minute=Number(range.minute.value);
  const date=new Date(year,month-1,day,hour,minute,range.lastMinute?59:0,range.lastMinute?999:0);
  if(date.getFullYear()!==year||date.getMonth()!==month-1||date.getDate()!==day||date.getHours()!==hour||date.getMinutes()!==minute){
    throw Error(range.label+'在当前时区无效');
  }
  return date;
}
$('#download').onclick=async()=>{
  $('#logs-dialog .toast-inline')?.remove();
  try{
    const [start,end]=logRanges.map(selectedLogTime);
    if(start&&end&&start>end)throw Error('开始时间不能晚于结束时间');
    const query=new URLSearchParams();
    if(start)query.set('start',start.toISOString());
    if(end)query.set('end',end.toISOString());
    const r=await request('/api/logs.csv?'+query);
    const link=document.createElement('a');
    link.href=URL.createObjectURL(await r.blob());
    link.download='实验室告警.csv';
    link.click();
    setTimeout(()=>URL.revokeObjectURL(link.href),1000);
  }catch(e){toast(e.message)}
};
$('#account').onclick=async()=>{if(token){updates?.abort();try{await request('/api/logout',{method:'POST'})}catch{}token='';sessionStorage.removeItem('lab-session');location.reload()}else $('#auth').showModal()};
$('#close-auth').onclick=()=>$('#auth').close();$('#switch-auth').onclick=()=>{mode=mode==='login'?'register':'login';text($('#auth-title'),mode==='login'?'登录工作台':'创建实验账号');text($('#auth-submit'),mode==='login'?'登录':'注册并登录');text($('#switch-auth'),mode==='login'?'还没有账号？注册':'已有账号？登录');$('#password').autocomplete=mode==='login'?'current-password':'new-password';text($('#auth-error'),'')};
$('#auth-form').onsubmit=async e=>{e.preventDefault();$('#auth-submit').disabled=true;text($('#auth-error'),'');try{const result=await post('/api/'+mode,{email:$('#email').value,password:$('#password').value});token=result.token;email=result.email;sessionStorage.setItem('lab-session',JSON.stringify({api,token,email}));$('#password').value='';await loadAccount();$('#auth').close();toast('已登录')}catch(e){text($('#auth-error'),e.message)}finally{$('#auth-submit').disabled=false}};
$('#connect').onclick=async()=>{try{const value=$('#api-url').value.trim().replace(/\/$/,'');if(value){const u=new URL(value);if(u.protocol!=='https:' && !(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))throw Error('请输入 HTTPS 服务地址');if(u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('请只填写服务域名地址')}if(token&&value!==api){try{await request('/api/logout',{method:'POST'})}catch{}token='';email='';sessionStorage.removeItem('lab-session');clearWorkspace()}api=value;if(api===defaultApi)localStorage.removeItem('lab-api');else localStorage.setItem('lab-api',api);authState();await health()}catch(e){toast(e.message)}};
$('#reset-connection').onclick=async()=>{localStorage.removeItem('lab-api');sessionStorage.removeItem('lab-session');location.reload()};
document.querySelectorAll('[data-tab]').forEach(button=>button.onclick=()=>{tab=button.dataset.tab;document.querySelectorAll('[data-tab]').forEach(x=>{x.classList.toggle('selected',x===button);x.setAttribute('aria-selected',String(x===button))});eventList()});
async function boot(){drawCards();metrics();try{const config=await fetch('./config.json',{cache:'no-store'}).then(r=>r.ok?r.json():{});defaultApi=config.apiBase||'';api=localStorage.getItem('lab-api')??defaultApi;const saved=JSON.parse(sessionStorage.getItem('lab-session')||'null');if(saved&&saved.api===api){token=saved.token;email=saved.email}}catch{}$('#api-url').value=api;authState();await health()}boot();
