// Kaynak glTF modelini web için hazırlar ve eksiklerini tamamlar:
//  - kök dönüşümünü uygular, cm → m çevirir, modeli orijine ortalar
//  - malzemeye göre birleşik mesh'leri bağlı parçalara ayırır ve parçaları
//    mekânsal kümeleme ile "eşya" gruplarına toplar
//  - duvar/zemin (yapı) ile tavanı ayırır (kuşbakışı maket görünümü için)
//  - malzeme adlarına göre PBR değerlerini düzeltir
//  - src/tour/catalog.json'daki eşya adlarını/odalarını gruplara uygular
//  - meshopt ile sıkıştırıp public/models/ altına yazar
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, '3d-model/trilocale_via_boncompagni_milano-glTF/scene.gltf');
const OUT_DIR = path.join(ROOT, 'public/models');
const REPORT_DIR = path.join(ROOT, 'scripts/out');
const CATALOG = path.join(ROOT, 'src/tour/catalog.json');

const UNIT = 0.01; // cm → m
const MERGE_TOL = 0.015; // eşya kümelemede AABB temas toleransı (m)
const MAX_ITEM_XZ = 2.6; // bir eşyanın en fazla yatay boyutu (m)
const MAX_ITEM_H = 2.3; // bir eşyanın en fazla yüksekliği (m)
const CEILING_BAND = 0.06; // en üst bu banttaki yapı üçgenleri tavan sayılır

// Duvar / zemin / tavan malzemeleri
const STRUCT_MATERIALS = new Set([
  'Sheet__Plasterbo', 'SoapStone_Tile', 'Plank01_Decking', 'Color_Off_White',
  'Granite-Tiles', 'material', 'White_Oak_blond', 'Aqua_Mosaic_Tile',
  'Check-Blue_Lamin', 'Check-Blue_Lami1', 'CVOW02_Laminate',
]);

// ---------------------------------------------------------------- yardımcılar
const bboxEmpty = () => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
function bboxAddPoint(b, x, y, z) {
  if (x < b.min[0]) b.min[0] = x; if (y < b.min[1]) b.min[1] = y; if (z < b.min[2]) b.min[2] = z;
  if (x > b.max[0]) b.max[0] = x; if (y > b.max[1]) b.max[1] = y; if (z > b.max[2]) b.max[2] = z;
}
const bboxUnion = (a, b) => ({
  min: a.min.map((v, i) => Math.min(v, b.min[i])),
  max: a.max.map((v, i) => Math.max(v, b.max[i])),
});
const bboxSize = (b) => b.max.map((v, i) => v - b.min[i]);
const bboxCenter = (b) => b.max.map((v, i) => (v + b.min[i]) / 2);
const bboxTouch = (a, b, tol) =>
  a.min[0] <= b.max[0] + tol && b.min[0] <= a.max[0] + tol &&
  a.min[1] <= b.max[1] + tol && b.min[1] <= a.max[1] + tol &&
  a.min[2] <= b.max[2] + tol && b.min[2] <= a.max[2] + tol;
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

function makeUF(n) {
  const p = new Int32Array(n).map((_, i) => i);
  const find = (i) => { while (p[i] !== i) { p[i] = p[p[i]]; i = p[i]; } return i; };
  return { p, find, union: (a, b) => { a = find(a); b = find(b); if (a !== b) p[b] = a; return a; } };
}

// Sütun-ana (column-major) 4x4 matrisle nokta / yön dönüşümü
const xfPoint = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];
const xfDir = (m, x, y, z) => {
  const v = [m[0] * x + m[4] * y + m[8] * z, m[1] * x + m[5] * y + m[9] * z, m[2] * x + m[6] * y + m[10] * z];
  const l = Math.hypot(...v) || 1;
  return v.map((c) => c / l);
};

// ------------------------------------------------------------------- okuma
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
await MeshoptEncoder.ready;

const doc = await io.read(SRC);
const root = doc.getRoot();
const scene = root.listScenes()[0];

