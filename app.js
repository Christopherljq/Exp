'use strict';
if('serviceWorker' in navigator){
  window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js').catch(e=>console.error('SW reg failed:',e)));
}
const BASE_THRESHOLDS=[5,11,18,26,35,45,56,68,81,95,110,126,143,161];
const BASE_EXP_NEEDED=[5,6,7,8,9,10,11,12,13,14,15,16,17,18];
const MAX_LEVEL=16;
const WORKER='https://bgg-proxy.christopherljq.workers.dev';
function getDynThresholds(){return[...BASE_THRESHOLDS,mechanics.length];}
function getDynExpNeeded(){return[...BASE_EXP_NEEDED,mechanics.length-161];}
function getLevel(ticked){const t=getDynThresholds();for(let i=0;i<t.length;i++){if(ticked<t[i])return i+1;}return MAX_LEVEL;}
function getLevelProgress(ticked){
  const t=getDynThresholds(),e=getDynExpNeeded();
  const last=t[t.length-1];
  if(ticked>=last)return{level:MAX_LEVEL,cur:e[e.length-1],needed:e[e.length-1],pct:100,levelUp:false};
  const threshIdx=t.indexOf(ticked);
  if(threshIdx!==-1){const needed=e[threshIdx];return{level:threshIdx+1,cur:needed,needed,pct:100,levelUp:true};}
  const lv=getLevel(ticked);const prevTotal=lv>1?t[lv-2]:0;const needed=e[lv-1];const cur=ticked-prevTotal;
  return{level:lv,cur,needed,pct:needed>0?(cur/needed*100):0,levelUp:false};
}

async function bggSearch(query){
  try{
    const q=query.trim().toLowerCase();
    // First try exact search
    const exactResp=await fetch(`${WORKER}/search?query=${encodeURIComponent(query)}&type=boardgame&exact=1`);
    let exactResults=[];
    if(exactResp.ok){
      const xml=(new DOMParser()).parseFromString(await exactResp.text(),'text/xml');
      exactResults=[...xml.querySelectorAll('item')].map(item=>({
        id:item.getAttribute('id'),
        name:item.querySelector('name')?.getAttribute('value')||'',
        year:item.querySelector('yearpublished')?.getAttribute('value')||''
      }));
    }
    // Then do regular search
    const resp=await fetch(`${WORKER}/search?query=${encodeURIComponent(query)}&type=boardgame`);
    let results=[];
    if(resp.ok){
      const xml=(new DOMParser()).parseFromString(await resp.text(),'text/xml');
      results=[...xml.querySelectorAll('item')].slice(0,20).map(item=>({
        id:item.getAttribute('id'),
        name:item.querySelector('name')?.getAttribute('value')||'',
        year:item.querySelector('yearpublished')?.getAttribute('value')||''
      }));
    }
    // Merge exact results at top, remove duplicates
    const seen=new Set();
    const merged=[];
    [...exactResults,...results].forEach(r=>{
      if(!seen.has(r.id)){seen.add(r.id);merged.push(r);}
    });
    function matchScore(name){
      const n=name.toLowerCase();
      if(n===q)return 0;
      if(n.startsWith(q+' ')||n.startsWith(q+':'))return 1;
      if(n.startsWith(q))return 2;
      return 3;
    }
    merged.sort((a,b)=>matchScore(a.name)-matchScore(b.name));
    return merged.slice(0,5);
  }catch(e){console.warn('BGG search failed:',e);return[];}
}

async function bggThing(id){
  try{
    const resp=await fetch(`${WORKER}/thing?id=${id}&type=boardgame&stats=1`);
    if(!resp.ok)return null;
    const xml=(new DOMParser()).parseFromString(await resp.text(),'text/xml');
    const item=xml.querySelector('item');if(!item)return null;
    const fix=s=>s?(s.startsWith('//')?'https:'+s:s):null;
    const thumb=fix(item.querySelector('thumbnail')?.textContent?.trim());
    const img=fix(item.querySelector('image')?.textContent?.trim());
    const year=item.querySelector('yearpublished')?.getAttribute('value')||null;
    const ratings=item.querySelector('ratings');
    const avgRating=ratings?.querySelector('average')?.getAttribute('value');
    const avgWeight=ratings?.querySelector('averageweight')?.getAttribute('value');
    let rank=null;
    for(const r of item.querySelectorAll('rank')){
      if(r.getAttribute('type')==='subtype'&&r.getAttribute('name')==='boardgame'){
        const v=r.getAttribute('value');rank=(v&&v!=='Not Ranked')?v:null;break;
      }
    }
    let kickstarted=false;const mechs=[];
    for(const l of item.querySelectorAll('link')){
      const t=l.getAttribute('type');
      if(t==='boardgamefamily'&&(l.getAttribute('value')||'').toLowerCase().includes('kickstarter'))kickstarted=true;
      if(t==='boardgamemechanic')mechs.push({name:l.getAttribute('value'),id:l.getAttribute('id')});
    }
    return{thumbnail:thumb,image:img,year,
      avgRating:avgRating?parseFloat(avgRating).toFixed(2):null,
      avgWeight:avgWeight?parseFloat(avgWeight).toFixed(2):null,
      rank,kickstarted,mechanics:mechs};
  }catch(e){console.warn('BGG thing failed:',e);return null;}
}

