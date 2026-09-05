// Run with: node tests/regression.cjs (no third-party dependencies).
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
function harness(){
  const elements=new Map(),timers=new Map();let nextTimer=0;
  const element=id=>{
    if(!elements.has(id))elements.set(id,{textContent:'',value:'',style:{},classList:{add(){},remove(){},toggle(){},contains(){return false}},getBoundingClientRect:()=>({width:500,height:500}),scrollTo(){}});
    return elements.get(id);
  };
  class Conn {constructor(){this.handlers={};this.open=true;}on(e,f){this.handlers[e]=f;}emit(e,...args){this.handlers[e]?.(...args);}close(){this.open=false;this.emit('close');}}
  class Peer {static created=0;constructor(){Peer.created++;this.handlers={};this.connections=[];}on(e,f){this.handlers[e]=f;}emit(e,...a){this.handlers[e]?.(...a);}connect(){const c=new Conn();this.connections.push(c);return c;}destroy(){this.connections.forEach(c=>c.close());}}
  const ctx={assert,console,Peer,timers,element,setTimeout(fn,ms){const id=++nextTimer;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},window:{addEventListener(){},devicePixelRatio:1},document:{addEventListener(){},getElementById:element,querySelectorAll:()=>[],querySelector:()=>null},navigator:{},localStorage:{getItem:()=>null,setItem(){}},performance};
  vm.createContext(ctx);vm.runInContext(source,ctx);
  const run=code=>vm.runInContext(code,ctx);
  run(`toast=()=>{};drawOverlay=()=>{};drawBoardCanvas=()=>{};resizeOverlay=()=>{};playStoneClick=()=>{};updateTurnUI=()=>{};`);
  return {run,ctx};
}
async function main(){
  {
    const {run,ctx}=harness();
    vm.runInContext(fs.readFileSync(path.join(__dirname,'../remote-control.js'),'utf8'),ctx);
    run(`S.mode='broadcast';S.size=9;initDetectionState();element('cameraSelect').options=[];
      const messages=[];const owner={open:true,send:d=>messages.push(d)},observer={open:true,send:d=>messages.push(d)};
      controlCode='ABCDEF123456';
      handleControlMessage(observer,{type:'control-command',action:'pause',value:true});assert.equal(S.controlPaused,undefined);
      handleControlMessage(owner,{type:'control-claim',code:controlCode});assert.equal(S.controlConnection,owner);
      handleControlMessage(owner,{type:'control-command',action:'pause',value:true});assert.equal(S.controlPaused,true);
      handleControlMessage(observer,{type:'control-command',action:'pause',value:false});assert.equal(S.controlPaused,true);
      const old=S.blackTh;handleControlMessage(owner,{type:'control-command',action:'setting',key:'blackTh',value:999});assert.equal(S.blackTh,old);
      handleControlMessage(owner,{type:'control-command',action:'size',value:17});assert.equal(S.size,9);
      handleControlMessage(owner,{type:'control-command',action:'stone',x:2,y:3,value:'W'});assert.equal(S.committed[2][3],'W');
      S.remoteCalibUntil=0;S.remoteCalibTokens.set(owner,'a'.repeat(32));
      handleHostPeerMessage(owner,{type:'calib-apply',token:'a'.repeat(32),side:'bottom',corners:defaultCorners()});
      assert.equal(S.controlConnection,owner);assert.equal(S.orientationConfirmed,true);
      revokeControl();handleControlMessage(owner,{type:'control-command',action:'pause',value:false});assert.equal(S.controlPaused,true);
      assert.equal(controlState().code,undefined);assert.equal(controlState().image,undefined);`);
    console.log('PASS: PC authorization, observer isolation, revocation, validation and stone correction');
  }
  {
    const {run}=harness();
    run(`S.size=9;initDetectionState();S.committed[2][3]='B';S.prevCommitted=cloneBoard(S.committed);S.moves=[{c:'B',x:2,y:3},{c:'W',pass:true}];S.initialPosition=cloneBoard(S.committed);S.movesInitialized=true;S.undoStack=[{board:cloneBoard(S.committed),movesLength:0}];S.corrections=[{afterMove:1,x:2,y:3,value:'B'}];
      const original=JSON.stringify([S.committed,S.moves,S.initialPosition,S.undoStack,S.corrections]);
      for(const side of ['left','top','right']){reorientGame('bottom',side);reorientGame(side,'bottom');assert.equal(JSON.stringify([S.committed,S.moves,S.initialPosition,S.undoStack,S.corrections]),original);}
      S.mode='broadcast';S.blackSide='bottom';const conn={send(){}};S.remoteCalibUntil=Date.now()+50000;S.remoteCalibTokens.set(conn,'a'.repeat(32));
      handleHostPeerMessage(conn,{type:'calib-apply',token:'a'.repeat(32),side:'bottom',corners:defaultCorners()});
      assert.equal(JSON.stringify([S.committed,S.moves,S.initialPosition,S.undoStack,S.corrections]),original);
      S.calibrating=true;S.orientationConfirmed=true;S.calibrationStage='corners';S.calibrationOriginalSide='bottom';S.calibrationDraft=defaultCorners();finishCalibration();
      assert.equal(JSON.stringify([S.committed,S.moves,S.initialPosition,S.undoStack,S.corrections]),original);`);
    console.log('PASS: calibration preserves moves, corrections and undo; orientation round-trips');
  }
  {
    const {run}=harness();
    run(`S.mode='view';startPeerViewer('ABC234');S.peer.emit('open');S.conn.emit('open');
      const old=S.conn;scheduleReconnect('ABC234');const id=S.reconnectTimer;const t=timers.get(id);timers.delete(id);t.fn();S.peer.emit('open');S.conn.emit('open');
      assert.equal(timers.size,0);assert.equal(Peer.created,2);old.emit('close');assert.equal(timers.size,0);`);
    console.log('PASS: reconnect succeeds without obsolete connections scheduling further retries');
  }
  {
    const {run}=harness();
    await run(`(async()=>{S.mode='broadcast';S.orientationConfirmed=true;let hosts=0,loops=0;startCamera=async()=>{};startPeerHost=()=>hosts++;startProcessingLoop=()=>loops++;await retryCamera();assert.equal(hosts,1);assert.equal(loops,1);})()`);
    console.log('PASS: camera retry also starts broadcasting');
  }
  {
    const {run}=harness();
    run(`checkSecure=()=>true;requestWakeLock=()=>{};releaseWakeLock=()=>{};listCameras=async()=>{};let resolveCamera,hosts=0,loops=0;startCamera=()=>new Promise(r=>resolveCamera=r);startPeerHost=()=>hosts++;startProcessingLoop=()=>loops++;`);
    const pending=run('enterBroadcast()');await Promise.resolve();await Promise.resolve();
    run('exitBroadcast();resolveCamera()');await pending;
    run(`assert.equal(S.mode,'select');assert.equal(hosts,0);assert.equal(loops,0);`);
    console.log('PASS: leaving during startup does not launch background broadcasting');
  }
  {
    const {run,ctx}=harness();let resolveMedia,stopped=0;
    ctx.navigator.mediaDevices={getUserMedia:()=>new Promise(r=>resolveMedia=r)};
    const pending=run('startCamera()');run('stopCamera()');resolveMedia({getTracks:()=>[{stop(){stopped++;}}]});
    await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(stopped,1);run(`assert.equal(S.stream,null)`);
    console.log('PASS: camera stream returned after cancellation is stopped');
  }
  {
    const {run}=harness();
    run(`S.size=9;initDetectionState();S.movesInitialized=true;S.initialPosition=cloneBoard(S.committed);S.turn='W';S.committed[0][0]='W';S.committed[1][1]='B';trackMoves();assert.equal(S.moves.map(m=>m.c).join(''),'WB');assert.equal(S.turn,'W');
      S.moves=[];S.corrections=[];initDetectionState();S.initialPosition=cloneBoard(S.committed);S.initialPosition[4][4]='B';S.prevCommitted[4][4]='B';S.committed[4][4]='W';S.turn='W';trackMoves();
      assert.equal(S.moves.length,0);assert.equal(S.turn,'W');assert.equal(S.corrections.length,1);assert.equal(S.corrections[0].value,'W');
      const sgf=buildSGFFrom(9,S.initialPosition,S.committed,S.moves,S.turn,S.corrections);assert(sgf.includes('AW[ee]'));assert(!sgf.includes(';W[ee]'));trackMoves();assert.equal(S.corrections.length,1);`);
    console.log('PASS: observed color changes are corrections, and White-first sequences retain order');
  }
  {
    const {run,ctx}=harness();
    ctx.draws=[];ctx.paint=new Proxy({drawImage(...a){ctx.draws.push(a)}},{get:(o,k)=>k in o?o[k]:()=>{}});
    run(`S.videoEl={videoWidth:1920,videoHeight:1080};S.calibrationDraft=[{x:.02,y:.02}];drawCalibrationMagnifier(paint,{width:750,height:562},{x:15,y:11});`);
    const a=ctx.draws[0],size=220,cx=750-size*.66,cy=562/2;
    assert(Math.abs((a[1]+(cx-a[5])*a[3]/a[7])-38.4)<1e-9);
    assert(Math.abs((a[2]+(cy-a[6])*a[4]/a[8])-21.6)<1e-9);
    console.log('PASS: magnifier crosshair stays on selected corner at the image boundary');
  }
  {
    const {run,ctx}=harness();
    // Rasterize equal board-coordinate stones through a trapezoidal projection.
    run(`S.size=19;S.corners=[{x:.37,y:.1},{x:.63,y:.1},{x:.92,y:.9},{x:.08,y:.9}];S.blackSide='bottom';S.orientationConfirmed=true;S.histDepth=3;S.trackMoves=false;S.videoEl={videoWidth:640,videoHeight:480};S.procCanvas={width:640,height:480};`);
    for(const row of [2,9,16]){
      const poly=run(`(()=>{const h=makeHomography(S.corners.map(p=>({x:p.x*640,y:p.y*480})));return Array.from({length:80},(_,k)=>{const a=k*Math.PI/40;return h(.5+.45/18*Math.cos(a),${row}/18+.45/18*Math.sin(a));});})()`);
      for(const stone of ['B','W']){
        const pixels=new Uint8ClampedArray(640*480*4);
        for(let y=0;y<480;y++)for(let x=0;x<640;x++){
          let inside=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){
            const a=poly[i],b=poly[j];if((a.y>y)!==(b.y>y)&&x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x)inside=!inside;
          }
          pixels.set(inside?(stone==='B'?[20,20,20,255]:[240,240,240,255]):[185,145,100,255],(y*640+x)*4);
        }
        ctx.pixels=pixels;run(`initDetectionState();S.procCtx={drawImage(){},getImageData(){return {data:pixels}}};for(let f=0;f<4;f++)detectFrame();assert.equal(S.committed[9][${row}],'${stone}');`);
      }
    }
    console.log('PASS: black and white stones detected at near, middle and far perspective positions');
  }
}
main().catch(e=>{console.error(e);process.exitCode=1});
