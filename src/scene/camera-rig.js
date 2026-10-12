import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import gsap from 'gsap';

const v3 = (a) => new THREE.Vector3(...a);
const smooth = (x) => x * x * (3 - 2 * x);
const clamp01 = (x) => Math.min(1, Math.max(0, x));

function bezier(a, b, c, d, t) {
  const u = 1 - t;
  return a.clone().multiplyScalar(u * u * u)
    .addScaledVector(b, 3 * u * u * t)
    .addScaledVector(c, 3 * u * t * t)
    .addScaledVector(d, t * t * t);
}

/**
 * Kamera üç modda çalışır:
 *  - tour:  pozisyon scroll ilerlemesinden hesaplanır (duraklar arası yukarıdan kavisli geçiş)
 *  - free:  OrbitControls ile serbest gezinti
 *  - focus: seçilen eşyanın etrafında OrbitControls
 */
export function createCameraRig({ camera, renderer }, stops, { ceilingY, occluders }) {
  const poses = stops.map((s) => ({ pos: v3(s.cam), target: v3(s.target), fov: s.fov ?? 55 }));
  const lookTarget = poses[0].target.clone();
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enabled = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.zoomToCursor = true;
  controls.minDistance = 0.3;
  controls.maxDistance = 30;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.screenSpacePanning = false;

  let mode = 'tour';
  let returnMode = 'tour';
  let tween = null;
  const listeners = new Set();
  const setTouch = () => { renderer.domElement.style.touchAction = mode === 'tour' ? 'pan-y' : 'none'; };
  setTouch();

  // Durak ilerlemesi p ∈ [0, N-1] → kamera pozu
  function poseAt(p) {
    const n = poses.length - 1;
    p = Math.min(n, Math.max(0, p));
    const i = Math.min(n - 1, Math.floor(p));
    // her durağın başında/sonunda kamera bir süre sabit kalır (okuma payı)
    const f = smooth(clamp01((p - i - 0.22) / 0.56));
    const A = poses[i], B = poses[i + 1];
    if (f === 0) return { pos: A.pos.clone(), target: A.target.clone(), fov: A.fov };
    if (f === 1) return { pos: B.pos.clone(), target: B.target.clone(), fov: B.fov };
    const lift = Math.max(A.pos.y, B.pos.y, ceilingY + 2.5 + A.pos.distanceTo(B.pos) * 0.35);
    const pos = bezier(A.pos, new THREE.Vector3(A.pos.x, lift, A.pos.z), new THREE.Vector3(B.pos.x, lift, B.pos.z), B.pos, f);
    const target = A.target.clone().lerp(B.target, f);
    return { pos, target, fov: THREE.MathUtils.lerp(A.fov, B.fov, f) };
  }

  // Dikey (portre) ekranlarda yatay görüş daralmasın diye dikey FOV'u büyüt
  const screenFov = (fov) => {
    if (camera.aspect >= 1) return fov;
    const t = Math.tan(THREE.MathUtils.degToRad(fov / 2)) * Math.min(1.7, 0.9 / camera.aspect);
    return Math.min(95, THREE.MathUtils.radToDeg(2 * Math.atan(t)));
  };
  let rawFov = poses[0].fov;
  function apply(pose) {
    rawFov = pose.fov;
    camera.position.copy(pose.pos);
    lookTarget.copy(pose.target);
    camera.lookAt(lookTarget);
    const fov = screenFov(pose.fov);
    if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
  }

  function tweenTo(getEnd, duration, onDone) {
    tween?.kill();
    const start = { pos: camera.position.clone(), target: lookTarget.clone(), fov: rawFov };
    const s = { t: 0 };
    tween = gsap.to(s, {
      t: 1, duration, ease: 'power2.inOut',
      onUpdate() {
        const end = getEnd();
        const k = s.t;
        // uzak geçişlerde hafifçe yukarıdan dolaş ki duvarların içinden geçmesin
        const mid = start.pos.clone().lerp(end.pos, 0.5);
        const far = start.pos.distanceTo(end.pos) > 2.5;
        if (far) mid.y = Math.max(mid.y, ceilingY + 1.5);
        const pos = far
          ? bezier(start.pos, new THREE.Vector3(start.pos.x, mid.y, start.pos.z), new THREE.Vector3(end.pos.x, mid.y, end.pos.z), end.pos, k)
          : start.pos.clone().lerp(end.pos, k);
        apply({ pos, target: start.target.clone().lerp(end.target, k), fov: THREE.MathUtils.lerp(start.fov, end.fov, k) });
      },
      onComplete() { tween = null; onDone?.(); },
    });
  }

  function setMode(m) {
    mode = m;
    controls.enabled = m !== 'tour';
    if (controls.enabled) { controls.target.copy(lookTarget); controls.update(); }
    setTouch();
    listeners.forEach((fn) => fn(m));
  }

  // Eşyaya odaklanma: 16 yatay yön denenir; eşyanın geniş yüzüne bakan, önü duvarla
  // kapanmayan ve odanın tur kamerasına yakın olan yön seçilir.
  const ray = new THREE.Raycaster();
  const FOCUS_FOV = 50;
  const itemIdOf = (o) => { while (o && !o.userData?.itemId) o = o.parent; return o?.userData.itemId; };
  function focusPose(item, fromPos) {
    if (item.view) return { pos: v3(item.view.cam), target: v3(item.view.target), fov: item.view.fov ?? FOCUS_FOV };
    const center = v3(item.center);
    const [sx, sy, sz] = item.size;
    const pref = (fromPos ?? camera.position).clone().sub(center).setY(0);
    if (pref.lengthSq() < 1e-4) pref.set(1, 0, 0);
    pref.normalize();
    const tanV = Math.tan(THREE.MathUtils.degToRad(FOCUS_FOV / 2));
    const tanH = tanV * camera.aspect;
    const maxArea = Math.max(sx, sz) * sy;

    let best = null;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const d = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const ax = Math.abs(d.x), az = Math.abs(d.z);
      const width = az * sx + ax * sz;
      const depth = ax * sx + az * sz;
      const want = THREE.MathUtils.clamp(Math.max(sy / 2 / tanV, width / 2 / tanH) * 1.05 + depth / 2, 0.8, 3.5);
      ray.set(center, d);
      ray.far = want + 0.3;
      // duvarlar ve (kendisi hariç) diğer opak eşyalar görüşü kapatır
      const hit = ray.intersectObjects(occluders, true)
        .find((h) => !h.object.material.transparent && itemIdOf(h.object) !== item.id);
      const free = hit ? hit.distance : Infinity;
      const area = (az * sx + ax * sz) * sy;
      const score = Math.min(1, (free - 0.25) / want) * 0.9 + (area / maxArea) * 1.0 + d.dot(pref) * 0.35;
      if (!best || score > best.score) best = { score, d, dist: Math.min(want, free - 0.25) };
    }
    const dist = Math.max(0.5, best.dist);
    const pos = center.clone().addScaledVector(best.d, dist);
    pos.y = THREE.MathUtils.clamp(center.y + dist * 0.4, 0.7, ceilingY - 0.35);
    return { pos, target: center, fov: FOCUS_FOV };
  }

  return {
    controls,
    get mode() { return mode; },
    onMode(fn) { listeners.add(fn); },
    poseAt,
    /** her karede çağrılır */
    update(progress) {
      if (tween) return;
      if (mode === 'tour') apply(poseAt(progress));
      else { controls.update(); lookTarget.copy(controls.target); }
    },
    focus(item, fromPos) {
      if (mode !== 'focus') returnMode = mode;
      setMode('focus');
      controls.enabled = false;
      const end = focusPose(item, fromPos);
      tweenTo(() => end, 1.3, () => {
        controls.enabled = true;
        controls.target.copy(end.target);
        controls.minDistance = 0.3;
        controls.update();
      });
    },
    exitFocus(getTourProgress) {
      if (mode !== 'focus') return;
      if (returnMode === 'tour') this.toTour(getTourProgress);
      else setMode('free');
    },
    toTour(getTourProgress) {
      controls.enabled = false;
      tweenTo(() => poseAt(getTourProgress()), 1.1, () => setMode('tour'));
    },
    toggleFree(getTourProgress) {
      if (mode === 'free') this.toTour(getTourProgress);
      else {
        tween?.kill();
        tween = null;
        returnMode = 'free';
        setMode('free');
      }
    },
    goToTourPose(progress) { tweenTo(() => poseAt(progress), 1.2); },
    debugPose() {
      const r = (v) => v.toArray().map((x) => +x.toFixed(2));
      return { cam: r(camera.position), target: r(lookTarget), fov: camera.fov };
    },
  };
}