const DB_NAME='dexp_db',DB_VER=1;
let db;
function openDB(){return new Promise((res,rej)=>{const req=indexedDB.open(DB_NAME,DB_VER);req.onupgradeneeded=e=>{const d=e.target.result;if(!d.objectStoreNames.contains('store'))d.createObjectStore('store');};req.onsuccess=e=>{db=e.target.result;res(db);};req.onerror=e=>rej(e);});}
function dbGet(k){return new Promise((res,rej)=>{const tx=db.transaction('store','readonly');const req=tx.objectStore('store').get(k);req.onsuccess=e=>res(e.target.result);req.onerror=e=>rej(e);});}
function dbSet(k,v){return new Promise((res,rej)=>{const tx=db.transaction('store','readwrite');const req=tx.objectStore('store').put(v,k);req.onsuccess=()=>res();req.onerror=e=>rej(e);});}
function clone(x){return JSON.parse(JSON.stringify(x));}
let mechanics=[],meta={},games=[];
let mechFilter='all',gamesFilter='all';
let editingMechanics=false,editingGames=false;
let detailGameId=null,renamingIdx=null;
let mechSnap=null,metaSnap=null,gamesSnap=null;

let selectedGameMechs=new Set();
let _lastRenderedLevel=null;
let pendingDeleteMech=null,pendingDeleteGame=null,delMode='mech';
let pendingBggData=null,bggDropTimer=null,bggDropBlocked=false;
let gameFormMode='add',editingGameIdx=null;
let currentMechName=null;

async function saveAll(){await dbSet('mechanics',mechanics);await dbSet('meta',meta);await dbSet('games',games);}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function fmtDate(s){if(!s)return'';return new Date(s+'T00:00:00').toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});}
function getMeta(m){if(!meta[m])meta[m]={liked:false,manualTick:false,manualUntick:false,comments:'',bggId:null};return meta[m];}
function gameTickedSet(){const s=new Set();games.forEach(g=>g.mechanics.forEach(m=>s.add(m)));return s;}
function isTicked(m){const mt=getMeta(m);if(mt.manualUntick)return false;if(mt.manualTick)return true;return gameTickedSet().has(m);}
function mechExists(name,excludeIdx=-1){return mechanics.some((m,i)=>i!==excludeIdx&&m.toLowerCase()===name.toLowerCase());}
function mkBtn(label,cls,fn){const b=document.createElement('button');b.className=cls;b.textContent=label;b.addEventListener('click',fn);return b;}
function ksIconSVG(size=16){
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle;flex-shrink:0;display:inline-block;"><circle cx="50" cy="50" r="50" fill="#05ce78"/><rect x="20" y="15" width="17" height="70" rx="8.5" fill="white"/><path d="M33,47 Q36,41 62,18 Q69,11 77,16 Q85,22 80,30 L52,50 L80,70 Q85,78 77,84 Q69,89 62,82 Q36,59 33,53Z" fill="white"/></svg>`;
}
function updateMechCount(){const el=document.getElementById('mechCount');if(el)el.textContent=`(${mechanics.length})`;}
function togglePanel(overlayId,panelId,open){
  document.getElementById(overlayId).classList.toggle('open',open);
  document.getElementById(panelId).classList.toggle('open',open);
}
let imgScale=1,imgLastDist=0;
function openImgOverlay(src){
  if(!src)return;
  const img=document.getElementById('imgOverlayImg');
  img.src=src;imgScale=1;img.style.transform='scale(1)';
  document.getElementById('imgOverlay').classList.add('open');
}
function closeImgOverlay(){document.getElementById('imgOverlay').classList.remove('open');}
document.getElementById('imgOverlay').addEventListener('click',e=>{if(e.target===document.getElementById('imgOverlay'))closeImgOverlay();});
const _oImg=document.getElementById('imgOverlayImg');
_oImg.addEventListener('touchstart',e=>{if(e.touches.length===2)imgLastDist=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);},{passive:true});
_oImg.addEventListener('touchmove',e=>{
  if(e.touches.length!==2)return;
  const d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);
  imgScale=Math.min(Math.max(imgScale*(d/imgLastDist),1),4);imgLastDist=d;
  _oImg.style.transform=`scale(${imgScale})`;
},{passive:true});
_oImg.addEventListener('touchend',()=>{if(imgScale<1.05){imgScale=1;_oImg.style.transform='scale(1)';}},{passive:true});
function openDeleteConfirm(title,msg,mode,pendingMech,pendingGame){
  delMode=mode;pendingDeleteMech=pendingMech||null;
  pendingDeleteGame=pendingGame!==undefined?pendingGame:null;
  document.getElementById('delTitle').textContent=title;
  document.getElementById('delMsg').textContent=msg;
  document.getElementById('delOverlay').classList.add('open');
}
function closeDeleteConfirm(){document.getElementById('delOverlay').classList.remove('open');}
document.getElementById('btnDelCancel').addEventListener('click',closeDeleteConfirm);
document.getElementById('delOverlay').addEventListener('click',e=>{if(e.target===document.getElementById('delOverlay'))closeDeleteConfirm();});
document.getElementById('btnDelConfirm').addEventListener('click',()=>{
  if(delMode==='mech'&&pendingDeleteMech){
    const didx=mechanics.indexOf(pendingDeleteMech);
    if(didx!==-1){mechanics.splice(didx,1);delete meta[pendingDeleteMech];games.forEach(g=>{g.mechanics=g.mechanics.filter(x=>x!==pendingDeleteMech);});renderMechs();updateExp();updateMechCount();saveAll();}
    pendingDeleteMech=null;
  } else if(delMode==='game'&&pendingDeleteGame!==null){
    const idx=pendingDeleteGame;
    games.splice(idx,1);
    if(detailGameId===idx)closeSP('spDetail');
    else if(detailGameId!==null&&detailGameId>idx)detailGameId--;
    saveAll();renderGames();updateExp();renderMechs();
    pendingDeleteGame=null;
  }
  closeDeleteConfirm();
});
async function openMechDetail(m){
  currentMechName=m;
  const mt=getMeta(m);
  document.getElementById('mechDetailTitle').textContent=m;
  const h=document.getElementById('mechDetailHeart');
  h.className='heart'+(mt.liked?' on':'');h.textContent=mt.liked?'♥':'♡';
  document.getElementById('mechDetailComments').value=mt.comments||'';
  document.getElementById('mechDetailOverlay').classList.add('open');
}

