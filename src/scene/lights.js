import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Modelde hiç ışık yok: ortam haritası + gün ışığı + her odaya tavan ışığı ekliyoruz.
export function addLighting({ renderer, scene }, bounds, rooms) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();

  scene.add(new THREE.HemisphereLight('#fff6ea', '#8a7f72', 0.9));

  const sun = new THREE.DirectionalLight('#fff1dc', 2.2);
  sun.position.set(6, 12, 4);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const ext = Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2]) / 2 + 1;
  Object.assign(sun.shadow.camera, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 30 });
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);

  // Oda ışıkları (tavan altı, gölgesiz)
  const ceiling = bounds.max[1] - 0.25;
  for (const room of rooms) {
    if (!room.light) continue;
    const l = new THREE.PointLight('#ffe2bf', room.light.intensity ?? 3, room.light.range ?? 6, 1.6);
    l.position.set(room.light.pos[0], ceiling, room.light.pos[1]);
    scene.add(l);
  }
}

// Malzemelere gölge/şeffaflık ayarı; tavan gölge düşürmez ki içerisi aydınlık kalsın
export function prepareModel(model) {
  const groups = { structure: null, ceiling: null, items: new Map(), decor: null };
  model.traverse((o) => {
    const role = o.userData?.role;
    if (role === 'structure') groups.structure = o;
    if (role === 'ceiling') groups.ceiling = o;
    if (role === 'item') groups.items.set(o.userData.itemId, o);
    if (o.isMesh) {
      const transparent = o.material.transparent;
      o.castShadow = !transparent;
      o.receiveShadow = true;
      if (transparent) o.material.depthWrite = false;
    }
  });
  groups.ceiling?.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  return groups;
}