// "Üçgen çorbası" parçalarına ayır: her parça tek malzemeli, bağlı bir bileşen
const parts = [];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const M = node.getWorldMatrix();
  for (const prim of mesh.listPrimitives()) {
    if (prim.getMode() !== 4) continue;
    const material = prim.getMaterial();
    const P = prim.getAttribute('POSITION').getArray();
    const N = prim.getAttribute('NORMAL')?.getArray();
    const T = prim.getAttribute('TEXCOORD_0')?.getArray();
    const vcount = P.length / 3;
    const I = prim.getIndices()?.getArray() ?? Uint32Array.from({ length: vcount }, (_, i) => i);

    // dünya koordinatları (metre)
    const wp = new Float32Array(vcount * 3);
    const wn = N ? new Float32Array(vcount * 3) : null;
    for (let v = 0; v < vcount; v++) {
      const p = xfPoint(M, P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      wp[v * 3] = p[0] * UNIT; wp[v * 3 + 1] = p[1] * UNIT; wp[v * 3 + 2] = p[2] * UNIT;
      if (N) { const n = xfDir(M, N[v * 3], N[v * 3 + 1], N[v * 3 + 2]); wn.set(n, v * 3); }
    }

    // aynı konumdaki köşeleri birleştirip bağlı bileşenleri bul
    const uf = makeUF(vcount);
    const keyRep = new Map();
    for (let v = 0; v < vcount; v++) {
      const k = `${Math.round(wp[v * 3] * 1e4)},${Math.round(wp[v * 3 + 1] * 1e4)},${Math.round(wp[v * 3 + 2] * 1e4)}`;
      const r = keyRep.get(k);
      if (r === undefined) keyRep.set(k, v); else uf.union(r, v);
    }
    for (let t = 0; t < I.length; t += 3) { uf.union(I[t], I[t + 1]); uf.union(I[t], I[t + 2]); }

    const comps = new Map(); // kök → üçgen listesi
    for (let t = 0; t < I.length; t += 3) {
      const r = uf.find(I[t]);
      let list = comps.get(r);
      if (!list) comps.set(r, (list = []));
      list.push(t);
    }
    for (const tris of comps.values()) {
      const remap = new Map();
      const pos = [], nrm = [], uv = [], idx = [];
      const bbox = bboxEmpty();
      for (const t of tris) {
        for (let c = 0; c < 3; c++) {
          const v = I[t + c];
          let nv = remap.get(v);
          if (nv === undefined) {
            nv = remap.size; remap.set(v, nv);
            pos.push(wp[v * 3], wp[v * 3 + 1], wp[v * 3 + 2]);
            bboxAddPoint(bbox, wp[v * 3], wp[v * 3 + 1], wp[v * 3 + 2]);
            if (wn) nrm.push(wn[v * 3], wn[v * 3 + 1], wn[v * 3 + 2]);
            if (T) uv.push(T[v * 2], T[v * 2 + 1]);
          }
          idx.push(nv);
        }
      }
      parts.push({ material, matName: material?.getName() ?? '', pos, nrm: wn ? nrm : null, uv: T ? uv : null, idx, bbox });
    }
  }
}

// ------------------------------------------------------- ortalama (zemin = 0)
let gb = bboxEmpty();
for (const p of parts) gb = bboxUnion(gb, p.bbox);
const offset = [(gb.min[0] + gb.max[0]) / 2, 0, (gb.min[2] + gb.max[2]) / 2];
// zemin seviyesi: en yaygın alt kotu kullan (döşeme altı kalınlıklarını yok say)
{
  const hist = new Map();
  for (const p of parts) { const k = Math.round(p.bbox.min[1] * 100); hist.set(k, (hist.get(k) ?? 0) + p.idx.length); }
  offset[1] = [...hist.entries()].sort((a, b) => b[1] - a[1])[0][0] / 100;
}
for (const p of parts) {
  for (let i = 0; i < p.pos.length; i += 3) { p.pos[i] -= offset[0]; p.pos[i + 1] -= offset[1]; p.pos[i + 2] -= offset[2]; }
  p.bbox = { min: p.bbox.min.map((v, i) => v - offset[i]), max: p.bbox.max.map((v, i) => v - offset[i]) };
}
gb = { min: gb.min.map((v, i) => v - offset[i]), max: gb.max.map((v, i) => v - offset[i]) };
const topY = gb.max[1];

// --------------------------------------------------------- yapı / eşya ayrımı
for (const p of parts) {
  const s = bboxSize(p.bbox);
  p.structural = STRUCT_MATERIALS.has(p.matName) || Math.max(s[0], s[2]) > 3.0 || (s[1] > 2.3 && Math.min(s[0], s[2]) < 0.3 && Math.max(s[0], s[2]) > 1.2);
  // zemindeki ince şeyler (halı vb.) başka eşyaları birbirine bağlamasın
  p.noMerge = !p.structural && s[1] < 0.03 && p.bbox.min[1] < 0.05 && Math.max(s[0], s[2]) > 0.5;
}