function closeMechDetail(){currentMechName=null;document.getElementById('mechDetailOverlay').classList.remove('open');}
document.getElementById('mechDetailHeart').addEventListener('click',()=>{
  if(!currentMechName)return;
  const mt=getMeta(currentMechName);mt.liked=!mt.liked;
  const h=document.getElementById('mechDetailHeart');
  h.className='heart'+(mt.liked?' on':'');h.textContent=mt.liked?'♥':'♡';
  saveAll();renderMechs();
});
document.getElementById('btnMechDetailCancel').addEventListener('click',closeMechDetail);
document.getElementById('mechDetailOverlay').addEventListener('click',e=>{if(e.target===document.getElementById('mechDetailOverlay'))closeMechDetail();});
document.getElementById('btnMechDetailSave').addEventListener('click',()=>{
  if(!currentMechName)return;
  getMeta(currentMechName).comments=document.getElementById('mechDetailComments').value.trim();
  saveAll();closeMechDetail();
});
function applyPanelLayout(forceMode){
  const gamesPanel=document.getElementById('gamesPanel');
  const mechPanel=document.getElementById('mechPanel');
  const mode=forceMode||(editingMechanics?'mechEdit':editingGames?'gameEdit':'normal');
  if(mode==='mechEdit'){
    gamesPanel.style.display='none';mechPanel.style.display='';mechPanel.style.flex='1';
  } else if(mode==='gameEdit'){
    mechPanel.style.display='none';gamesPanel.style.display='';
    gamesPanel.style.flex='1';gamesPanel.style.height='';gamesPanel.style.maxHeight='';gamesPanel.style.minHeight='';
  } else {
    gamesPanel.style.display='';mechPanel.style.display='';mechPanel.style.flex='';gamesPanel.style.flex='';
    const expRect=document.getElementById('expBox').getBoundingClientRect();
    const innerRect=document.getElementById('mainInner').getBoundingClientRect();
    const remaining=innerRect.bottom-expRect.bottom-8;
    const maxH=Math.max(130,Math.floor(remaining*0.50));
    const HDR=40,PAD=16,FILTER=games.length>0?44:0,ROW=80;
    const contentH=HDR+PAD+FILTER+(games.length>0?games.length*ROW:44);
    const h=Math.min(maxH,Math.max(130,contentH));
    gamesPanel.style.height=h+'px';gamesPanel.style.maxHeight=maxH+'px';gamesPanel.style.minHeight='130px';
  }
}
function setPanelH(){
  applyPanelLayout();
  const titleRect=document.querySelector('.app-title').getBoundingClientRect();
  document.getElementById('levelPanel').style.top=(titleRect.bottom+6)+'px';
  const expBottom=document.getElementById('expBox').getBoundingClientRect().bottom;
  const h=Math.max(370,window.innerHeight-expBottom+40);
  document.getElementById('spDetailInner').style.maxHeight=h+'px';
  document.getElementById('spAddGameInner').style.maxHeight=Math.min(1200,window.innerHeight*.85)+'px';
}
function openSP(id){document.getElementById(id).classList.add('open');}
function closeSP(id){document.getElementById(id).classList.remove('open');if(id==='spDetail')detailGameId=null;}
function initSP(id){
  const panel=document.getElementById(id);const inner=panel.querySelector('.sp-inner');
  panel.addEventListener('click',e=>{if(e.target===panel){const r=inner.getBoundingClientRect();if(e.clientY<r.top)closeSP(id);}});
  let sy=0,cy=0,active=false,blocked=false;
  inner.addEventListener('touchstart',e=>{
    blocked=[...inner.querySelectorAll('.mech-scroll,.games-list-scroll,.detail-scroll,.mech-pick-scroll,.sp-scroll-body')].some(el=>el.contains(e.target));
    sy=e.touches[0].clientY;cy=sy;active=true;
  },{passive:true});
  inner.addEventListener('touchmove',e=>{
    if(!active||blocked)return;cy=e.touches[0].clientY;const dy=cy-sy;
    if(dy>0){inner.style.transition='none';inner.style.transform=`translateY(${dy}px)`;}
  },{passive:true});
  inner.addEventListener('touchend',()=>{
    active=false;if(blocked){blocked=false;return;}inner.style.transition='';
    if(cy-sy>inner.offsetHeight*.25){inner.style.transform='';closeSP(id);}else inner.style.transform='';
  });
}
['spDetail','spAddGame','spAddMech'].forEach(initSP);
document.getElementById('btnExpInfo').addEventListener('click',()=>togglePanel('levelPanelOverlay','levelPanel',true));
document.getElementById('btnLevelClose').addEventListener('click',()=>togglePanel('levelPanelOverlay','levelPanel',false));
document.getElementById('levelPanelOverlay').addEventListener('click',()=>togglePanel('levelPanelOverlay','levelPanel',false));
function initSearchClear(inputId,clearId,onClear){
  const inp=document.getElementById(inputId),btn=document.getElementById(clearId);
  inp.addEventListener('input',()=>btn.classList.toggle('visible',inp.value.length>0));
  btn.addEventListener('mousedown',e=>e.preventDefault());
  btn.addEventListener('click',()=>{inp.value='';btn.classList.remove('visible');onClear();inp.focus();});
}
initSearchClear('mechSearch','mechSearchClear',renderMechs);
initSearchClear('gamesMechSearch','gamesMechSearchClear',()=>renderMechPicker(''));
document.getElementById('gamesMechSearch').addEventListener('input',e=>renderMechPicker(e.target.value));
function updateExp(){
  const ticked=mechanics.filter(m=>isTicked(m)).length;
  const{level,cur,needed,pct,levelUp}=getLevelProgress(ticked);
  document.getElementById('expFill').style.width=pct+'%';
  document.getElementById('expLabel').innerHTML=`<span class="ew">EXP.</span> ${cur}/${needed} [${pct.toFixed(2)}%]`;
  const lvEl=document.getElementById('expLevelLabel');
lvEl.textContent=level===MAX_LEVEL?'MAX':(levelUp?'Level Up! LV. '+level:'LV. '+level);
lvEl.className='exp-level'+(levelUp?' level-up':'');

  drawTicks();
  if(level!==_lastRenderedLevel){_lastRenderedLevel=level;renderLevelTable(level);}
}

