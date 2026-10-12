import * as THREE from 'three';
import gsap from 'gsap';
import './style.css';
import { createViewer } from './scene/viewer.js';
import { addLighting, prepareModel } from './scene/lights.js';
import { createCameraRig } from './scene/camera-rig.js';
import { createPicking } from './scene/picking.js';
import { buildStops } from './tour/rooms.js';
import { createScrollProgress } from './tour/scroll.js';
import { createUI } from './ui/ui.js';

const DEBUG = new URLSearchParams(location.search).has('debug');

const viewer = createViewer(document.getElementById('scene'));
const { camera, scene, composer } = viewer;

const meta = await fetch('/models/objects.json').then((r) => r.json());
const stops = buildStops(meta);
const itemById = new Map(meta.items.map((it) => [it.id, it]));
const scroll = createScrollProgress(stops.length);

let rig, picking;
const ui = createUI({
  stops, meta,
  onStop(i) {
    if (!rig) return;
    if (rig.mode !== 'tour') {
      ui.hideInfo();
      scroll.scrollToStop(i, 'instant');
      rig.toTour(() => i); // serbest/odak modundan tura dön
      return;
    }
    if (Math.abs(i - scroll.value) <= 1.01) scroll.scrollToStop(i);
    else {
      // uzak duraklara doğrudan uç, aradaki odalardan geçme
      scroll.scrollToStop(i, 'instant');
      rig.goToTourPose(i);
    }
  },
  onItem: selectItem,
  onBack() {
    if (rig?.mode !== 'focus') return;
    ui.hideInfo();
    rig.exitFocus(() => scroll.target());
  },
  onToggleFree() {
    if (!rig) return;
    ui.hideInfo();
    rig.toggleFree(() => scroll.target());
  },
});

function selectItem(id) {
  const item = itemById.get(id);
  if (!item || !rig) return;
  const stop = stops.find((s) => s.room === item.room);
  rig.focus(item, stop ? new THREE.Vector3(...stop.cam) : null);
  ui.showInfo(item);
}

// ------------------------------------------------------------------ model
let model;
try {
  model = await viewer.loadModel('/models/apartment.glb', ui.setLoading);
} catch (err) {
  console.error(err);
  ui.loadError('Model yüklenemedi. Önce "npm run prepare:model" çalıştırın.');
  throw err;
}
scene.add(model);
const groups = prepareModel(model);
addLighting(viewer, meta.bounds, stops.filter((s) => s.light).map((s) => ({ light: s.light })));

// Tavan, kamera tavana yaklaşınca yumuşakça kaybolur (kuşbakışı "maket" görünümü)
const ceilY = meta.bounds.max[1];
const ceilingMeshes = [];
groups.ceiling?.traverse((o) => {
  if (!o.isMesh) return;
  o.material = o.material.clone();
  o.material.transparent = true;
  ceilingMeshes.push(o);
});
function updateCeiling() {
  const k = THREE.MathUtils.smoothstep(camera.position.y, ceilY - 0.6, ceilY - 0.1);
  for (const m of ceilingMeshes) {
    m.material.opacity = 1 - k;
    m.material.depthWrite = k < 0.05;
    m.visible = k < 0.99;
  }
}

rig = createCameraRig(viewer, stops, { ceilingY: ceilY, occluders: [groups.structure, model.getObjectByName('items')] });
rig.update(scroll.value);
rig.onMode((m) => {
  document.documentElement.classList.toggle('locked', m !== 'tour');
  if (m === 'tour') scroll.update(1e3); // yumuşatılmış ilerlemeyi gerçek konuma eşitle
});
picking = createPicking(viewer, model.getObjectByName('items'), [groups.structure, model.getObjectByName('decor'), groups.ceiling].filter(Boolean), selectItem);
ui.onPinHover = (id) => picking.highlight(id ? groups.items.get(id) : null);

// Duvarın arkasında kalan pinleri gizle
const occRay = new THREE.Raycaster();
const occDir = new THREE.Vector3();
function pinVisible(pos) {
  const d = occDir.subVectors(pos, camera.position).length();
  occRay.set(camera.position, occDir.normalize());
  occRay.far = d - 0.1;
  return occRay.intersectObject(groups.structure, true).length === 0;
}

if (DEBUG) {
  console.info('[debug] P: kamera pozunu yazdır · serbest modda gezip istediğiniz açıyı bulun');
  addEventListener('keydown', (e) => { if (e.key === 'p') console.log(JSON.stringify(rig.debugPose())); });
  Object.assign(window, { rig, scene, camera, meta });
  gsap.ticker.lagSmoothing(0); // yavaş (yazılımsal) render'da da animasyonlar gerçek sürede bitsin
}
// Doğrudan bağlantı: ?stop=3 veya ?item=kanepe
{
  const q = new URLSearchParams(location.search);
  if (q.has('stop')) { scroll.scrollToStop(+q.get('stop'), 'instant'); scroll.update(1e3); }
  if (q.has('item')) requestAnimationFrame(() => selectItem(q.get('item')));
  if (DEBUG && q.has('cam')) {
    // ?debug&cam=x,y,z&target=x,y,z&fov=50 → serbest modda bu pozdan başla
    rig.toggleFree();
    camera.position.set(...q.get('cam').split(',').map(Number));
    rig.controls.target.set(...(q.get('target') ?? '0,0,0').split(',').map(Number));
    if (q.has('fov')) { camera.fov = +q.get('fov'); camera.updateProjectionMatrix(); }
    if (q.has('allpins')) document.body.classList.add('all-pins');
  }
}

// ------------------------------------------------------------- döngü
const clock = new THREE.Clock();
viewer.renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1);
  const p = scroll.update(dt);
  rig.update(p);
  updateCeiling();
  picking.update();
  ui.update(p, rig.mode, camera, pinVisible);
  composer.render();
});
ui.doneLoading();
