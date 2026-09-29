import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { CATALOG, definition, tankCapacity, compile, freshCraft, demoCraft, addPart, removeSubtree, freeNodes, summary,
  exportCraft, importCraft, fuelSources, type Craft, type PlacedPart } from './model';
import { AssemblyFlight, STEP_SECONDS } from './runtime';
import './style.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Assembly lab requires #app');
app.innerHTML = `
<header><div class="brand"><span class="mark">V</span><div><strong>VOID</strong><span>ASSEMBLY LAB / 01</span></div></div>
<input id="craft-name" aria-label="飛行器名稱" spellcheck="false"><div class="toolbar"><button id="new">新建</button><button id="demo">兩級範例</button><button id="import">匯入</button><button id="export">匯出 JSON</button><button id="launch" class="primary">試飛 ↗</button></div></header>
<main><aside class="palette"><div class="eyebrow">PART LIBRARY</div><h1>從一個接點開始。</h1><p class="muted">選零件，再點火箭上的綠色接點。</p>
<div id="catalog"></div><div id="attachment" class="attachment" hidden><span>新零件的接點</span><select id="child-node"></select><button id="cancel">取消</button></div>
<div class="library-note"><span class="dot"></span>堆疊接合 · 1.25 m 規格<br>接點決定位置與方向，燃料隨連接供應。</div></aside>
<section id="viewport"><div class="view-top"><span id="mode" class="mode">組裝</span><span id="count"></span><button id="fit">置中</button><button id="com" class="active">重心</button></div>
<div class="view-bottom"><span id="hint"></span><span>左鍵選取 · 拖曳旋轉 · 右鍵平移 · 滾輪縮放</span></div><div id="notice" role="status" hidden></div>
<div id="flight-controls" hidden><div><span class="eyebrow">THROTTLE</span><b id="throttle-text">100%</b></div><input id="throttle" type="range" min="0" max="100" step="0.1" value="100" aria-label="節流閥"><button id="stage" class="primary">Space · 下一級</button><button id="pause">暫停</button><button id="return">回到組裝</button></div></section>
<aside class="details"><section><div class="eyebrow">VESSEL</div><div id="stats"></div></section><section><div class="section-head"><span class="eyebrow">SELECTED PART</span><span id="selected-id"></span></div><div id="inspector"></div></section>
<section class="stage-section"><div class="section-head"><span class="eyebrow">STAGING</span><span>0 → 1 → 2</span></div><p class="muted small">同一級一起執行；分離先於點火。</p><div id="stages"></div></section></aside></main>
<input id="file" type="file" accept=".json,application/json" hidden>`;