function drawTicks(){
  const canvas=document.getElementById('expCanvas'),wrap=document.getElementById('expWrap');
  const w=wrap.offsetWidth,h=wrap.offsetHeight;if(!w||!h)return;
  canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');ctx.clearRect(0,0,w,h);
  for(let i=0;i<=40;i++){
    const x=Math.round(i/40*w),maj=i%10===0,mid=i%5===0;
    const th=maj?h:mid?Math.round(h*.55):Math.round(h*.32);
    ctx.strokeStyle=maj?'rgba(0,0,0,0.5)':'rgba(0,0,0,0.28)';ctx.lineWidth=maj?1.5:0.8;
    ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,th);ctx.stroke();
    ctx.beginPath();ctx.moveTo(x,h);ctx.lineTo(x,h-th);ctx.stroke();
  }
}
function renderLevelTable(currentLevel){
  const tbody=document.getElementById('levelTableBody');tbody.innerHTML='';
  const t=getDynThresholds(),e=getDynExpNeeded();
  e.forEach((needed,i)=>{
    const lv=i+1,total=t[i];
    const tr=document.createElement('tr');if(lv===currentLevel)tr.className='current-level';
    tr.innerHTML=`<td>${lv}</td><td>${needed}</td><td>${total}</td>`;tbody.append(tr);
  });
  const trMax=document.createElement('tr');if(currentLevel===MAX_LEVEL)trMax.className='current-level';
  trMax.innerHTML=`<td>${MAX_LEVEL}</td><td>—</td><td>${t[t.length-1]}</td>`;tbody.append(trMax);
}
function renderGamesHdr(){
  const el=document.getElementById('gamesHdrBtns');el.innerHTML='';
  if(editingGames){el.append(mkBtn('Cancel','btn sm',cancelEditGames),mkBtn('Done','btn sm',doneEditGames));}
  else{el.append(mkBtn('Edit','btn sm',startEditGames),mkBtn('Add','btn sm',openAddGame));}
}
function startEditGames(){gamesSnap=clone(games);editingGames=true;applyPanelLayout('gameEdit');renderGamesHdr();renderGames();}
function cancelEditGames(){games=clone(gamesSnap);editingGames=false;applyPanelLayout('normal');renderGamesHdr();renderGames();updateExp();renderMechs();saveAll();}
function doneEditGames(){editingGames=false;applyPanelLayout('normal');renderGamesHdr();renderGames();}


