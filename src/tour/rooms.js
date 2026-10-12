// Tur durakları. Koordinatlar metre; model zemin merkezi (0,0,0).
// +X doğu (salon), −X batı (yatak odaları), −Z kuzey, +Z güney.
// Kamera ayarı için sayfayı ?debug ile açıp konsoldaki pose çıktısını kullanın.
export const STOPS = [
  {
    id: 'genel',
    eyebrow: 'Via Boncompagni · Milano',
    title: 'Trilocale Milano',
    desc: 'Üç odalı, iki banyolu, ışık alan bir şehir dairesi. Aşağı kaydırdıkça kamera odaların içine iner; eşyaların üzerine tıklayarak onlara yakından bakabilirsiniz.',
    cam: [1.5, 12.5, 10.5], target: [0, 0, 0.4], fov: 42,
  },
  { room: 'salon', cam: [3.5, 1.7, 2.7], target: [3.4, 0.6, -1.6], fov: 66, light: { pos: [3.6, -0.5] } },
  { room: 'mutfak', cam: [0.4, 1.75, 0.95], target: [1.5, 0.8, -2.4], fov: 68, light: { pos: [1.0, -1.0] } },
  { room: 'antre', cam: [-1.65, 1.6, 1.05], target: [-0.2, 0.7, -0.45], fov: 70, light: { pos: [-0.9, 0.2], intensity: 1.5, range: 3 } },
  { room: 'banyo1', cam: [-1.35, 1.65, -1.1], target: [-0.6, 0.5, -2.8], fov: 72, light: { pos: [-0.9, -2.3], intensity: 1.5, range: 3 } },
  { room: 'banyo2', cam: [-1.15, 1.65, 1.55], target: [-0.6, 0.5, 3.2], fov: 72, light: { pos: [-0.9, 2.5], intensity: 1.5, range: 3 } },
  { room: 'yatak1', cam: [-2.4, 1.65, -0.35], target: [-4.4, 0.5, -2.2], fov: 66, light: { pos: [-3.7, -1.7] } },
  { room: 'yatak2', cam: [-2.3, 1.65, 1.1], target: [-4.2, 0.5, 3.0], fov: 66, light: { pos: [-3.7, 1.9] } },
  {
    id: 'son',
    eyebrow: 'Tur bitti',
    title: 'Kendi başınıza gezin',
    desc: 'Sağ üstteki "Serbest gez" ile daireyi dilediğiniz açıdan inceleyin: sürükleyerek döndürün, tekerlekle imlecin olduğu yere yakınlaşın.',
    cam: [-9, 9.5, -8], target: [0, 0, 0], fov: 42,
  },
];

// objects.json'daki oda bilgileriyle durakları birleştir
export function buildStops(meta) {
  const rooms = new Map(meta.rooms.map((r) => [r.id, r]));
  return STOPS.map((s, i) => {
    const room = s.room ? rooms.get(s.room) : null;
    return {
      ...s,
      index: i,
      title: s.title ?? room?.name,
      desc: s.desc ?? room?.desc,
      eyebrow: s.eyebrow ?? `Oda ${String(i).padStart(2, '0')}`,
      items: s.room ? meta.items.filter((it) => it.room === s.room) : [],
    };
  });
}
