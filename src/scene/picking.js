import * as THREE from 'three';

// Fareyle eşya üzerine gelince vurgula, tıklayınca onSelect(itemId) çağır.
export function createPicking({ camera, renderer, outline }, itemsRoot, occluders, onSelect) {
  const el = renderer.domElement;
  const ray = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let dirty = false, inside = false, hovered = null, down = null;
  let enabled = true;

  const itemOf = (obj) => {
    while (obj && obj.userData?.role !== 'item') obj = obj.parent;
    return obj;
  };

  function pick() {
    ray.setFromCamera(mouse, camera);
    const hit = ray.intersectObjects([itemsRoot, ...occluders], true).find((h) => h.object.visible && !h.object.material.transparent);
    return hit ? itemOf(hit.object) : null;
  }

  function setHovered(node) {
    if (node === hovered) return;
    hovered = node;
    outline.selectedObjects = node ? [node] : [];
    el.style.cursor = node ? 'pointer' : '';
  }

  el.addEventListener('pointermove', (e) => {
    mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    dirty = e.buttons === 0;
    inside = true;
  });
  el.addEventListener('pointerleave', () => { inside = false; setHovered(null); });
  el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  el.addEventListener('pointerup', (e) => {
    if (!enabled || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    const node = pick();
    if (node) onSelect(node.userData.itemId);
  });

  return {
    set enabled(v) { enabled = v; if (!v) setHovered(null); },
    highlight(node) { setHovered(node); },
    /** rAF içinde: hover raycast'i kare başına en fazla bir kez */
    update() {
      if (!enabled || !dirty || !inside) return;
      dirty = false;
      setHovered(pick());
    },
  };
}