function renderGames(){
  renderGamesHdr();
  const filterEl=document.getElementById('gamesFilterRow');filterEl.innerHTML='';
  if(!editingGames&&games.length){
    const row=document.createElement('div');row.className='filter-row';
    ['all','liked'].forEach(v=>row.append(mkBtn(v==='all'?'All':'Liked','btn sm'+(gamesFilter===v?' active-filter':''),()=>{gamesFilter=v;renderGames();})));
    filterEl.append(row);
  }
  const el=document.getElementById('gamesList');el.innerHTML='';
  const list=editingGames?games:(gamesFilter==='liked'?games.filter(g=>g.liked):games);
  if(!list.length){el.innerHTML=`<div class="empty">${games.length?'No liked games.':'No games recorded yet.'}</div>`;applyPanelLayout();return;}
  list.forEach(g=>{
    const i=games.indexOf(g);
    const row=document.createElement('div');row.className='game-row';
    const thumbSrc=g.thumbnail||g.thumb||null;
    if(thumbSrc){
      const img=document.createElement('img');img.className='game-thumb';img.src=thumbSrc;img.alt='';img.width=44;img.height=44;
      if(!editingGames)img.addEventListener('click',e=>{e.stopPropagation();openImgOverlay(g.image||thumbSrc);});
      row.append(img);
    } else {
      const ph=document.createElement('div');ph.className='game-thumb-placeholder';ph.textContent='?';row.append(ph);
    }
    const info=document.createElement('div');info.className='game-info';
    const nameDiv=document.createElement('div');nameDiv.className='game-name';
    nameDiv.append(document.createTextNode(g.name));
    if(!editingGames&&g.kickstarted){const ks=document.createElement('span');ks.innerHTML=ksIconSVG(14);nameDiv.append(ks);}
    const dateDiv=document.createElement('div');dateDiv.className='game-date';dateDiv.textContent=fmtDate(g.date);
    info.append(nameDiv,dateDiv);
    if(!editingGames)info.addEventListener('click',()=>openDetail(i));
    const acts=document.createElement('div');acts.className='game-actions';
    if(editingGames){
      acts.append(
        mkBtn('Edit','btn sm blue',()=>openEditGame(i)),
        mkBtn('Delete','btn sm danger',()=>openDeleteConfirm('Delete Game',`Are you sure you want to delete "${g.name}"?`,'game',null,i))
      );
    } else {
      const h=document.createElement('button');h.className='heart'+(g.liked?' on':'');h.textContent=g.liked?'♥':'♡';
      h.addEventListener('click',e=>{e.stopPropagation();toggleGameLike(i);});
      acts.append(h);
    }
    row.append(info,acts);el.append(row);
  });
  applyPanelLayout();
}
function toggleGameLike(i){
  games[i].liked=!games[i].liked;saveAll();renderGames();
  if(detailGameId===i){const h=document.getElementById('detailHeart');h.textContent=games[i].liked?'♥':'♡';h.className='heart'+(games[i].liked?' on':'');}
}
function openDetail(i){
  detailGameId=i;const g=games[i];
  const dn=document.getElementById('detailName');dn.innerHTML='';
  dn.append(document.createTextNode(g.name));
  if(g.kickstarted){const ks=document.createElement('span');ks.innerHTML=ksIconSVG(18);dn.append(ks);}
  document.getElementById('detailDate').textContent=fmtDate(g.date)||'—';
  const h=document.getElementById('detailHeart');
  h.textContent=g.liked?'♥':'♡';h.className='heart'+(g.liked?' on':'');
  const tw=document.getElementById('detailThumbWrap');tw.innerHTML='';
  const imgSrc=g.image||g.thumbnail||g.thumb||null;
  if(imgSrc){
    const img=document.createElement('img');img.className='detail-thumb';img.src=imgSrc;img.alt=g.name;
    img.addEventListener('click',()=>openImgOverlay(g.image||imgSrc));tw.append(img);
  }
  const infoEl=document.getElementById('detailInfo');infoEl.innerHTML='';
  const hasInfo=!!(g.year||g.avgRating||g.avgWeight||g.rank!==undefined);
  document.getElementById('detailInfoSec').style.display=hasInfo?'':'none';
  if(hasInfo){
    const row=document.createElement('div');row.className='detail-info-row';
    [g.year?{lbl:'Year',val:g.year}:null,
     g.avgRating?{lbl:'Rating',val:g.avgRating}:null,
     g.avgWeight?{lbl:'Weight',val:g.avgWeight+'/5'}:null,
     {lbl:'BGG Rank',val:g.rank?'#'+g.rank:'N/A'}
    ].filter(Boolean).forEach(({lbl,val})=>{
      const c=document.createElement('div');c.className='detail-info-chip';
      c.innerHTML=`<span class="lbl">${lbl}</span>${esc(String(val))}`;row.append(c);
    });
    infoEl.append(row);
  }
  const mel=document.getElementById('detailMechs');mel.innerHTML='';
  if(g.mechanics&&g.mechanics.length){
    g.mechanics.forEach(m=>{
      const chip=document.createElement('span');chip.className='detail-chip';chip.textContent=m;
      chip.addEventListener('click',()=>openMechDetail(m));mel.append(chip);
    });
  } else {
    mel.innerHTML='<span style="color:var(--pc);font-style:italic">None recorded</span>';
  }
  const commSec=document.getElementById('detailCommentsSec');
  const commEl=document.getElementById('detailComments');
  if(g.comments){commSec.style.display='';commEl.className='detail-comments';commEl.textContent=g.comments;}
  else{commSec.style.display='none';commEl.textContent='';}
  openSP('spDetail');
}
function hideBggDropdown(){const el=document.getElementById('bggDropdown');el.classList.remove('visible');el.innerHTML='';}
function showBggDropdown(results){
  const el=document.getElementById('bggDropdown');el.innerHTML='';
  if(!results.length){el.classList.remove('visible');return;}
  results.forEach(r=>{
    const item=document.createElement('div');item.className='bgg-drop-item';
    item.innerHTML=`<span class="bgg-drop-name">${esc(r.name)}</span><span class="bgg-drop-year">${r.year||''}</span>`;
    item.addEventListener('mousedown',e=>e.preventDefault());
    item.addEventListener('click',async()=>{
      hideBggDropdown();document.getElementById('newGameName').value=r.name;
      document.getElementById('newGameNameClear').classList.add('visible');
      bggDropBlocked=true;
      const data=await bggThing(r.id);pendingBggData=data;
      if(data)await applyBggMechanics(data.mechanics||[]);
    });
    el.append(item);
  });
  el.classList.add('visible');
}
async function applyBggMechanics(bggMechs){
  let changed=false;
  bggMechs.forEach(bm=>{
    const name=typeof bm==='string'?bm:bm.name;
    const bggId=typeof bm==='string'?null:bm.id;
    const match=mechanics.find(m=>m.toLowerCase()===name.toLowerCase());
    if(match){
      selectedGameMechs.add(match);
      if(bggId&&!getMeta(match).bggId){getMeta(match).bggId=bggId;changed=true;}
    } else {
      const idx=mechanics.findIndex(m=>m.toLowerCase()>name.toLowerCase());
      if(idx===-1)mechanics.push(name);else mechanics.splice(idx,0,name);
      getMeta(name).bggId=bggId;selectedGameMechs.add(name);changed=true;
    }
  });
  if(changed)saveAll();
  renderMechPicker(document.getElementById('gamesMechSearch').value);
  updateMechCount();
}
const newGameNameInp=document.getElementById('newGameName');
const newGameNameClear=document.getElementById('newGameNameClear');
newGameNameClear.addEventListener('mousedown',e=>e.preventDefault());
newGameNameClear.addEventListener('click',()=>{
  newGameNameInp.value='';newGameNameClear.classList.remove('visible');
  pendingBggData=null;bggDropBlocked=false;hideBggDropdown();
  selectedGameMechs.clear();renderMechPicker('');newGameNameInp.focus();
});
newGameNameInp.addEventListener('input',e=>{
  const val=e.target.value.trim();
  newGameNameClear.classList.toggle('visible',val.length>0);
  bggDropBlocked=false;pendingBggData=null;clearTimeout(bggDropTimer);
  if(val.length<3){hideBggDropdown();return;}
  const el=document.getElementById('bggDropdown');
  el.innerHTML='<div class="bgg-drop-hint">Searching...</div>';el.classList.add('visible');
  bggDropTimer=setTimeout(async()=>{showBggDropdown(await bggSearch(val));},500);
});
newGameNameInp.addEventListener('blur',()=>{
  setTimeout(async()=>{
    hideBggDropdown();
    if(bggDropBlocked){bggDropBlocked=false;return;}
    const name=document.getElementById('newGameName').value.trim();
    if(!name||pendingBggData)return;
    const results=await bggSearch(name);if(!results.length)return;
    const q=name.toLowerCase();
    const exact=results.find(r=>r.name.toLowerCase()===q);
    const best=exact||results[0];
    const data=await bggThing(best.id);pendingBggData=data;
    if(data)await applyBggMechanics(data.mechanics||[]);
  },200);
});