function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = app!.querySelector<T>(selector); if (!found) throw new Error(`Missing ${selector}`); return found;
}
const viewport = element('#viewport'), inspector = element('#inspector'), stats = element('#stats');
const craftName = element<HTMLInputElement>('#craft-name');
const throttleInput = element<HTMLInputElement>('#throttle');
const childInput = element<HTMLSelectElement>('#child-node');
let craft: Craft = demoCraft(), compiled = compile(craft), selected = compiled.rootId;
let pending: string | null = null, flight: AssemblyFlight | null = null, paused = false, stopped = false;
let showCom = true;
function notify(message: string, error = false): void {
  const notice = element('#notice'); notice.textContent = message; notice.classList.toggle('error',error); notice.hidden = false;
}
function action(fn: () => void): void { try { fn(); } catch (e) { notify(e instanceof Error ? e.message : String(e),true); } }
function panic(error: unknown): never {
  stopped = true;
  const failure = error instanceof Error ? error : new Error(String(error));
  const box = document.createElement('pre'); box.className = 'panic'; box.textContent = `ASSEMBLY LAB PANIC\n${failure.stack}`; document.body.append(box); throw failure;
}
window.addEventListener('error', e => { if (!stopped) panic(e.error ?? e.message); });
window.addEventListener('unhandledrejection', e => { if (!stopped) panic(e.reason); });

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
renderer.setClearColor(0x121b24); renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;
viewport.prepend(renderer.domElement);
const scene = new THREE.Scene(); scene.fog = new THREE.FogExp2(0x121b24,0.006);
scene.add(new THREE.HemisphereLight(0xdcebf5,0x252e31,2));
const sun = new THREE.DirectionalLight(0xffead1,3); sun.position.set(6,12,8); scene.add(sun);
const rim = new THREE.DirectionalLight(0x93d9ef,2); rim.position.set(-6,4,-5); scene.add(rim);
const floor = new THREE.Mesh(new THREE.PlaneGeometry(2000,2000), new THREE.MeshStandardMaterial({ color: 0x192731, roughness: 1 }));
floor.rotation.x = -Math.PI/2; floor.position.y = -0.012; scene.add(floor);
const grid = new THREE.GridHelper(200,100,0x446070,0x273b48); scene.add(grid);
const pad = new THREE.Mesh(new THREE.RingGeometry(2.5,2.54,64),new THREE.MeshBasicMaterial({ color: 0xd7aa58, side: THREE.DoubleSide }));
pad.rotation.x = -Math.PI/2; pad.position.y = 0.015; scene.add(pad);
const camera = new THREE.PerspectiveCamera(40,1,0.05,100000);
camera.position.set(12,8,18);
const controls = new OrbitControls(camera,renderer.domElement); controls.enableDamping = true; controls.minDistance = 1.5; controls.maxDistance = 2000;
const parts = new THREE.Group(), nodes = new THREE.Group(); scene.add(parts,nodes);
const marker = new THREE.Group();
const centerBall = new THREE.Mesh(new THREE.SphereGeometry(0.13,16,8),new THREE.MeshBasicMaterial({ color: 0xe7bc67, depthTest: false }));
centerBall.renderOrder = 100; marker.add(centerBall);
const axes = new THREE.AxesHelper(0.7); axes.renderOrder = 100; marker.add(axes); scene.add(marker);
const meshes = new Map<string,THREE.Group>();
let editorOffset = 0;
const raycaster = new THREE.Raycaster(); const pointer = new THREE.Vector2();
const categories: Record<string,string> = { command:'控制', tank:'燃料', engine:'推進', decoupler:'結構' };

