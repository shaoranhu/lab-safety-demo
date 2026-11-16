'use strict';
const $=s=>document.querySelector(s), sources=['monitor','robot'];
const names={monitor:'监控摄像头',robot:'机器人'}, states={};
let api='',token='',email='',types=[],events=[],tab='final',mode='login',lastShot='',shotURL='';
let savedSources={},paused={},defaultApi='';
let updates;
let framePeriod=200;
const previewErrors={}, motions={}, localMedia={}, statusPeriod=1500;
const parameterDefaults={confidence:.4,crowd_count:3,region_percent:50,lying_ratio:1.25,hold_seconds:1,alert_interval:3};
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
function authState(){text($('#account'),token?'退出 '+email:'注册 / 登录');$('#account').title=token?'退出 '+email:'注册 / 登录';$('#save-types').disabled=!token;$('#parameters').disabled=!token||$('#parameters').dataset.baseline==='false';$('#download').disabled=!token;document.querySelectorAll('.source-controls button,.source-controls input,.source-controls select,#types input,#requested-types input').forEach(x=>x.disabled=!token);}
function clearWorkspace(){updates?.abort();for(const key of sources){closeMotion(key);delete localMedia[key];delete states[key];delete previewErrors[key]}events=[];savedSources={};lastShot='';if(shotURL)URL.revokeObjectURL(shotURL);shotURL='';for(const img of document.querySelectorAll('.screen img')){img.hidden=true;img.removeAttribute('src');delete img.dataset.frame;delete img.dataset.time}for(const stamp of document.querySelectorAll('.frame-bar span'))text(stamp,'尚无画面');text($('#snapshot'),'暂无异常');text($('#snapshot-detail'),'');text($('#types'),'等待登录');types=[];markAvailableTypes();metrics();eventList()}
async function request(path,{timeout=15000,signal,headers,...options}={}){
  const session=token;
  const deadline=AbortSignal.timeout(timeout);
  const response=await fetch(api+path,{
    ...options,
    headers:{...(session?{Authorization:'Bearer '+session}:{}),...headers},
    signal:signal?AbortSignal.any([deadline,signal]):deadline
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
function drawCards(){for(const result of [false,true])for(const source of sources){const id=source+(result?'-result':'');const card=document.createElement('article');card.className='video';card.innerHTML=`<div class="video-head"><strong>${names[source]} · ${result?'识别结果':'原始视频'}</strong>${result?'':`<button class="configure-source" aria-label="设置${names[source]}来源">设置来源</button>`}</div><div class="screen"><div class="placeholder">${result?'等待识别画面':'设置视频来源开始测试'}</div><img id="image-${id}" hidden alt="${names[source]}${result?'识别结果':'原始画面'}"><canvas id="motion-${id}" aria-label="${names[source]}" hidden></canvas></div><div class="frame-bar"><span id="stamp-${id}">尚无画面</span><button class="text-button" id="pause-${id}">暂停画面</button></div>`;$('#videos').append(card);if(!result)card.querySelector('.configure-source').onclick=()=>{openDialog('sources-dialog');$('#file-'+source).focus()};$('#pause-'+id).onclick=()=>{paused[id]=!paused[id];text($('#pause-'+id),paused[id]?'继续画面':'暂停画面');toast(paused[id]?'已暂停此窗口显示，后台识别继续':'此窗口已恢复显示')}}
for(const source of sources){const controls=document.createElement('section');controls.className='source-controls';controls.innerHTML=`<h3>${names[source]}</h3><label>MP4 视频（最大 100 MB）<input id="file-${source}" type="file" accept="video/mp4,video/*"></label><div class="button-row"><button id="start-${source}" class="primary">上传并识别</button><button id="resume-${source}" class="secondary">恢复上次来源</button><button id="stop-${source}" class="secondary">停止识别</button></div><label>RTSP 测试流<select id="rtsp-${source}"><option value="">尚未配置</option></select></label><button id="rtsp-start-${source}" class="secondary full">连接 RTSP</button>`;$('#source-settings').append(controls)}
for(const source of sources){$('#start-'+source).onclick=()=>start(source);$('#resume-'+source).onclick=()=>resume(source);$('#rtsp-start-'+source).onclick=()=>startRTSP(source);$('#stop-'+source).onclick=async()=>{try{await request('/api/source/'+source,{method:'DELETE'});toast('已请求停止')}catch(e){toast(e.message)}}}}
async function resume(source){try{let value=savedSources[source];if(typeof value==='string')value={video_id:value};if(!value?.video_id&&!value?.rtsp_id)throw Error('还没有保存的视频来源');await post('/api/source/'+source,value);toast('已恢复保存的视频来源')}catch(e){toast(e.message)}}
async function startRTSP(source){try{const id=$('#rtsp-'+source).value;if(!id)throw Error('管理员尚未配置可用 RTSP 流');await post('/api/source/'+source,{rtsp_id:id});savedSources[source]={rtsp_id:id};toast('正在连接 RTSP 测试流')}catch(e){toast(e.message)}}
async function start(source){const file=$('#file-'+source).files[0];if(!file){toast('请先选择视频');return}if(file.size>100*1024*1024){toast('视频不能超过 100 MB');return}const button=$('#start-'+source);button.disabled=true;text(button,'上传中…');try{const upload=await json('/api/upload',{method:'POST',body:file,headers:{'Content-Type':'application/octet-stream'},timeout:120000});localMedia[source]={id:upload.id,file};savedSources[source]={video_id:upload.id};await post('/api/source/'+source,savedSources[source]);toast('已启动识别，请等待模型加载')}catch(e){toast(e.message)}finally{button.disabled=!token;text(button,'上传并识别')}}
function metrics(){const body=$('#metrics');body.replaceChildren();text($('#source-summary'),sources.filter(s=>states[s]?.state==='online').length+' / 2 路运行中');for(const source of sources){const state=states[source]||{},p=state.packet||{};const label={offline:'未连接',connecting:'正在读取',online:'在线',error:'错误',stopped:'已停止',disconnected:'连接中断'}[state.state]||'未连接';const tr=document.createElement('tr');for(const value of [names[source],label,p.people??'—',p.resolution||'—',state.state==='online'?(p.fps??'—'):'—',p.process_ms?`${p.process_ms} ms`:'—',p.frame_id??'—']){const td=document.createElement('td');td.textContent=value;tr.append(td)}if(state.error)tr.title=state.error;body.append(tr)}}
function eventList(){
  const box=$('#events');box.replaceChildren();$('#fusion-note').hidden=tab!=='final';text($('#event-count'),events.length?'最近 '+events.length+' 条':'暂无记录');
  const current=sources.filter(s=>tab==='final'||s===tab).filter(s=>states[s]?.packet);
  for(const source of current){
    const state=states[source],p=state.packet,row=document.createElement('div');row.className='current-result';
    const title=document.createElement('strong');
    title.textContent=names[source]+(state.state==='online'?' · 当前 ':' · 最后一帧 ')+p.people+' 人 · '+(p.findings.length?'检测到实验规则异常':'未触发所选异常规则');
    const detail=document.createElement('p');
    detail.textContent=new Date(p.time).toLocaleString()+' · 帧 '+p.frame_id+' · '+(p.findings.map(f=>f.pose).join(' / ')||'姿态尚未分类');
    const description=document.createElement('p');description.textContent=p.description||'等待行为描述';
    row.append(title,detail,description);box.append(row);
  }
  const list=events.filter(e=>tab==='final'||e.source===tab);
  if(!list.length){const p=document.createElement('p');text(p,token?'暂无异常记录':'登录后查看识别结果');box.append(p);return}
  for(const event of list.slice(0,15)){
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
  if(!packet?.raw)return;
  for(const [id,jpeg] of [[source,packet.raw],[source+'-result',packet.result]]){
    if(paused[id])continue;
    const image=$('#image-'+id);
    // The timestamp distinguishes a replacement video that starts at the same frame number.
    if(image.dataset.frame===String(packet.frame_id)&&image.dataset.time===packet.time)continue;
    image.src='data:image/jpeg;base64,'+jpeg;
    image.dataset.frame=packet.frame_id;
    image.dataset.time=packet.time;
    image.hidden=false;
    text($('#stamp-'+id),'帧 '+packet.frame_id+' · '+new Date(packet.time).toLocaleTimeString());
  }
}
function closeMotion(source){
  motions[source]?.close();
  delete motions[source];
}
function updateMotion(source,state){
  let current=motions[source];
  if(!state.playback||!['online','connecting'].includes(state.state)){
    closeMotion(source);
    return false;
  }
  if(current?.playback.stream_id!==state.playback.stream_id){
    closeMotion(source);
    const playback=state.playback;
    const motion=new FileMotionPreview(source,playback,id=>paused[id],()=>{
      if(motions[source]!==motion||motion.abort.signal.aborted)return;
      motion.close();
    });
    motions[source]=motion;
    current=motion;
    const cached=localMedia[source];
    const file=cached?.id===playback.video_id
      ? Promise.resolve(cached.file)
      : request('/api/media/'+encodeURIComponent(playback.video_id),{signal:motion.abort.signal,timeout:120000}).then(response=>response.blob());
    file.then(data=>motion.open(data)).catch(()=>motion.onFailure());
  }
  if(!current.abort.signal.aborted)current.addPacket(state.packet);
  return current.ready;
}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function updateFrames(source,signal){
  while(token&&!signal.aborted){
    const started=performance.now();
    try{
      const motion=motions[source];
      const query=motion?.ready?'?metadata='+encodeURIComponent(motion.playback.stream_id):'';
      const state=await json('/api/frame/'+source+query,{signal,timeout:4500});
      if(signal.aborted)return;
      states[source]=state;
      delete previewErrors[source];
      if(!updateMotion(source,state))displayFrame(source,state.packet);
    }catch(error){
      if(signal.aborted)return;
      states[source]={...states[source],state:'disconnected',error:''};
      previewErrors[source]=error.message;
    }
    const active=!document.hidden&&['online','connecting'].includes(states[source]?.state);
    const interval=active?framePeriod:statusPeriod;
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
async function loadAccount(){types=await json('/api/abnormal-types');markAvailableTypes();const config=await json('/api/settings');for(const [key,value] of Object.entries({...parameterDefaults,...config.parameters}))if($('#param-'+key))$('#param-'+key).value=value;document.querySelectorAll('#requested-types input').forEach(x=>x.checked=(config.requested_types||[]).includes(x.value));savedSources=config.sources;const streams=await json('/api/rtsp-sources');for(const source of sources){const select=$('#rtsp-'+source);select.replaceChildren();if(!streams.length)select.add(new Option('管理员尚未配置',''));for(const stream of streams)select.add(new Option(stream.name,stream.id));select.value=savedSources[source]?.rtsp_id||streams.find(s=>s.id===source+'-demo')?.id||streams[0]?.id||''}const box=$('#types');box.replaceChildren();for(const type of types){const label=document.createElement('label');label.className='check';const input=document.createElement('input');input.type='checkbox';input.value=type.id;input.checked=config.enabled.includes(type.id);const span=document.createElement('span');span.textContent=type.name;const small=document.createElement('small');small.textContent=type.description;span.append(small);label.append(input,span);box.append(label)}authState();startUpdates();}
async function health(){try{const health=await json('/api/health');framePeriod=health.process_fps?Math.max(84,Math.min(200,1000/health.process_fps)):200;$('#parameters').dataset.baseline=String(health.baseline_parameters!==false);text($('#connection'),'后端可连接');text($('#banner'),'');if(token)await loadAccount()}catch{authState();text($('#connection'),'后端未连接');text($('#banner'),'当前识别服务未连接，旧画面可能已停止更新。网页仍可浏览；请稍后点击“恢复默认连接”重试。')}}
$('#settings-form').onsubmit=async e=>{e.preventDefault();try{await json('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:[...document.querySelectorAll('#types input:checked')].map(x=>x.value),requested_types:[...document.querySelectorAll('#requested-types input:checked')].map(x=>x.value),parameters:Object.fromEntries(Object.keys(parameterDefaults).map(key=>[key,Number($('#param-'+key).value)]))})});toast('已保存：清单勾选为接入计划，已接入测试规则在后续推理中生效')}catch(e){toast(e.message)}};
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