function renderMechPicker(searchVal){
  const el=document.getElementById('mechPickList');el.innerHTML='';
  const s=(searchVal||'').trim().toLowerCase();
  const list=mechanics.filter(m=>!s||m.toLowerCase().includes(s));
  if(!list.length){el.innerHTML='<div class="empty">No mechanics found.</div>';return;}
  list.forEach(m=>{
    const row=document.createElement('div');row.className='mech-pick-row';
    const chk=document.createElement('div');chk.className='mech-pick-chk'+(selectedGameMechs.has(m)?' on':'');
    const name=document.createElement('span');name.className='mech-pick-name';name.textContent=m;
    row.append(chk,name);
    row.addEventListener('click',()=>{
      if(selectedGameMechs.has(m))selectedGameMechs.delete(m);else selectedGameMechs.add(m);
      chk.className='mech-pick-chk'+(selectedGameMechs.has(m)?' on':'');
    });
    el.append(row);
  });
}
function openAddGame(){
  gameFormMode='add';editingGameIdx=null;
  selectedGameMechs=new Set();pendingBggData=null;bggDropBlocked=false;hideBggDropdown();
  document.getElementById('addGameTitle').textContent='Add Game';
  document.getElementById('newGameName').value='';newGameNameClear.classList.remove('visible');
  const t=new Date();
  document.getElementById('newGameDate').value=`${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`;
  document.getElementById('gamesMechSearch').value='';document.getElementById('gamesMechSearchClear').classList.remove('visible');
  document.getElementById('newGameComments').value='';
  document.getElementById('addGameNameErr').className='err-msg';
  document.getElementById('btnAddGameSave').disabled=false;
  renderMechPicker('');openSP('spAddGame');
}
function openEditGame(i){
  gameFormMode='edit';editingGameIdx=i;const g=games[i];
  selectedGameMechs=new Set(g.mechanics||[]);pendingBggData=null;bggDropBlocked=true;hideBggDropdown();
  document.getElementById('addGameTitle').textContent='Edit Game';
  document.getElementById('newGameName').value=g.name;newGameNameClear.classList.add('visible');
  document.getElementById('newGameDate').value=g.date||'';
  document.getElementById('gamesMechSearch').value='';document.getElementById('gamesMechSearchClear').classList.remove('visible');
  document.getElementById('newGameComments').value=g.comments||'';
  document.getElementById('addGameNameErr').className='err-msg';
  document.getElementById('btnAddGameSave').disabled=false;
  pendingBggData={thumbnail:g.thumbnail||null,image:g.image||null,year:g.year||null,
    avgRating:g.avgRating||null,avgWeight:g.avgWeight||null,rank:g.rank||null,
    kickstarted:g.kickstarted||false,mechanics:[]};
  renderMechPicker('');openSP('spAddGame');
}
async function saveGameForm(){
  const name=document.getElementById('newGameName').value.trim();
  if(!name){document.getElementById('addGameNameErr').className='err-msg show';return;}
  const date=document.getElementById('newGameDate').value;
  const comments=document.getElementById('newGameComments').value.trim();
  document.getElementById('btnAddGameSave').disabled=true;
  const d=pendingBggData;
  const gameData={name,date,mechanics:[...selectedGameMechs],liked:false,comments:comments||'',
    thumbnail:d?.thumbnail||null,image:d?.image||null,year:d?.year||null,
    avgRating:d?.avgRating||null,avgWeight:d?.avgWeight||null,
    rank:d?.rank||null,kickstarted:d?.kickstarted||false};
  if(gameFormMode==='edit'&&editingGameIdx!==null){
    gameData.liked=games[editingGameIdx].liked;
    games[editingGameIdx]=gameData;
  } else {
    games.push(gameData);
  }
  saveAll();renderGames();updateExp();renderMechs();
  closeSP('spAddGame');document.getElementById('btnAddGameSave').disabled=false;pendingBggData=null;
}