function partMesh(p: PlacedPart): THREE.Group {
  const d = p.definition, group = new THREE.Group(); group.userData.partId = p.id;
  const material = new THREE.MeshStandardMaterial({ color: d.color, metalness: 0.35, roughness: 0.48 });
  const geometry = d.shape === 'cone' ? new THREE.ConeGeometry(d.radius,d.height,32) : new THREE.CylinderGeometry(d.radius,d.radius,d.category === 'engine' ? d.height*0.45 : d.height,32);
  const hull = new THREE.Mesh(geometry,material); if (d.category === 'engine') hull.position.y = d.height*0.275; group.add(hull);
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(geometry,25),new THREE.LineBasicMaterial({ color: 0x91d9c3, transparent: true, opacity: 0.8 }));
  edge.position.copy(hull.position); edge.name = 'selection'; edge.scale.setScalar(1.008); edge.visible = false; group.add(edge);
  if (d.category === 'tank') {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(d.radius+0.006,d.radius+0.006,0.11,32),new THREE.MeshStandardMaterial({ color: 0x566574, metalness: 0.4, roughness: 0.55 }));
    band.position.y = d.height*0.28; group.add(band); const other = band.clone(); other.position.y *= -1; group.add(other);
  }
  if (d.category === 'command') {
    const window = new THREE.Mesh(new THREE.BoxGeometry(0.34,0.24,0.055),new THREE.MeshStandardMaterial({ color: 0x153f57, metalness: 0.6, roughness: 0.15 }));
    window.position.set(0,0.05,0.32); group.add(window);
  }
  if (d.category === 'engine') {
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(d.radius*0.42,d.radius*0.72,d.height*0.5,32),new THREE.MeshStandardMaterial({ color: 0x202b33, metalness: 0.8, roughness: 0.35 }));
    nozzle.position.y = -d.height*0.2; group.add(nozzle);
    const flame = new THREE.Mesh(new THREE.ConeGeometry(d.radius*0.35,2.1,20),new THREE.MeshBasicMaterial({ color: 0xffb44e, transparent: true, opacity: 0.65, depthWrite: false }));
    flame.rotation.z = Math.PI; flame.position.y = -d.height/2-1; flame.name = 'flame'; flame.visible = false; group.add(flame);
  }
  return group;
}
function clear(group: THREE.Group): void {
  for (const child of [...group.children]) {
    child.traverse(object => {
      if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
        object.geometry.dispose(); const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.dispose();
      }
    }); group.remove(child);
  }
}
function rebuild(): void {
  compiled = compile(craft); clear(parts); clear(nodes); meshes.clear();
  editorOffset = -Math.min(...compiled.parts.map(p => p.pose.position.y-p.definition.height/2))+0.04;
  for (const p of compiled.parts) {
    const mesh = partMesh(p); meshes.set(p.id,mesh); parts.add(mesh);
    mesh.position.set(p.pose.position.x,p.pose.position.y+editorOffset,p.pose.position.z);
    mesh.quaternion.set(p.pose.rotation.x,p.pose.rotation.y,p.pose.rotation.z,p.pose.rotation.w);
  }
  if (!compiled.parts.some(p => p.id === selected)) selected = compiled.rootId;
  rebuildNodes(); updatePanels();
}
function rebuildNodes(): void {
  clear(nodes);
  if (flight || !pending) return;
  for (const free of freeNodes(compiled)) {
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.14,16,8),new THREE.MeshBasicMaterial({ color: 0x91d9c3, depthTest: false }));
    sphere.position.set(free.pose.position.x,free.pose.position.y+editorOffset,free.pose.position.z);
    sphere.userData = { parentId: free.partId, nodeId: free.node.id }; sphere.renderOrder = 101; nodes.add(sphere);
  }
}
function fit(): void {
  const bounds = new THREE.Box3().setFromObject(parts), center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
  const distance = Math.max(4,size.length()*1.5); controls.target.copy(center); camera.position.copy(center).add(new THREE.Vector3(distance*0.65,distance*0.25,distance)); controls.update();
}
function setCraft(next: Craft): void { compile(next); craft = next; pending = null; rebuild(); fit(); }
function choosePart(id: string): void {
  if (flight) return;
  pending = id; const d = definition(id); childInput.innerHTML = d.nodes.map(n => `<option value="${n.id}">${n.id} · ${n.direction.y > 0 ? '上方' : '下方'}</option>`).join('');
  rebuildNodes(); updatePanels(); element('#notice').hidden = true;
}
function updatePanels(): void {
  craftName.value = craft.name; craftName.disabled = flight !== null;
  element('#mode').textContent = flight ? '試飛 / LOCAL RANGE' : '組裝';
  element('#count').textContent = `${compiled.parts.length} PARTS`;
  const info = summary(compiled,flight?.fuel), controlled = flight?.controlledBody;
  stats.innerHTML = `<div class="metric"><span>總質量</span><strong>${(info.massKg/1000).toFixed(2)}<small> t</small></strong></div><div class="metrics"><div><span>乾質量</span><b>${info.dryMassKg.toFixed(0)} kg</b></div><div><span>燃料</span><b>${info.fuelKg.toFixed(0)} kg</b></div></div>${flight ? `<div class="metrics"><div><span>根零件高度</span><b>${flight.partPose(compiled.rootId).position.y.toFixed(1)} m</b></div><div><span>垂直速度</span><b>${controlled!.linvel().y.toFixed(1)} m/s</b></div></div><p class="small muted">T+ ${flight.time.toFixed(1)} s · ${flight.groups.length} 個獨立物理群</p>` : '<p class="small muted">重心由目前零件與燃料計算。</p>'}`;
  element('#catalog').innerHTML = CATALOG.map(d => `<button class="part-card ${pending===d.id?'chosen':''}" data-part="${d.id}" ${flight?'disabled':''}><span class="part-icon ${d.category}"></span><span><small>${categories[d.category]}</small><strong>${d.name}</strong><span>${d.description}</span></span><b>＋</b></button>`).join('');
  element('#catalog').querySelectorAll<HTMLButtonElement>('[data-part]').forEach(button => button.addEventListener('click',() => choosePart(button.dataset.part!)));
  element('#attachment').hidden = pending === null || flight !== null;
  element('#hint').textContent = flight ? 'Space 分級 · Shift/Ctrl 節流 · X 熄火 · WASDQE 轉向' : pending ? `${definition(pending).name} → 點綠色接點接合` : '選一個零件，或從左側挑選新零件。';
  element('#flight-controls').hidden = !flight;
  for (const id of ['#new','#demo','#import','#launch']) element<HTMLButtonElement>(id).disabled = flight !== null;
  const p = compiled.parts.find(p => p.id === selected)!;
  for (const [id,mesh] of meshes) mesh.getObjectByName('selection')!.visible = id===selected;
  element('#selected-id').textContent = p.id;
  const fuel = flight ? flight.fuel.get(p.id)! : p.fuelKg, capacity = tankCapacity(p.definition);
  inspector.innerHTML = `<h2>${p.definition.name}</h2><p class="muted small">${p.definition.description}</p><div class="detail-line"><span>乾質量</span><b>${p.definition.dryMassKg} kg</b></div><div class="detail-line"><span>連接</span><b>${p.attachment ? `${p.attachment.parentId} / ${p.attachment.parentNodeId}` : '根零件'}</b></div>${capacity ? `<label class="field">燃料 <span>${fuel.toFixed(0)} / ${capacity} kg</span><input id="fuel" type="range" min="0" max="${capacity}" value="${fuel}" ${flight?'disabled':''}></label>` : ''}${p.definition.modules.some(m => m.kind==='engine'||m.kind==='decoupler') ? `<label class="field">執行級數<input id="stage-number" type="number" min="0" max="99" placeholder="未分級" value="${p.stage===null?'':p.stage}" ${flight?'disabled':''}></label>` : ''}<button id="remove" class="danger" ${flight||p.id===compiled.rootId?'disabled':''}>拆除這個零件與子樹</button>`;
  inspector.querySelector<HTMLInputElement>('#fuel')?.addEventListener('change', e => action(() => {
    const next = structuredClone(craft); next.parts.find(part => part.id===selected)!.fuelKg = Number((e.target as HTMLInputElement).value); compile(next); craft=next; compiled=compile(craft); updatePanels();
  }));
  inspector.querySelector<HTMLInputElement>('#stage-number')?.addEventListener('change', e => action(() => {
    const value = (e.target as HTMLInputElement).value, next = structuredClone(craft); next.parts.find(part=>part.id===selected)!.stage = value==='' ? null : Number(value); compile(next); craft=next; compiled=compile(craft); updatePanels();
  }));
  element('#remove').addEventListener('click',() => action(() => { craft=removeSubtree(craft,selected); pending=null; rebuild(); }));
  const numbers = [...new Set(compiled.parts.flatMap(p => p.stage===null?[]:[p.stage]))].sort((a,b)=>a-b);
  element('#stages').innerHTML = numbers.length ? numbers.map(n => `<div class="stage-card ${flight&&flight.stages[flight.nextStage]===n?'next':''} ${flight&&flight.stages.indexOf(n)<flight.nextStage?'done':''}"><span class="stage-number">${String(n).padStart(2,'0')}</span><div>${compiled.parts.filter(p=>p.stage===n).map(p=>`<button data-select="${p.id}">${p.definition.category==='engine'?'↟':'↔'} ${p.definition.name}<small>${p.id}</small></button>`).join('')}</div></div>`).join('') : '<p class="muted small">新增引擎或分離器後，指定執行級數。</p>';
  element('#stages').querySelectorAll<HTMLButtonElement>('[data-select]').forEach(button => button.addEventListener('click',() => { selected=button.dataset.select!; updatePanels(); }));
  for (const engine of compiled.parts.filter(p=>p.definition.category==='engine')) {
    const sources = fuelSources(compiled,engine.id,flight?.cuts ?? new Set());
    const sourceFuel = sources.reduce((sum,id)=>sum+(flight?.fuel.get(id) ?? compiled.parts.find(p=>p.id===id)!.fuelKg),0);
    if (!flight && !pending && sourceFuel===0) element('#hint').textContent = `${engine.id} 尚無可用燃料；檢查燃料箱與跨接。`;
  }
}

