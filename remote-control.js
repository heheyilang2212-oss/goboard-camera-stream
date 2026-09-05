'use strict';
// An observer connection never receives control credentials or private settings.
const controlFields={blackTh:[10,120,'黒の検出強度'],whiteTh:[5,120,'白の検出強度'],histDepth:[3,30,'安定化フレーム数'],targetFps:[2,20,'処理FPS'],dbgOverlay:'認識結果をカメラに表示',autoTurn:'手番を自動で進める',trackMoves:'着手履歴を記録',soundOn:'スマホで着手音',showMoveNum:'スマホで手数を表示'};
const controlActions={turnB:'黒番にする',turnW:'白番にする',btnPass:'パスを記録',btnUndo:'最終手・パスを取消',btnSetInitial:'現在を初手前に設定',btnClearMoves:'履歴クリア',btnRecalib:'認識を再同期'};
let controlCode='',controlClient=false,controlPending=false,controlRequest=0,controlTimer=null;
const controlAttempts=new WeakMap();
function controlSend(conn,data){try{if(conn?.open)conn.send(data);}catch(_){}}
function controlAuthorized(conn){return S.mode==='broadcast'&&S.controlConnection===conn&&!!controlCode;}
function controlState(){
  const values={};for(const key of Object.keys(controlFields))values[key]=S[key];
  return {type:'control-state',values,size:S.size,paused:!!S.controlPaused,orientation:S.orientationConfirmed,side:S.blackSide,cameras:Array.from($('cameraSelect').options,o=>({value:o.value,label:o.textContent})),camera:$('cameraSelect').value};
}
function revokeControl(){
  controlSend(S.controlConnection,{type:'control-revoked'});
  S.controlConnection=null;controlCode='';disarmRemoteCalibration();
  if($('controlCode'))$('controlCode').textContent='PC操作は無効です';
  if($('controlMode'))$('controlMode').value='phone';
}
function enableControl(){
  revokeControl();controlCode=makeRemoteToken().slice(0,12).toUpperCase();
  $('controlMode').value='pc';$('controlCode').textContent='操作コード: '+controlCode+'（観戦者には共有しないでください）';
  if(S.calibrating)cancelCalibration();
  toast('PCで部屋IDと操作コードを入力してください。スマホ操作も引き続き使えます');
}
function handleControlMessage(conn,data){
  if(typeof data.type!=='string'||!data.type.startsWith('control-'))return false;
  if(data.type==='control-claim'){
    const last=controlAttempts.get(conn)||0;if(Date.now()-last<1000)return true;controlAttempts.set(conn,Date.now());
    if(S.mode!=='broadcast'||!controlCode||data.code!==controlCode||(S.controlConnection&&S.controlConnection!==conn&&S.controlConnection.open)){
      controlSend(conn,{type:'control-error',reason:'操作コードを確認してください。別のPCが操作中の場合はスマホで許可を切り替えてください。'});return true;
    }
    S.controlConnection=conn;controlSend(conn,controlState());return true;
  }
  if(!controlAuthorized(conn)){controlSend(conn,{type:'control-revoked'});return true;}
  if(data.type==='control-get'){controlSend(conn,controlState());return true;}
  if(data.type!=='control-command')return true;
  try{
    if(data.action==='setting'){
      const spec=controlFields[data.key];if(!Object.hasOwn(controlFields,data.key))throw Error('未対応の設定です');
      if(Array.isArray(spec)?(!Number.isInteger(data.value)||data.value<spec[0]||data.value>spec[1]):typeof data.value!=='boolean')throw Error('設定値が不正です');
      const el=$(data.key);if(Array.isArray(spec))el.value=data.value;else el.checked=data.value;
      el.dispatchEvent(new Event(Array.isArray(spec)?'input':'change',{bubbles:true}));
    }else if(data.action==='size'){
      if(![9,13,19].includes(data.value))throw Error('盤サイズが不正です');changeSize(data.value);
    }else if(data.action==='pause'){
      if(typeof data.value!=='boolean')throw Error('状態が不正です');
      if(!data.value&&!S.orientationConfirmed)throw Error('先に向きと四隅を設定してください');
      S.controlPaused=data.value;updatePhonePause();
    }else if(data.action==='stone'){
      if(!Number.isInteger(data.x)||!Number.isInteger(data.y)||data.x<0||data.y<0||data.x>=S.size||data.y>=S.size||!['.','B','W'].includes(data.value)||!S.committed)throw Error('交点または石が不正です');
      const {x,y,value}=data;S.committed[x][y]=value;S.prevCommitted[x][y]=value;S.history[x][y]=Array(S.histDepth).fill(value);
      if(S.movesInitialized)S.corrections.push({afterMove:S.moves.length,x,y,value,t:Date.now()});else S.initialPosition=snapshotCommitted();
      S.revision++;saveGame();drawBoardCanvas('boardB');drawOverlay();
    }else if(data.action==='camera'){
      if(!Array.from($('cameraSelect').options).some(o=>o.value===data.value))throw Error('カメラが見つかりません');
      $('cameraSelect').value=data.value;
      startCamera().then(()=>{resizeOverlay();drawOverlay();controlSend(conn,controlState());}).catch(()=>controlSend(conn,{type:'control-error',reason:'カメラ切替に失敗しました。スマホの許可を確認してください'}));
    }else if(Object.hasOwn(controlActions,data.action)){
      $(data.action).click();
    }else throw Error('未対応の操作です');
    broadcastState(true);controlSend(conn,{...controlState(),request:data.request});
  }catch(e){controlSend(conn,{type:'control-error',reason:e.message,request:data.request});}
  return true;
}
function sendControlCommand(action,extra={}){
  if(!controlClient||!S.conn?.open||controlPending)return;
  controlPending=true;const request=++controlRequest;
  $('controlStatus').textContent='スマホへ反映中…';
  controlSend(S.conn,{type:'control-command',action,...extra,request});
  clearTimeout(controlTimer);controlTimer=setTimeout(()=>{controlPending=false;$('controlStatus').textContent='応答を確認できません。状態を再取得してから操作してください';},7000);
}
function receiveControlMessage(data){
  if(!data||typeof data.type!=='string'||!data.type.startsWith('control-'))return false;
  if(!controlPending||data.request===controlRequest||data.type!=='control-state'){clearTimeout(controlTimer);controlPending=false;}
  if(data.type==='control-state'){
    controlClient=true;$('controlTools').hidden=false;
    $('controlStatus').textContent=data.paused?'認識を一時停止中（観戦接続は維持）':'PCから操作できます';
    for(const [key,spec]of Object.entries(controlFields)){const el=$('pc-'+key);if(document.activeElement===el)continue;if(Array.isArray(spec))el.value=data.values[key];else el.checked=data.values[key];}
    $('pc-size').value=data.size;$('pc-pause').textContent=data.paused?'認識を再開':'認識を一時停止';$('pc-pause').dataset.paused=String(data.paused);
    const camera=$('pc-camera');if(document.activeElement!==camera){camera.replaceChildren();for(const item of data.cameras){const o=document.createElement('option');o.value=item.value;o.textContent=item.label;camera.append(o);}camera.value=data.camera;}
  }else if(data.type==='control-revoked'){
    controlClient=false;$('controlTools').hidden=true;$('controlStatus').textContent='PC操作の許可がありません。観戦は継続できます';
  }else if(data.type==='control-error')$('controlStatus').textContent=data.reason;
  return true;
}
function updatePhonePause(){if($('phonePause'))$('phonePause').textContent=S.controlPaused?'認識を再開':'認識を一時停止';}
document.addEventListener('DOMContentLoaded',()=>{
  const style=document.createElement('style');style.textContent=`
    .controlPanel{padding:12px;border:1px solid #536457;border-radius:8px;display:grid;gap:10px;width:100%;box-sizing:border-box;font-size:14px}
    .controlPanel button,.controlPanel select,.controlPanel input{min-height:42px;font:inherit;max-width:100%;padding:6px}
    .controlPanel button{background:#263b2c;color:#fff;border:1px solid #758579;border-radius:6px;cursor:pointer}
    .controlPanel label{display:flex;align-items:center;justify-content:space-between;gap:8px}
    .controlPanel input[type=number]{width:85px}.controlGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}
    #controlTools[hidden]{display:none}#controlTools{display:grid;gap:12px}#controlCode{overflow-wrap:anywhere}
    .vMain{overflow-y:auto;justify-content:flex-start;min-height:0}.vBoardWrap{flex-shrink:0;max-width:65vh}
    #pcPanel{max-width:850px;flex-shrink:0}.controlPanel small{line-height:1.6}
  `;document.head.append(style);
  const host=document.createElement('div');host.className='controlPanel';host.style.gridColumn='1 / -1';
  host.innerHTML='<label>操作方法<select id="controlMode"><option value="phone">スマホで操作</option><option value="pc">PC操作も許可</option></select></label><strong id="controlCode">PC操作は無効です</strong><small>撮影はスマホで継続します。PC操作を許可してもスマホの機能は残ります。スマホをスリープさせず、このページを開いておいてください。</small><button id="phonePause">認識を一時停止</button>';
  document.querySelector('.bMain').prepend(host);
  $('controlMode').onchange=()=>{$('controlMode').value==='pc'?enableControl():revokeControl();};
  $('phonePause').onclick=()=>{S.controlPaused=!S.controlPaused;updatePhonePause();controlSend(S.controlConnection,controlState());};
  $('bExit').addEventListener('click',revokeControl);$('newId').addEventListener('click',revokeControl);
  const panel=document.createElement('details');panel.id='pcPanel';panel.className='controlPanel';
  panel.innerHTML='<summary>PCから操作する（観戦のみなら不要）</summary><label>操作コード<input id="pc-code" autocomplete="off" maxlength="12" placeholder="スマホに表示されたコード"></label><button id="pc-connect">操作を接続／状態を再取得</button><div id="controlStatus" role="status">スマホで「PC操作も許可」を選んでください</div><div id="controlTools" hidden><div class="controlGrid" id="pcSettings"></div><div class="controlGrid" id="pcActions"></div><small>四隅は静止画で調整します。動画の常時送信はしません。PNG・SGFの保存先はこのPCです。</small></div>';
  document.querySelector('.vMain').append(panel);
  function button(id,text,fn){const b=document.createElement('button');b.id=id;b.textContent=text;b.onclick=fn;return b;}
  $('pc-connect').onclick=()=>{if(!S.conn?.open){$('controlStatus').textContent='先に部屋へ接続してください';return;}controlSend(S.conn,{type:'control-claim',code:$('pc-code').value.trim().toUpperCase()});$('controlStatus').textContent='操作権限を確認中…';};
  for(const [key,spec]of Object.entries(controlFields)){
    const label=document.createElement('label');label.textContent=Array.isArray(spec)?spec[2]:spec;
    const input=document.createElement('input');input.id='pc-'+key;input.type=Array.isArray(spec)?'number':'checkbox';
    if(Array.isArray(spec)){input.min=spec[0];input.max=spec[1];input.step=1;}
    input.onchange=()=>{if(key==='trackMoves'&&input.checked&&!confirm('現在の盤面を初期局面として履歴記録を再開しますか？')){input.checked=false;return;}sendControlCommand('setting',{key,value:Array.isArray(spec)?Number(input.value):input.checked});};label.append(input);$('pcSettings').append(label);
  }
  for(const [id,title]of [['size','盤サイズ'],['camera','スマホのカメラ']]){
    const label=document.createElement('label');label.textContent=title;const select=document.createElement('select');select.id='pc-'+id;
    if(id==='size')for(const n of [9,13,19]){const o=document.createElement('option');o.value=n;o.textContent=n+'路';select.append(o);}
    select.onchange=()=>{if(id==='size'&&!confirm('盤サイズを変えると現在の棋譜が初期化されます。変更しますか？')){controlSend(S.conn,{type:'control-get'});return;}sendControlCommand(id,{value:id==='size'?Number(select.value):select.value});};label.append(select);$('pcSettings').append(label);
  }
  $('pcActions').append(button('pc-snapshot','静止画で向き・四隅を設定',()=>controlSend(S.conn,{type:'calib-request'})),button('pc-pause','認識を一時停止',()=>sendControlCommand('pause',{value:$('pc-pause').dataset.paused!=='true'})));
  for(const [id,title]of Object.entries(controlActions))$('pcActions').append(button('pc-'+id,title,()=>{if(['btnSetInitial','btnClearMoves','btnUndo'].includes(id)&&!confirm(title+'を実行しますか？'))return;sendControlCommand(id);}));
  $('pcActions').append(button('pc-sgf','SGFをPCに保存',()=>$('vSgfBtn').click()),button('pc-png','盤面をPCにPNG保存',()=>{$('boardV').toBlob(blob=>{if(!blob)return;const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='goboard.png';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);});}));
  const edit=document.createElement('label');edit.innerHTML='盤面タップで石を修正<select id="pc-stone"><option value="off">修正しない</option><option value="B">黒石を置く</option><option value="W">白石を置く</option><option value=".">石を消す</option></select>';$('controlTools').append(edit);
  $('boardV').addEventListener('click',e=>{if(!controlClient||$('pc-stone').value==='off'||!S.vLatestState)return;const c=$('boardV'),r=c.getBoundingClientRect(),n=S.vLatestState.size;const x=Math.round(((e.clientX-r.left)/r.width-.04)/.92*(n-1)),y=Math.round(((e.clientY-r.top)/r.height-.04)/.92*(n-1));sendControlCommand('stone',{x,y,value:$('pc-stone').value});});
  const join=document.createElement('button');join.className='modeBtn';join.textContent='PCから操作する';$('btnView').after(join);
  join.onclick=()=>{const id=normalizeRoomId($('joinId').value);if(!id){$('joinId').focus();toast('部屋IDを入力してください',true);return;}enterView(id);panel.open=true;};
  $('vExit').addEventListener('click',()=>{controlClient=false;controlPending=false;clearTimeout(controlTimer);$('controlTools').hidden=true;$('pc-code').value='';});
  // Reflect local phone changes and detect a dropped connection without sending images.
  setInterval(()=>{
    if(S.mode==='broadcast'&&S.controlConnection?.open)controlSend(S.controlConnection,controlState());
    if(S.mode==='view'&&controlClient&&!S.conn?.open){controlClient=false;controlPending=false;$('controlTools').hidden=true;$('controlStatus').textContent='接続が切れました。再接続後に操作を接続してください';}
  },2500);
});