document.getElementById('btnAddGameCancel').addEventListener('click',()=>closeSP('spAddGame'));
document.getElementById('btnAddGameSave').addEventListener('click',saveGameForm);
document.getElementById('newGameName').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();saveGameForm();}});
function renderMechHdr(){
  const el=document.getElementById('mechHdrBtns');el.innerHTML='';
  if(editingMechanics){el.append(mkBtn('Cancel','btn sm',cancelEditMechs),mkBtn('Done','btn sm',doneEditMechs));}
  else{el.append(mkBtn('Edit','btn sm',startEditMechs),mkBtn('Add','btn sm',openAddMech));}
}
function startEditMechs(){mechSnap=clone(mechanics);metaSnap=clone(meta);editingMechanics=true;renamingIdx=null;applyPanelLayout('mechEdit');renderMechHdr();renderMechs();}
function cancelEditMechs(){mechanics=clone(mechSnap);meta=clone(metaSnap);editingMechanics=false;renamingIdx=null;applyPanelLayout('normal');renderMechHdr();renderMechs();updateExp();updateMechCount();saveAll();}
function doneEditMechs(){editingMechanics=false;renamingIdx=null;applyPanelLayout('normal');renderMechHdr();renderMechs();updateExp();updateMechCount();saveAll();}
function renderMechFilter(){
  const el=document.getElementById('mechFilterRow');el.innerHTML='';
  [['all','All'],['played','Played'],['notplayed','Not Played'],['liked','Liked']].forEach(([v,l])=>{
    el.append(mkBtn(l,'btn sm'+(mechFilter===v?' active-filter':''),()=>{mechFilter=v;renderMechs();renderMechFilter();}));
  });
}
function renderMechs(){
  const el=document.getElementById('mechList');el.innerHTML='';
  const search=document.getElementById('mechSearch').value.trim().toLowerCase();
  let list=mechanics.filter(m=>!search||m.toLowerCase().includes(search));
  if(mechFilter==='played')list=list.filter(m=>isTicked(m));
  else if(mechFilter==='notplayed')list=list.filter(m=>!isTicked(m));
  else if(mechFilter==='liked')list=list.filter(m=>getMeta(m).liked);
  if(editingMechanics){
    list.forEach(m=>{
      const idx=mechanics.indexOf(m),isRen=renamingIdx===idx;
      const row=document.createElement('div');row.className='mech-edit-row';
      const chk=document.createElement('div');chk.className='mech-chk'+(isTicked(m)?' on':'');
      chk.addEventListener('click',()=>{
        const mt=getMeta(m);
        if(isTicked(m)){mt.manualUntick=true;mt.manualTick=false;}else{mt.manualTick=true;mt.manualUntick=false;}
        chk.className='mech-chk'+(isTicked(m)?' on':'');updateExp();
      });
      row.append(chk);
      if(isRen){
        const wrap=document.createElement('div');wrap.style.cssText='flex:1;min-width:0;display:flex;flex-direction:column;';
        const inp=document.createElement('input');inp.className='mech-edit-inp';inp.value=m;inp.id='renInp_'+idx;
        const errMsg=document.createElement('div');errMsg.className='rename-err';errMsg.textContent='Mechanic Already Exists';
        wrap.append(inp,errMsg);
        const doneBtn=mkBtn('Done','btn sm',()=>{
          const nv=inp.value.trim();if(!nv||mechExists(nv,idx))return;
          if(nv!==m){const old=mechanics[idx];mechanics[idx]=nv;if(meta[old]){meta[nv]=meta[old];delete meta[old];}games.forEach(g=>{const i=g.mechanics.indexOf(old);if(i!==-1)g.mechanics[i]=nv;});}
          renamingIdx=null;renderMechs();
        });
        const cancelBtn=mkBtn('Cancel','btn sm',()=>{renamingIdx=null;renderMechs();});
        inp.addEventListener('input',()=>{const nv=inp.value.trim();const exists=nv.length>0&&mechExists(nv,idx);errMsg.className='rename-err'+(exists?' show':'');doneBtn.disabled=exists||!nv;});
        inp.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();doneBtn.click();}});
        inp.addEventListener('click',()=>inp.focus());
        row.append(wrap,doneBtn,cancelBtn);inp.focus();
      } else {
        const nm=document.createElement('span');nm.className='mech-edit-name';nm.textContent=m;
        row.append(nm,
          mkBtn('Rename','btn sm blue',()=>{renamingIdx=idx;renderMechs();}),
          mkBtn('Delete','btn sm danger',()=>openDeleteConfirm('Delete Mechanic',`Are you sure you want to delete "${m}"?`,'mech',m,null))
        );
      }
      el.append(row);
    });
  } else {
    const ticked=list.filter(m=>isTicked(m)).sort((a,b)=>a.localeCompare(b));
    const unticked=list.filter(m=>!isTicked(m)).sort((a,b)=>a.localeCompare(b));
    [...ticked,...unticked].forEach(m=>{
      const row=document.createElement('div');row.className='mech-row'+(isTicked(m)?' ticked':'');
      const nameWrap=document.createElement('span');nameWrap.className='mech-row-name';
      if(isTicked(m)){const t=document.createElement('span');t.className='tick-sym';t.textContent='✓';nameWrap.append(t);}
      nameWrap.append(document.createTextNode(m));
      const h=document.createElement('button');h.className='heart'+(getMeta(m).liked?' on':'');h.textContent=getMeta(m).liked?'♥':'♡';
      h.addEventListener('click',e=>{e.stopPropagation();getMeta(m).liked=!getMeta(m).liked;saveAll();renderMechs();});
      row.addEventListener('click',()=>openMechDetail(m));
      row.append(nameWrap,h);el.append(row);
    });
    if(!ticked.length&&!unticked.length)el.innerHTML='<div class="empty">Nothing to show.</div>';
  }
}
document.getElementById('mechSearch').addEventListener('input',e=>{
  renderMechs();document.getElementById('mechSearchClear').classList.toggle('visible',e.target.value.length>0);
});
function openAddMech(){
  document.getElementById('newMechInp').value='';document.getElementById('addMechErr').className='err-msg';
  document.getElementById('btnAddMechSave').disabled=false;openSP('spAddMech');
}
function saveNewMech(){
  const val=document.getElementById('newMechInp').value.trim();if(!val||mechExists(val))return;
  const idx=mechanics.findIndex(m=>m.toLowerCase()>val.toLowerCase());
  if(idx===-1)mechanics.push(val);else mechanics.splice(idx,0,val);
  saveAll();renderMechs();updateExp();updateMechCount();closeSP('spAddMech');
}
document.getElementById('newMechInp').addEventListener('input',()=>{
  const val=document.getElementById('newMechInp').value.trim();const exists=val.length>0&&mechExists(val);
  document.getElementById('addMechErr').className='err-msg'+(exists?' show':'');
  document.getElementById('btnAddMechSave').disabled=exists||!val;
});
document.getElementById('newMechInp').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();saveNewMech();}});
document.getElementById('btnAddMechCancel').addEventListener('click',()=>closeSP('spAddMech'));
document.getElementById('btnAddMechSave').addEventListener('click',saveNewMech);
document.getElementById('detailHeart').addEventListener('click',()=>{if(detailGameId!==null)toggleGameLike(detailGameId);});
document.getElementById('btnDetailBack').addEventListener('click',()=>closeSP('spDetail'));
document.getElementById('btnDownload').addEventListener('click',()=>{
  const wb=XLSX.utils.book_new();
  const gRows=[['Name','Liked','Date Played','Year','BGG Rank','Avg Rating','Weight','Kickstarted','Mechanics','Comments']];
  games.forEach(g=>{
    gRows.push([g.name,g.liked?'Yes':'No',fmtDate(g.date),g.year||'',g.rank?'#'+g.rank:'N/A',
      g.avgRating||'',g.avgWeight?g.avgWeight+'/5':'',g.kickstarted?'Yes':'No',
      (g.mechanics||[]).join(', '),g.comments||'']);
  });
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(gRows),'Games');
  const mRows=[['Name','Liked','Played','Comments']];
  mechanics.forEach(m=>{
    const mt=getMeta(m);
    mRows.push([m,mt.liked?'Yes':'No',isTicked(m)?'Yes':'No',mt.comments||'']);
  });
  XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(mRows),'Mechanics');
  XLSX.writeFile(wb,'designers_exp.xlsx');
});
function generateIcon(){
  const size=180,c=document.createElement('canvas');c.width=size;c.height=size;
  const ctx=c.getContext('2d');const r=24;
  ctx.beginPath();ctx.moveTo(r,0);ctx.lineTo(size-r,0);ctx.arcTo(size,0,size,r,r);ctx.lineTo(size,size-r);ctx.arcTo(size,size,size-r,size,r);ctx.lineTo(r,size);ctx.arcTo(0,size,0,size-r,r);ctx.lineTo(0,r);ctx.arcTo(0,0,r,0,r);ctx.closePath();
  ctx.fillStyle='#1a1a0e';ctx.fill();
  ctx.strokeStyle='rgba(240,232,208,0.25)';ctx.lineWidth=1.2;
  for(let i=0;i<size;i+=10){ctx.beginPath();ctx.moveTo(0,i);ctx.lineTo(size,i+5);ctx.stroke();}
  const fs=size*.65;ctx.font=`bold ${fs}px Cinzel,Georgia,serif`;ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillStyle='rgba(0,0,0,0.3)';ctx.fillText('D',size/2+2,size/2+3);
  ctx.fillStyle='#f0e8d0';ctx.shadowColor='rgba(200,212,32,0.5)';ctx.shadowBlur=12;
  ctx.fillText('D',size/2,size/2);ctx.shadowBlur=0;
  let link=document.querySelector('link[rel="apple-touch-icon"]');
  if(!link){link=document.createElement('link');link.rel='apple-touch-icon';document.head.appendChild(link);}
  link.href=c.toDataURL('image/png');
}
document.fonts.ready.then(generateIcon);
async function init(){
  await openDB();
  const [sm,smeta,sg]=await Promise.all([dbGet('mechanics'),dbGet('meta'),dbGet('games')]);
  meta=smeta||{};games=sg||[];
  if(sm){mechanics=sm;}
  else{try{const resp=await fetch('./mechanics.json');mechanics=await resp.json();}catch(e){mechanics=[];}}
  renderGames();renderGamesHdr();
  renderMechHdr();renderMechFilter();renderMechs();
  updateExp();updateMechCount();setPanelH();
  window.addEventListener('resize',()=>{drawTicks();setPanelH();});
  setTimeout(()=>{drawTicks();applyPanelLayout();},100);
  setTimeout(()=>{
    document.getElementById('app').style.visibility='visible';
    const ls=document.getElementById('loadScreen');ls.classList.add('hide');
    setTimeout(()=>ls.remove(),600);
  },700);
}
init().catch(e=>{console.error(e);document.querySelector('#loadScreen span').textContent='Error loading. Please refresh.';});


                          