element('#new').addEventListener('click',()=>action(()=>setCraft(freshCraft())));
element('#demo').addEventListener('click',()=>action(()=>setCraft(demoCraft())));
element('#cancel').addEventListener('click',()=>{pending=null; rebuildNodes(); updatePanels();});
element('#fit').addEventListener('click',fit);
element('#com').addEventListener('click',()=>{showCom=!showCom; element('#com').classList.toggle('active',showCom);});
craftName.addEventListener('change',()=>action(()=>{const next={...craft,name:craftName.value}; compile(next); craft=next;}));
element('#export').addEventListener('click',()=>action(()=>{
  const blob=new Blob([exportCraft(craft)],{type:'application/json'}), url=URL.createObjectURL(blob), link=document.createElement('a'); link.href=url; link.download='void-craft.json'; link.click(); URL.revokeObjectURL(url); notify('組裝資料已匯出。');
}));
element('#import').addEventListener('click',()=>element<HTMLInputElement>('#file').click());
element<HTMLInputElement>('#file').addEventListener('change',async e=>{
  const input=e.target as HTMLInputElement, file=input.files?.[0]; if(!file)return;
  try {setCraft(importCraft(await file.text())); notify('組裝資料已載入。');} catch(error){notify(error instanceof Error?error.message:String(error),true);} input.value='';
});

