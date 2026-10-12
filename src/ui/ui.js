import * as THREE from 'three';

const $ = (id) => document.getElementById(id);

export function createUI({ stops, meta, onStop, onItem, onBack, onToggleFree }) {
  const roomName = new Map(meta.rooms.map((r) => [r.id, r.name]));
  const tour = $('tour');
  const dots = $('dots');
  const card = $('stop-card');
  const list = $('items-list');
  const pins = $('pins');

  // Kaydırma bölümleri ve oda noktaları
  stops.forEach((s, i) => {
    const sec = document.createElement('section');
    sec.className = 'stop-space';
    tour.appendChild(sec);
    const b = document.createElement('button');
    b.type = 'button';
    b.title = s.title;
    b.setAttribute('aria-label', s.title);
    b.addEventListener('click', () => onStop(i));
    dots.appendChild(b);
  });
  document.querySelector('.brand').addEventListener('click', (e) => { e.preventDefault(); onStop(0); });
  $('mode-toggle').addEventListener('click', onToggleFree);
  $('info-back').addEventListener('click', onBack);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') onBack(); });

  // 3D pinler (her eşya için bir tane, yalnızca ilgili odada görünür)
  const pinEls = new Map();
  for (const it of meta.items) {
    const p = document.createElement('button');
    p.type = 'button';
    p.className = 'pin';
    p.innerHTML = `<span class="pin-dot"></span><span class="pin-label">${it.name}</span>`;
    p.addEventListener('click', () => onItem(it.id));
    p.addEventListener('pointerenter', () => ui.onPinHover?.(it.id));
    p.addEventListener('pointerleave', () => ui.onPinHover?.(null));
    pins.appendChild(p);
    pinEls.set(it.id, { el: p, pos: new THREE.Vector3(it.center[0], it.center[1] + Math.min(it.size[1] / 2, 0.6), it.center[2]) });
  }

  let shownStop = -1, listKey = '', focusRoom = null, focusId = null;
  function renderList(items, title) {
    const key = title + items.map((i) => i.id).join();
    if (key === listKey) return;
    listKey = key;
    $('items-title').textContent = title;
    list.replaceChildren(...items.map((it) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.id = it.id;
      b.innerHTML = `<span>${it.name}</span><small>${roomName.get(it.room)}</small>`;
      b.addEventListener('click', () => onItem(it.id));
      b.addEventListener('pointerenter', () => ui.onPinHover?.(it.id));
      b.addEventListener('pointerleave', () => ui.onPinHover?.(null));
      li.appendChild(b);
      return li;
    }));
  }

  const tmp = new THREE.Vector3();
  const ui = {
    onPinHover: null,
    /** p: tur ilerlemesi; mode: tour|free|focus */
    update(p, mode, camera, pinVisible = () => true) {
      const i = Math.round(p);
      const hold = Math.abs(p - i) < 0.24;
      document.body.dataset.mode = mode;
      [...dots.children].forEach((d, k) => d.classList.toggle('active', k === i));
      $('mode-toggle').textContent = mode === 'free' ? 'Tura dön' : 'Serbest gez';
      $('scroll-hint').classList.toggle('hidden', p > 0.1 || mode !== 'tour');

      if (i !== shownStop) {
        shownStop = i;
        const s = stops[i];
        $('stop-index').textContent = s.eyebrow;
        $('stop-title').textContent = s.title;
        $('stop-desc').textContent = s.desc;
      }
      card.classList.toggle('visible', mode === 'tour' && hold);

      const stopItems = stops[i].items;
      if (mode === 'focus' && focusRoom) renderList(meta.items.filter((it) => it.room === focusRoom), `${roomName.get(focusRoom)} · eşyalar`);
      else if (mode === 'tour' && stopItems.length) renderList(stopItems, `${stops[i].title} · eşyalar`);
      else if (mode !== 'focus') renderList(meta.items, 'Tüm eşyalar');
      list.querySelectorAll('button').forEach((b) => b.classList.toggle('current', mode === 'focus' && b.dataset.id === focusId));

      // pinler
      const showRoom = mode === 'tour' && hold ? stops[i].room : null;
      const w = innerWidth, h = innerHeight;
      for (const it of meta.items) {
        const { el, pos } = pinEls.get(it.id);
        const visible = showRoom === it.room;
        if (visible) {
          tmp.copy(pos).project(camera);
          const on = tmp.z < 1 && Math.abs(tmp.x) < 0.95 && Math.abs(tmp.y) < 0.95 && pinVisible(pos);
          el.classList.toggle('visible', on);
          if (on) el.style.transform = `translate(${(tmp.x * 0.5 + 0.5) * w}px, ${(-tmp.y * 0.5 + 0.5) * h}px)`;
        } else el.classList.remove('visible');
      }
    },
    showInfo(item) {
      focusRoom = item.room;
      focusId = item.id;
      $('info-room').textContent = roomName.get(item.room);
      $('info-title').textContent = item.name;
      $('info-desc').textContent = item.desc;
      $('info').hidden = false;
    },
    hideInfo() {
      focusRoom = focusId = null;
      $('info').hidden = true;
    },
    setLoading(f) {
      $('loader-bar').style.width = `${Math.round(f * 100)}%`;
      $('loader-text').textContent = `${Math.round(f * 100)}%`;
    },
    doneLoading() { $('loader').classList.add('done'); },
    loadError(msg) { $('loader-text').textContent = msg; },
  };
  return ui;
}
