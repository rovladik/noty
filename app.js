import * as pdfjsLib from './lib/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = './lib/pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);

// ---------- Хранилище (IndexedDB): сами PDF и последняя страница ----------
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('notes-app', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('scores', { keyPath: 'id' });
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function tx(mode, fn) {
  const db = await dbp;
  return new Promise((res, rej) => {
    const t = db.transaction('scores', mode);
    const out = fn(t.objectStore('scores'));
    t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
    t.onerror = () => rej(t.error);
  });
}
const dbAll = () => tx('readonly', (s) => s.getAll());
const dbGet = (id) => tx('readonly', (s) => s.get(id));
const dbPut = (v) => tx('readwrite', (s) => s.put(v));
const dbDel = (id) => tx('readwrite', (s) => s.delete(id));

if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// ---------- Библиотека ----------
async function showLibrary() {
  closeDoc();
  $('viewer').classList.add('hidden');
  $('library').classList.remove('hidden');
  const items = (await dbAll()).sort((a, b) => (b.opened || 0) - (a.opened || 0));
  const ul = $('score-list');
  ul.innerHTML = '';
  $('empty-hint').classList.toggle('hidden', items.length > 0);
  for (const it of items) {
    const li = document.createElement('li');
    const open = document.createElement('div');
    open.className = 'open';
    open.textContent = it.title || baseName(it.name);
    open.onclick = () => openScore(it.id);
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = it.pages ? `стр. ${it.page + 1} из ${it.pages}` : '';
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Удалить';
    del.onclick = async () => {
      if (confirm(`Удалить «${open.textContent}» из списка?`)) { await dbDel(it.id); showLibrary(); }
    };
    const ren = document.createElement('button');
    ren.className = 'del';
    ren.textContent = '✎';
    ren.title = 'Переименовать';
    ren.onclick = async () => {
      const t = prompt('Новое название:', open.textContent);
      if (t && t.trim()) { const r = await dbGet(it.id); r.title = t.trim(); await dbPut(r); showLibrary(); }
    };
    li.append(open, meta, ren, del);
    ul.append(li);
  }
}

$('file-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  let firstId = null;
  for (const f of files) {
    if (/\.doc$/i.test(f.name)) { alert(`«${f.name}» — это старый формат Word (.doc). Откройте его в Word или Pages и сохраните как .docx или PDF.`); continue; }
    if (!/\.(pdf|docx)$/i.test(f.name)) { alert(`«${f.name}»: можно открывать только PDF и Word (.docx).`); continue; }
    const id = `${f.name}|${f.size}`;
    const old = await dbGet(id);
    const buf = await f.arrayBuffer();
    await dbPut({ ...(old || {}), id, name: f.name, data: buf, page: old ? old.page : 0, pages: old ? old.pages : 0, opened: Date.now() });
    firstId = firstId || id;
  }
  if (files.length === 1 && firstId) openScore(firstId); else showLibrary();
});

// ---------- Просмотр ----------
let doc = null, rec = null, page = 0, renderToken = 0;
const cache = new Map(); // ключ "страница@ширинаxвысота" -> canvas
let twoPage = localStorage.getItem('twoPage') === '1';

const baseName = (n) => n.replace(/\.(pdf|docx)$/i, '');
const isWord = (r) => /\.docx$/i.test(r.name);
const isLandscape = () => innerWidth > innerHeight;
const spread = () => (twoPage && isLandscape() && doc && doc.numPages > 1 ? 2 : 1);

function closeDoc() {
  if (doc) doc.destroy();
  doc = null; rec = null; word = null; cache.clear();
  $('pages').innerHTML = '';
  releaseWakeLock();
}