await RAPIER.init();
element('#launch').addEventListener('click',()=>action(()=>{
  const next=new AssemblyFlight(RAPIER,importCraft(exportCraft(craft))); flight=next; pending=null; paused=false; element('#pause').textContent='暫停'; accumulator=0; previousTarget.copy(flight.partPose(compiled.rootId).position); rebuild(); fit(); notify('試飛已準備。Space 點火第一級。');
}));
element('#return').addEventListener('click',()=>{flight!.dispose(); flight=null; paused=false; accumulator=0; rebuild(); fit(); element('#notice').hidden=true;});
const stage=()=>action(()=>{if(!flight)return; const n=flight.stage(); notify(n===null?'所有級數已執行。':`Stage ${n}：${flight.groups.length} 個物理群`);updatePanels();});
element('#stage').addEventListener('click',stage);
element('#pause').addEventListener('click',()=>{paused=!paused;element('#pause').textContent=paused?'繼續':'暫停';});
throttleInput.addEventListener('input',()=>{element('#throttle-text').textContent=`${throttleInput.value}%`;});
const keys=new Set<string>();
window.addEventListener('keydown',e=>{
  if((e.target instanceof HTMLInputElement && e.target.type!=='range')||e.target instanceof HTMLSelectElement)return;
  if(['Space','ShiftLeft','ShiftRight','ControlLeft','ControlRight','KeyW','KeyS','KeyA','KeyD','KeyQ','KeyE'].includes(e.code))e.preventDefault();
  keys.add(e.code);if(e.repeat)return; if(e.code==='Space')stage(); if(e.code==='KeyX'){throttleInput.value='0';element('#throttle-text').textContent='0%';}
  if(e.code==='Escape'){pending=null;rebuildNodes();updatePanels();}
});
window.addEventListener('keyup',e=>keys.delete(e.code));window.addEventListener('blur',()=>keys.clear());
let down:{x:number;y:number}|null=null;
renderer.domElement.addEventListener('pointerdown',e=>{if(e.button===0)down={x:e.clientX,y:e.clientY};});
renderer.domElement.addEventListener('pointerup',e=>{
  if(e.button!==0||!down)return;const dragged=Math.hypot(e.clientX-down.x,e.clientY-down.y)>5;down=null;if(dragged)return;
  const rect=renderer.domElement.getBoundingClientRect();pointer.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);raycaster.setFromCamera(pointer,camera);
  if(pending&&!flight){const hit=raycaster.intersectObjects(nodes.children)[0];if(hit){action(()=>{
    const data=hit.object.userData;craft=addPart(craft,pending!,data.parentId,data.nodeId,childInput.value);selected=craft.parts[craft.parts.length-1]!.id;pending=null;rebuild();});return;}}
  const hit=raycaster.intersectObject(parts,true)[0];if(hit){let object:THREE.Object3D|null=hit.object;while(object&&!object.userData.partId)object=object.parent;if(object){selected=object.userData.partId;updatePanels();}}
});
renderer.domElement.addEventListener('pointercancel',()=>{down=null;});
function resize():void{renderer.setSize(viewport.clientWidth,viewport.clientHeight);camera.aspect=viewport.clientWidth/viewport.clientHeight;camera.updateProjectionMatrix();}
new ResizeObserver(resize).observe(viewport);resize();rebuild();fit();
let last=performance.now(),accumulator=0,lastReadout=0;const previousTarget=new THREE.Vector3();
document.addEventListener('visibilitychange',()=>{last=performance.now();accumulator=0;keys.clear();});
const axis=(a:string,b:string)=>Number(keys.has(a))-Number(keys.has(b));
function frame(now:number):void{
  if(stopped)return;
  try{
    const wall=Math.min(0.1,Math.max(0,(now-last)/1000));last=now;
    if(!document.hidden){
      if(flight){
        const throttle=Number(throttleInput.value)+(Number(keys.has('ShiftLeft')||keys.has('ShiftRight'))-Number(keys.has('ControlLeft')||keys.has('ControlRight')))*wall*50;throttleInput.value=String(THREE.MathUtils.clamp(throttle,0,100));element('#throttle-text').textContent=`${Number(throttleInput.value).toFixed(0)}%`;
        if(!paused){accumulator+=wall;while(accumulator>=STEP_SECONDS){flight.step({throttle:Number(throttleInput.value)/100,turn:{x:axis('KeyS','KeyW'),y:axis('KeyE','KeyQ'),z:axis('KeyD','KeyA')}});accumulator-=STEP_SECONDS;}}
        for(const p of compiled.parts){const mesh=meshes.get(p.id)!,pose=flight.partPose(p.id);mesh.position.set(pose.position.x,pose.position.y,pose.position.z);mesh.quaternion.set(pose.rotation.x,pose.rotation.y,pose.rotation.z,pose.rotation.w);const flame=mesh.getObjectByName('flame');if(flame){const power=flight.firing.get(p.id)??0;flame.visible=power>0&&!paused;flame.scale.set(1,0.5+power,1);}}
        const target=new THREE.Vector3().copy(flight.partPose(compiled.rootId).position),delta=target.clone().sub(previousTarget);camera.position.add(delta);controls.target.add(delta);previousTarget.copy(target);
        marker.position.copy(flight.controlledBody.worldCom());
      }else{const center=summary(compiled).center;marker.position.set(center.x,center.y+editorOffset,center.z);}
      marker.visible=showCom;controls.update();renderer.render(scene,camera);
      if(flight&&now-lastReadout>150){lastReadout=now;updatePanels();}
    }
  }catch(e){panic(e);}requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