// Eşya parçalarını kümele (sweep-and-prune + boyut sınırı)
const itemParts = parts.filter((p) => !p.structural);
const uf = makeUF(itemParts.length);
const cbox = itemParts.map((p) => p.bbox);
const order = itemParts.map((_, i) => i).sort((a, b) => cbox[a].min[0] - cbox[b].min[0]);
for (let oi = 0; oi < order.length; oi++) {
  const i = order[oi];
  if (itemParts[i].noMerge) continue;
  for (let oj = oi + 1; oj < order.length; oj++) {
    const j = order[oj];
    if (itemParts[j].bbox.min[0] > itemParts[i].bbox.max[0] + MERGE_TOL) break;
    if (itemParts[j].noMerge) continue;
    if (!bboxTouch(itemParts[i].bbox, itemParts[j].bbox, MERGE_TOL)) continue;
    const ri = uf.find(i), rj = uf.find(j);
    if (ri === rj) continue;
    const u = bboxUnion(cbox[ri], cbox[rj]);
    const s = bboxSize(u);
    if (Math.max(s[0], s[2]) > MAX_ITEM_XZ || s[1] > MAX_ITEM_H) continue;
    const r = uf.union(ri, rj);
    cbox[r] = u;
  }
}
const clusterMap = new Map();
itemParts.forEach((p, i) => {
  const r = uf.find(i);
  let c = clusterMap.get(r);
  if (!c) clusterMap.set(r, (c = { parts: [], bbox: bboxEmpty(), tris: 0 }));
  c.parts.push(p); c.bbox = bboxUnion(c.bbox, p.bbox); c.tris += p.idx.length / 3;
});
const clusters = [...clusterMap.values()]
  .sort((a, b) => a.bbox.min[0] - b.bbox.min[0] || a.bbox.min[2] - b.bbox.min[2] || a.bbox.min[1] - b.bbox.min[1])
  .map((c, i) => ({ ...c, id: `c${i}` }));

// ------------------------------------------------------------- katalog eşleme
const catalog = fs.existsSync(CATALOG) ? JSON.parse(fs.readFileSync(CATALOG, 'utf8').replace(/^﻿/, '')) : { rooms: [], items: [] };
const inBox = (pt, box) => pt.every((v, i) => v >= box[0][i] && v <= box[1][i]);
for (const c of clusters) {
  const ctr = bboxCenter(c.bbox);
  const item = catalog.items.find((it) => it.clusters?.includes(c.id) || (it.box && inBox(ctr, it.box)));
  c.itemId = item?.id ?? null;
}

// ---------------------------------------------------------- yeni sahne kurulumu
function buildPrimitive(groupParts, material) {
  const pos = [], nrm = [], uv = [], idx = [];
  let hasN = true, hasT = true;
  for (const p of groupParts) { if (!p.nrm) hasN = false; if (!p.uv) hasT = false; }
  for (const p of groupParts) {
    const base = pos.length / 3;
    pos.push(...p.pos);
    if (hasN) nrm.push(...p.nrm);
    if (hasT) uv.push(...p.uv);
    for (const i of p.idx) idx.push(i + base);
  }
  const buffer = root.listBuffers()[0];
  const prim = doc.createPrimitive().setMaterial(material)
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(pos.length / 3 > 65535 ? new Uint32Array(idx) : new Uint16Array(idx)).setBuffer(buffer));
  if (hasN) prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(nrm)).setBuffer(buffer));
  if (hasT) prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(uv)).setBuffer(buffer));
  return prim;
}
function buildNode(name, groupParts, extras = {}) {
  const byMat = new Map();
  for (const p of groupParts) {
    if (!p.idx.length) continue;
    let list = byMat.get(p.material);
    if (!list) byMat.set(p.material, (list = []));
    list.push(p);
  }
  const mesh = doc.createMesh(name);
  for (const [mat, list] of byMat) mesh.addPrimitive(buildPrimitive(list, mat));
  return doc.createNode(name).setMesh(mesh).setExtras(extras);
}

// Yapı parçalarını üçgen bazında tavan / diğer olarak böl
const structParts = [], ceilingParts = [];
for (const p of parts.filter((q) => q.structural)) {
  const keep = [], ceil = [];
  for (let t = 0; t < p.idx.length; t += 3) {
    const ys = [0, 1, 2].map((c) => p.pos[p.idx[t + c] * 3 + 1]);
    (Math.min(...ys) >= topY - CEILING_BAND ? ceil : keep).push(p.idx[t], p.idx[t + 1], p.idx[t + 2]);
  }
  if (keep.length) structParts.push({ ...p, idx: keep });
  if (ceil.length) ceilingParts.push({ ...p, idx: ceil });
}

// Eski hiyerarşiyi temizle
for (const n of root.listNodes()) n.dispose();
for (const m of root.listMeshes()) m.dispose();