async function openScore(id) {
  const r = await dbGet(id);
  if (!r) return;
  $('library').classList.add('hidden');
  $('viewer').classList.remove('hidden');
  $('loading').classList.remove('hidden');
  $('title').textContent = r.title || baseName(r.name);
  rec = r;
  try {
    doc = isWord(r) ? await openWord(r) : await pdfjsLib.getDocument({ data: new Uint8Array(r.data.slice(0)) }).promise;
  } catch (err) {
    alert('Не получилось открыть этот файл. Возможно, он повреждён.');
    return showLibrary();
  }
  rec.pages = doc.numPages;
  page = Math.min(r.page || 0, doc.numPages - 1);
  rec.opened = Date.now();
  dbPut(rec);
  $('loading').classList.add('hidden');
  updateTwoBtn();
  showToolbar();
  requestWakeLock();
  render();
}

function areaSize() {
  const el = $('pages');
  return { w: el.clientWidth, h: el.clientHeight };
}

async function renderPage(n, w, h) {
  const key = `${n}@${w}x${h}`;
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    const pg = await doc.getPage(n + 1);
    const v1 = pg.getViewport({ scale: 1 });
    const scale = Math.min(w / v1.width, h / v1.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const vp = pg.getViewport({ scale: scale * dpr });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    c.style.width = Math.floor(vp.width / dpr) + 'px';
    c.style.height = Math.floor(vp.height / dpr) + 'px';
    await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return c;
  })();
  cache.set(key, p);
  if (cache.size > 12) cache.delete(cache.keys().next().value); // не держим слишком много в памяти
  return p;
}

async function render() {
  if (!doc) return;
  if (word) return renderWord();
  const token = ++renderToken;
  const s = spread();
  const { w, h } = areaSize();
  const pw = s === 2 ? Math.floor((w - 4) / 2) : w;
  const nums = [page];
  if (s === 2 && page + 1 < doc.numPages) nums.push(page + 1);
  const canvases = await Promise.all(nums.map((n) => renderPage(n, pw, h)));
  if (token !== renderToken) return;
  $('pages').replaceChildren(...canvases);
  const last = nums[nums.length - 1] + 1;
  $('page-info').textContent = nums.length === 2 ? `${page + 1}–${last} из ${doc.numPages}` : `${page + 1} из ${doc.numPages}`;
  $('btn-prev').disabled = page === 0;
  $('btn-next').disabled = last >= doc.numPages;
  rec.page = page;
  dbPut(rec);
  // заранее готовим следующие страницы, чтобы перелистывание было мгновенным
  for (let i = 1; i <= s; i++) {
    const n = page + s + i - 1;
    if (n < doc.numPages) renderPage(n, pw, h);
  }
  if (page - s >= 0) renderPage(page - s, pw, h);
}

function go(dir) {
  if (!doc) return;
  const s = spread();
  let np = page + dir * s;
  if (np < 0) np = 0;
  if (np > doc.numPages - 1) return flash(dir);
  if (np === page) return flash(dir);
  page = np;
  flash(dir);
  render();
}

function flash(dir) {
  const f = document.createElement('div');
  f.className = 'flash';
  f.textContent = dir > 0 ? '▶' : '◀';
  f.style[dir > 0 ? 'right' : 'left'] = '20px';
  $('viewer').append(f);
  setTimeout(() => f.remove(), 600);
}

// ---------- Файлы Word (.docx) ----------
// Текст и картинки из Word раскладываются на «страницы» размером с экран.
let word = null;
function loadMammoth() {
  if (window.mammoth) return Promise.resolve();
  return new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = './lib/mammoth.browser.min.js';
    sc.onload = res; sc.onerror = rej;
    document.head.append(sc);
  });
}
async function openWord(r) {
  await loadMammoth();
  const out = await window.mammoth.convertToHtml({ arrayBuffer: r.data.slice(0) });
  const wrap = document.createElement('div');
  wrap.className = 'word-wrap';
  const inner = document.createElement('div');
  inner.className = 'word-doc';
  inner.innerHTML = out.value || '<p>(пустой документ)</p>';
  const end = document.createElement('span');
  end.className = 'word-end';
  inner.append(end);
  wrap.append(inner);
  $('pages').replaceChildren(wrap);
  await Promise.all([...inner.querySelectorAll('img')].map((im) =>
    im.complete ? 0 : new Promise((ok) => { im.onload = im.onerror = ok; })));
  word = { wrap, inner, end, key: '' };
  const d = { numPages: 1, destroy() {} };
  layoutWord(d);
  return d;
}
function layoutWord(d) {
  const { w, h } = areaSize();
  const s = twoPage && isLandscape() ? 2 : 1;
  const key = `${w}x${h}x${s}`;
  if (word.key === key) return false;
  const oldN = d.numPages;
  const pad = 28, gap = pad * 2;
  const colW = Math.floor((w - pad * 2 - gap * (s - 1)) / s);
  const colH = h - pad * 2;
  Object.assign(word.inner.style, {
    width: (w - pad * 2) + 'px', height: colH + 'px', columnWidth: colW + 'px',
    columnGap: gap + 'px', transform: 'none', margin: pad + 'px',
  });
  word.inner.style.setProperty('--colh', colH + 'px');
  word.step = colW + gap;
  const x = word.end.getBoundingClientRect().left - word.inner.getBoundingClientRect().left;
  d.numPages = Math.max(1, Math.floor((x + 1) / word.step) + 1);
  if (word.key && oldN > 1) page = Math.round(page / oldN * d.numPages);
  word.key = key;
  return true;
}
function renderWord() {
  layoutWord(doc);
  page = Math.max(0, Math.min(page, doc.numPages - 1));
  word.inner.style.transform = `translateX(${-page * word.step}px)`;
  const s = spread();
  const last = Math.min(page + s, doc.numPages);
  $('page-info').textContent = last - page === 2 ? `${page + 1}–${last} из ${doc.numPages}` : `${page + 1} из ${doc.numPages}`;
  $('btn-prev').disabled = page === 0;
  $('btn-next').disabled = last >= doc.numPages;
  rec.page = page; rec.pages = doc.numPages;
  dbPut(rec);
}

// ---------- Кнопки и касания ----------
const tap = (el, fn) => el.addEventListener('pointerup', (e) => { e.preventDefault(); fn(); });
tap($('btn-prev'), () => go(-1));
tap($('btn-next'), () => go(1));
tap($('tap-prev'), () => go(-1));
tap($('tap-next'), () => go(1));
tap($('tap-menu'), () => showToolbar());
tap($('btn-home'), () => showLibrary());
tap($('btn-two'), () => {
  twoPage = !twoPage;
  localStorage.setItem('twoPage', twoPage ? '1' : '0');
  updateTwoBtn();
  if (!isLandscape() && twoPage) alert('Две страницы показываются, когда iPad повёрнут горизонтально.');
  render();
  showToolbar();
});
function updateTwoBtn() { $('btn-two').classList.toggle('on', twoPage); }

let tbTimer;
function showToolbar() {
  $('toolbar').classList.remove('off');
  clearTimeout(tbTimer);
  tbTimer = setTimeout(() => $('toolbar').classList.add('off'), 4000);
}

// ---------- Педаль / клавиатура ----------
// Большинство педалей для нот посылают стрелки, PageUp/PageDown или пробел.
document.addEventListener('keydown', (e) => {
  if (!doc) return;
  const fwd = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Spacebar', 'Enter', 'MediaTrackNext'];
  const back = ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'MediaTrackPrevious'];
  if (fwd.includes(e.key)) { e.preventDefault(); if (!e.repeat) go(e.shiftKey && e.key === ' ' ? -1 : 1); }
  else if (back.includes(e.key)) { e.preventDefault(); if (!e.repeat) go(-1); }
  else if (e.key === 'Home') { e.preventDefault(); page = 0; render(); }
  else if (e.key === 'End') { e.preventDefault(); page = Math.max(0, doc.numPages - spread()); render(); }
});

// при повороте iPad перерисовываем под новый размер
let rzTimer;
addEventListener('resize', () => { clearTimeout(rzTimer); rzTimer = setTimeout(() => { cache.clear(); render(); }, 150); });

// ---------- Экран не гаснет, пока открыты ноты ----------
let wakeLock = null;
async function requestWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
}
function releaseWakeLock() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && doc) requestWakeLock(); });

// ---------- Работа без интернета ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

showLibrary();