const apartment = doc.createNode('Apartment');
scene.addChild(apartment);
apartment.addChild(buildNode('structure', structParts, { role: 'structure' }));
apartment.addChild(buildNode('ceiling', ceilingParts, { role: 'ceiling' }));

const itemsNode = doc.createNode('items');
const decorNode = doc.createNode('decor');
apartment.addChild(itemsNode).addChild(decorNode);
const byItem = new Map();
for (const c of clusters) {
  if (c.itemId) { if (!byItem.has(c.itemId)) byItem.set(c.itemId, []); byItem.get(c.itemId).push(c); }
  else decorNode.addChild(buildNode(c.id, c.parts, { role: 'decor', cluster: c.id }));
}
const objects = [];
for (const it of catalog.items) {
  const cs = byItem.get(it.id);
  if (!cs) { console.warn(`! katalog eşyası eşleşmedi: ${it.id}`); continue; }
  const ps = cs.flatMap((c) => c.parts);
  const bbox = cs.reduce((b, c) => bboxUnion(b, c.bbox), bboxEmpty());
  itemsNode.addChild(buildNode(it.id, ps, { role: 'item', itemId: it.id }));
  const size = bboxSize(bbox);
  objects.push({
    id: it.id, name: it.name, room: it.room, desc: it.desc ?? '',
    center: bboxCenter(bbox).map((v) => round(v)), size: size.map((v) => round(v)),
    radius: round(Math.hypot(...size) / 2),
    ...(it.view ? { view: it.view } : {}),
  });
}

// ------------------------------------------------------- malzeme düzeltmeleri
for (const m of root.listMaterials()) {
  const n = m.getName();
  if (/Chrome|Stainless|Nickel|Tin_Polished|Brass|RUBINETTERIA|Aluminum|Appliance_Stainl/.test(n)) m.setMetallicFactor(0.9).setRoughnessFactor(0.25);
  else if (n === 'Mirror') m.setMetallicFactor(1).setRoughnessFactor(0.04).setBaseColorFactor([0.95, 0.95, 0.95, 1]);
  else if (/^Glass/.test(n) || n === 'GunMetal_Glass') m.setMetallicFactor(0.1).setRoughnessFactor(0.05);
  else if (/Oak|Hickory|Plank|Laminate|Decking/.test(n)) m.setRoughnessFactor(0.55);
  else if (/Tile|Vittkakel|Granite|SoapStone|Ivory|Vanilj|LAVABO|Ceramic|Appliance_White/.test(n)) m.setRoughnessFactor(0.2);
  else if (/Leather/.test(n)) m.setRoughnessFactor(0.45);
  else if (/Carpet|Denim|Twill|Camouflage|Textile/.test(n)) m.setRoughnessFactor(0.95);
  if (m.getAlphaMode() === 'BLEND') m.setDoubleSided(true);
}

await doc.transform(prune(), dedup(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));

// --------------------------------------------------------------- çıktılar
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(REPORT_DIR, { recursive: true });
await io.write(path.join(OUT_DIR, 'apartment.glb'), doc);
fs.writeFileSync(path.join(OUT_DIR, 'objects.json'), JSON.stringify({
  bounds: { min: gb.min.map((v) => round(v)), max: gb.max.map((v) => round(v)) },
  rooms: catalog.rooms, items: objects,
}, null, 2));
fs.writeFileSync(path.join(REPORT_DIR, 'objects-report.json'), JSON.stringify({
  bounds: { min: gb.min.map((v) => round(v, 2)), max: gb.max.map((v) => round(v, 2)) },
  clusters: clusters.map((c) => {
    const mats = {};
    for (const p of c.parts) mats[p.matName] = (mats[p.matName] ?? 0) + p.idx.length / 3;
    return { id: c.id, item: c.itemId, center: bboxCenter(c.bbox).map((v) => round(v, 2)), size: bboxSize(c.bbox).map((v) => round(v, 2)), tris: c.tris, mats };
  }),
}, null, 1));

const kb = (fs.statSync(path.join(OUT_DIR, 'apartment.glb')).size / 1024 / 1024).toFixed(2);
console.log(`parça: ${parts.length}  küme: ${clusters.length}  katalog eşyası: ${objects.length}/${catalog.items.length}`);
console.log(`yapı parçası: ${structParts.length}  tavan parçası: ${ceilingParts.length}`);
console.log(`sınırlar: ${JSON.stringify(gb.min.map((v) => round(v, 2)))} → ${JSON.stringify(gb.max.map((v) => round(v, 2)))}`);
console.log(`apartment.glb: ${kb} MB`);
