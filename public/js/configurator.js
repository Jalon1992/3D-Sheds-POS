// Customer-facing configurator: Style → Size → Colors → Options → Quote.
import { ShedScene } from './shed3d.js';
import { defaultConfig, priceConfig, money, WALLS, colorGroupEnabled, resolveTier, tierCatalog, findDealer, roofChoices, roofColorsFor, roofMaterialPrice, roofingList, optionAvailable, isPackage, placePackage } from './shared/pricing.js';
import { shedGeometry, findSpot, canPlace, resolvePlacement, gableMode } from './shared/geometry.js';
import { floorPlanSVG } from './shared/floorplan.js';
import { buildDrawingPackage } from './drawings.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const params = new URLSearchParams(location.search);

const STEPS = [
  { key: 'style', label: 'Style & Size' }, { key: 'colors', label: 'Roof & Colors' },
  { key: 'options', label: 'Options' }, { key: 'quote', label: 'Quote' },
];
const stepOf = key => STEPS.findIndex(s => s.key === key);
const QUOTE = stepOf('quote');
const CATS = [
  ['doors', 'Doors'], ['windows', 'Windows'], ['interior', 'Shelves & Loft'], ['electrical', 'Electrical'],
  ['exterior', 'Exterior'], ['upgrades', 'Upgrades'],
];

const state = { catalog: null, config: null, step: 0, maxStep: 0, selected: null, submitted: null, openCats: new Set(['doors']), interior: false };
let scene, optById = {}, uidSeq = 1;

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------
const ICONS = {
  door_single: '<svg viewBox="0 0 32 32"><rect x="9" y="4" width="14" height="25" rx="1"/><circle cx="20" cy="17" r="1"/><rect x="12" y="7" width="8" height="8"/><rect x="12" y="18" width="8" height="8"/></svg>',
  door_glass: '<svg viewBox="0 0 32 32"><rect x="9" y="4" width="14" height="25" rx="1"/><rect x="12" y="7" width="8" height="10"/><path d="M16 7v10M12 12h8"/><circle cx="20" cy="21" r="1"/></svg>',
  door_double: '<svg viewBox="0 0 32 32"><rect x="5" y="5" width="22" height="23"/><path d="M16 5v23M5 5l11 23M16 5l11 23M27 5 16 28M16 5 5 28"/></svg>',
  door_french: '<svg viewBox="0 0 32 32"><rect x="5" y="4" width="22" height="25"/><path d="M16 4v25M8 7h5v19H8zM19 7h5v19h-5zM8 13h5M8 19h5M19 13h5M19 19h5"/></svg>',
  door_rollup: '<svg viewBox="0 0 32 32"><rect x="4" y="5" width="24" height="23"/><path d="M4 9h24M4 13h24M4 17h24M4 21h24M4 25h24"/></svg>',
  window: '<svg viewBox="0 0 32 32"><rect x="7" y="6" width="18" height="20"/><path d="M16 6v20M7 16h18M5 27h22"/></svg>',
  window_shutters: '<svg viewBox="0 0 32 32"><rect x="11" y="7" width="10" height="17"/><path d="M16 7v17M11 15h10M4 7h5v17H4zM23 7h5v17h-5z"/></svg>',
  window_transom: '<svg viewBox="0 0 32 32"><rect x="4" y="11" width="24" height="9"/><path d="M12 11v9M20 11v9"/></svg>',
  vent: '<svg viewBox="0 0 32 32"><path d="M16 5 4 17h24z"/><path d="M11 13h10M9 15h14"/></svg>',
  shelf: '<svg viewBox="0 0 32 32"><path d="M4 12h24M4 22h24M8 12v4M24 12v4M8 22v4M24 22v4"/></svg>',
  workbench: '<svg viewBox="0 0 32 32"><path d="M3 13h26M6 13v14M26 13v14M6 21h20"/><path d="M9 9h5v4M18 7h2v6"/></svg>',
  loft: '<svg viewBox="0 0 32 32"><path d="M4 28V12L16 4l12 8v16M4 15h12v-3M10 15v13M13 19l3-4"/></svg>',
  light: '<svg viewBox="0 0 32 32"><path d="M16 3v7M7 10h18l-3 6H10z"/><path d="M12 20l-2 4M16 20v5M20 20l2 4"/></svg>',
  ext_light: '<svg viewBox="0 0 32 32"><path d="M6 6v12M6 10h12M12 10l-4 0"/><path d="M12 14h12l-3-4h-6z"/><path d="M16 18l-1 3M20 18l1 3"/></svg>',
  outlet: '<svg viewBox="0 0 32 32"><rect x="9" y="5" width="14" height="22" rx="2"/><path d="M14 9v3M18 9v3M14 19v3M18 19v3"/></svg>',
  ramp: '<svg viewBox="0 0 32 32"><path d="M4 26h24V12z"/><path d="M10 22l2 4M16 18l3 8M22 15l3 11"/></svg>',
  cupola: '<svg viewBox="0 0 32 32"><path d="M16 2v5M8 15l8-8 8 8M10 15h12v13H10zM13 18h6v6h-6z"/></svg>',
  flowerbox: '<svg viewBox="0 0 32 32"><path d="M5 18h22l-2 9H7z"/><circle cx="10" cy="13" r="3"/><circle cx="17" cy="11" r="3"/><circle cx="23" cy="14" r="2.5"/></svg>',
  none: '<svg viewBox="0 0 32 32"><rect x="5" y="5" width="22" height="22" rx="5"/><path d="M10 16l4 4 8-8"/></svg>',
};
const iconFor = o => o.image_url ? `<img src="${esc(o.image_url)}" alt="">` : (ICONS[o.kind] || ICONS.none);
const ROOF_ICON = {
  gable: '<svg viewBox="0 0 120 90"><path d="M20 40 60 14l40 26M26 36v42h68V36"/><rect x="50" y="52" width="20" height="26"/><path d="M8 78h104"/></svg>',
  barn: '<svg viewBox="0 0 120 90"><path d="M14 48l14-24 32-12 32 12 14 24M20 44v34h80V44"/><path d="M46 52h28v26H46zM46 52l28 26M74 52 46 78M60 52v26"/><path d="M8 78h104"/></svg>',
  lean_to: '<svg viewBox="0 0 120 90"><path d="M14 22 106 38M20 23v55h80V37"/><rect x="34" y="44" width="16" height="34"/><rect x="60" y="42" width="28" height="9"/><path d="M8 78h104"/></svg>',
  saltbox: '<svg viewBox="0 0 120 90"><path d="M12 46 74 14l34 26M18 43v35h84V37"/><rect x="44" y="52" width="18" height="26"/><path d="M8 78h104"/></svg>',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const S = () => state.catalog.settings || {};
// Dealer-facing configurator (signed-in staff) always shows prices; customers see them only if the setting is on.
const showPrices = () => (state.dealer && !state.customerView) || S().show_prices !== false;
const CV_KEY = 'shedbuilder-customer-view';
const fmt = n => money(n, S().currency_symbol || '$');
const curStyle = () => state.catalog.styles.find(s => s.id === state.config.style_id);
const curSize = () => curStyle()?.sizes.find(z => z.id === state.config.size_id);
const geo = () => shedGeometry(curStyle(), curSize());
const ftIn = v => { const t = Math.round(Number(v || 0) * 12), f = Math.floor(t / 12), i = t - f * 12; return i ? `${f}'-${i}"` : `${f}'`; };
const NO_ROOM_TIP = 'Try another wall, a bigger size, or move or remove something to make space.';
/** Pop-up for things the customer needs to read and acknowledge (e.g. no room for an item). */
function notice(title, text) {
  const d = $('#noticeDlg'); $('#noticeTitle').textContent = title; $('#noticeText').textContent = text;
  state.lastNotice = { title, text, at: Date.now() };
  if (!d.open) { try { d.showModal(); } catch { d.setAttribute('open', ''); } }
}
const sizeTxt = () => { const z = curSize(); return `${z.width}' × ${z.depth}'`; };
const toast = (msg, ms = 2600) => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms); };
const newUid = () => 'u' + Date.now().toString(36) + (uidSeq++);

// ---------------------------------------------------------------------------
// Location-based pricing (dealer lot or ZIP → price tier)
// ---------------------------------------------------------------------------
const LOC_KEY = 'shedbuilder-location';
const mode = () => (state.base?.settings?.pricing_mode || 'none');
function applyTier() {
  const tier = resolveTier(state.base, { dealer_id: state.config?.dealer_id, zip: state.config?.zip });
  state.catalog = tierCatalog(state.base, tier);
  optById = Object.fromEntries(state.catalog.options.map(o => [o.id, o]));
}
function saveLoc() { try { localStorage.setItem(LOC_KEY, JSON.stringify({ dealer_id: state.config.dealer_id || null, zip: state.config.zip || null })); } catch { /* ignore */ } }
function setLocation(patch) {
  if ('dealer_id' in patch) { if (patch.dealer_id) state.config.dealer_id = patch.dealer_id; else delete state.config.dealer_id; }
  if ('zip' in patch) { if (/^\d{5}$/.test(patch.zip || '')) state.config.zip = patch.zip; else delete state.config.zip; }
  saveLoc(); applyTier(); rebuild(); renderPanel();
}
function renderLoc() {
  const m = mode();
  if (m === 'dealer') {
    const dealers = state.base.settings.dealers || [];
    const cur = findDealer(state.base, state.config.dealer_id);
    if (state.lockDealer && cur) return `<div class="locbar"><span>${showPrices() ? 'Pricing for' : 'Your dealer'}</span><b>${esc(cur.name)}</b>${cur.city ? `<small>${esc(cur.city)}${cur.state ? ', ' + esc(cur.state) : ''}</small>` : ''}</div>`;
    return `<div class="locbar ${cur ? '' : 'need'}"><label for="dealerSel">Your dealer lot</label>
      <select id="dealerSel"><option value="">${cur ? '' : 'Choose your nearest lot…'}</option>${dealers.map(d => `<option value="${esc(d.id)}" ${String(d.id) === String(state.config.dealer_id) ? 'selected' : ''}>${esc(d.name)}${d.city ? ' — ' + esc(d.city) + (d.state ? ', ' + esc(d.state) : '') : ''}</option>`).join('')}</select>
      ${cur ? '' : '<small>Prices are for your local lot. Choose one to see your price.</small>'}</div>`;
  }
  if (m === 'zip') {
    const z = state.config.zip || '';
    return `<div class="locbar ${z ? '' : 'need'}"><label for="zipIn">Delivery ZIP code</label>
      <div class="ziprow"><input id="zipIn" inputmode="numeric" autocomplete="postal-code" maxlength="5" placeholder="e.g. 38301" value="${esc(z)}"><button type="button" class="btn ghost sm" data-zipgo>${z ? 'Update' : 'See my price'}</button></div>
      <small>${z ? `Showing prices for ${esc(z)}.` : 'Prices vary by area. Enter your ZIP to see your price.'}</small></div>`;
  }
  return '';
}
$('#panel').addEventListener('change', e => { if (e.target.id === 'dealerSel') setLocation({ dealer_id: e.target.value }); });
$('#panel').addEventListener('keydown', e => { if (e.target.id === 'zipIn' && e.key === 'Enter') { e.preventDefault(); setLocation({ zip: e.target.value.trim() }); } });
$('#panel').addEventListener('input', e => {
  // On the quote form, the delivery ZIP also sets the price tier in ZIP mode
  if (mode() === 'zip' && e.target.name === 'zip' && e.target.closest('#qform')) {
    const v = e.target.value.trim(); if (/^\d{5}$/.test(v) && v !== state.config.zip) setLocation({ zip: v });
  }
});

const avail = o => optionAvailable(curStyle(), o) && o.active !== 0;
const listable = o => avail(o) && !o.package_only;          // parts only sold inside a package aren't listed
const pkgOf = it => it?.package_of && state.config.items.find(x => x.uid === it.package_of);
function pricing() { try { return priceConfig(state.catalog, state.config); } catch { return null; } }
function rebuild() {
  scene.build(state.catalog, state.config);
  renderTotal();
}
let lastTotal = null;
function renderTotal() {
  const p = pricing();
  $('#total').textContent = p ? (showPrices() ? fmt(p.subtotal) : '—') : '—';
  if (p && showPrices() && lastTotal !== null && Math.abs(p.subtotal - lastTotal) >= 0.5) {
    const d = p.subtotal - lastTotal, el = $('#delta');
    el.textContent = (d > 0 ? '+' : '') + fmt(d);
    el.className = 'delta ' + (d > 0 ? 'up' : 'down');
    void el.offsetWidth; el.classList.add('show');
    $('#total').classList.remove('bump'); void $('#total').offsetWidth; $('#total').classList.add('bump');
  }
  if (p) lastTotal = p.subtotal;
  $('#totalLabel').textContent = showPrices() ? 'Your price' : 'Price on request';
}
function optDelta(o, it) {
  // price shown on swap tiles relative to the current slot
  const size = curSize();
  const tmp = { ...state.config, items: [{ uid: 'x', option_id: o.id, wall: it?.wall, standard_of: it?.standard_of || null }] };
  const p = priceConfig(state.catalog, tmp).lines.find(l => l.type === 'option');
  return p ? p.amount : 0;
}

// ---------------------------------------------------------------------------
// Item operations
// ---------------------------------------------------------------------------
function preferredWall(o) {
  if (o.kind === 'vent' || gableMode(o) === 'only') return WALLS.find(w => geo().isGable(w));
  if (o.placement === 'loft') {
    const ends = WALLS.filter(w => geo().isGable(w));
    return ends.find(w => !state.config.items.some(i => i.wall === w && optById[i.option_id]?.placement === 'loft')) || ends[0];
  }
  if (['wall_interior', 'floor'].includes(o.placement)) return geo().W >= geo().D ? 'back' : 'left';
  // the wall facing the camera
  const c = scene.camera.position, a = Math.atan2(c.x, c.z) * 180 / Math.PI;
  if (a > -45 && a <= 45) return 'front';
  if (a > 45 && a <= 135) return 'right';
  if (a < -45 && a >= -135) return 'left';
  return 'back';
}
function addOption(o) {
  const items = state.config.items;
  if (o.placement === 'none') {
    const have = items.find(i => i.option_id === o.id && !i.package_of);
    if (have) return removeItem(have.uid);
    const pk = { uid: newUid(), option_id: o.id, wall: null, offset: 0 };
    items.push(pk);
    if (isPackage(o)) {
      const { added, skipped } = placePackage(state.catalog, curStyle(), curSize(), items, pk);
      items.push(...added);
      if (added.some(a => optById[a.option_id].placement !== 'ceiling') && !state.interior) setInterior(true);
      if (skipped.length) notice(`Not everything in the ${o.name} fits`, `There's no room on this ${sizeTxt()} shed for: ${skipped.join(', ')}.\n\nThe rest of the package has been added. Move or remove something, or pick a bigger size.`);
    }
    rebuild(); renderPanel(); return;
  }
  const count = items.filter(i => i.option_id === o.id && !i.package_of).length;
  if (count >= (o.max_qty || 10)) return toast(`Maximum of ${o.max_qty} for ${o.name}`);
  let spot = null;
  if (o.kind === 'flowerbox') {
    // Prefer to sit under a window that doesn't already have one
    for (const w of items) {
      const wo = optById[w.option_id];
      if (!wo || !String(wo.kind).startsWith('window') || wo.kind === 'window_transom') continue;
      const cand = { uid: '__c', option_id: o.id, wall: w.wall, offset: w.offset };
      if (canPlace(geo(), optById, items, o, cand, '__c')) { spot = { wall: w.wall, offset: w.offset }; break; }
    }
  }
  if (!spot) spot = findSpot(geo(), optById, items, o, preferredWall(o));
  if (!spot) {
    if (o.placement === 'loft') return notice(`No room for another ${o.name}`, `Both end walls of this ${sizeTxt()} shed already have a loft.`);
    const what = o.placement === 'ceiling' ? 'ceiling' : o.placement === 'roof' ? 'roof' : (o.kind === 'vent' || gableMode(o) === 'only') ? 'gable ends' : 'walls';
    return notice(`No room for the ${o.name}`, `There isn't an open spot on the ${what} of this ${sizeTxt()} ${curStyle().name} for the ${o.name}${o.width && o.placement !== 'none' && o.placement !== 'loft' ? ` (${ftIn(o.width)} wide plus its trim)` : ''}.\n\n${NO_ROOM_TIP}`);
  }
  const it = { uid: newUid(), option_id: o.id, wall: spot.wall, offset: spot.offset, ...(spot.gable ? { gable: true } : {}) };
  items.push(it);
  if (['wall_interior', 'loft', 'ceiling'].includes(o.placement) && !state.interior) setInterior(true);
  rebuild(); selectItem(it.uid); renderPanel();
  if (spot.wall && WALLS.includes(spot.wall)) showWall(spot.wall);
}
function removeItem(uid) {
  const it = state.config.items.find(i => i.uid === uid);
  const pk = pkgOf(it);
  if (pk) return notice('Part of a package', `This is included in the ${optById[pk.option_id].name}. You can move it anywhere — to remove it, remove the whole package.`);
  state.config.items = state.config.items.filter(i => i.uid !== uid && i.package_of !== uid);
  if (state.selected === uid) selectItem(null);
  rebuild(); renderPanel();
}
function swapItem(uid, newId) {
  const it = state.config.items.find(i => i.uid === uid); const o = optById[newId];
  if (!it || !o || it.package_of) return;
  const prev = it.option_id, prevW = it.w, prevH = it.h;
  const prevG = it.gable;
  it.option_id = newId; delete it.w; delete it.h;
  if (gableMode(o) === 'only') it.gable = true; else if (gableMode(o) !== 'allow') delete it.gable;
  if (!canPlace(geo(), optById, state.config.items, o, it, uid)) {
    const spot = findSpot(geo(), optById, state.config.items, o, it.wall, it.offset, uid, { gable: it.gable });
    if (!spot) { it.option_id = prev; if (prevW) it.w = prevW; if (prevH) it.h = prevH; if (prevG) it.gable = prevG; else delete it.gable; return notice(`No room for the ${o.name}`, `The ${o.name} is bigger than the ${optById[prev].name} and there's no open spot for it on this ${sizeTxt()} shed.\n\n${NO_ROOM_TIP}`); }
    Object.assign(it, spot); if (!it.gable) delete it.gable;
  }
  rebuild(); selectItem(uid); renderPanel();
}
function moveItem(uid, dir) {
  const it = state.config.items.find(i => i.uid === uid); const o = optById[it.option_id];
  const g = geo();
  for (let step = 0.5; step < 40; step += 0.5) {
    const cand = { ...it, offset: +(it.offset + dir * step).toFixed(2) };
    if (o.placement === 'ceiling') { const lim = (g.ridgeAlongZ ? g.D : g.W) / 2 - 1; if (Math.abs(cand.offset) > lim) break; Object.assign(it, cand); rebuild(); selectItem(uid); return; }
    if (o.placement === 'roof') { if (Math.abs(cand.offset) > g.L / 2 - 1.5) break; Object.assign(it, cand); rebuild(); selectItem(uid); return; }
    if (Math.abs(cand.offset) > g.wallLen(it.wall) / 2) break;
    if (canPlace(g, optById, state.config.items, o, cand, uid)) { it.offset = cand.offset; rebuild(); selectItem(uid); return; }
  }
  toast("Can't move further that way");
}
function moveToWall(uid, wall) {
  const it = state.config.items.find(i => i.uid === uid); const o = optById[it.option_id];
  if (o.kind === 'vent' && !geo().isGable(wall)) return toast('Gable vents only fit on the gable ends');
  if (o.placement === 'loft' && !geo().isGable(wall)) return toast('Lofts go on an end wall');
  if (gableMode(o) === 'only' && !geo().isGable(wall)) return toast(`${o.name} only fits up in a gable end`);
  const wantGable = it.gable && geo().isGable(wall);
  const spot = findSpot(geo(), optById, state.config.items.filter(i => i.uid !== uid), o, wall, 0, uid, { w: it.w, h: it.h, gable: wantGable });
  if (!spot || spot.wall !== wall) return notice(`No room on the ${wall} wall`, `The ${o.name} doesn't fit on the ${wall} wall — there isn't an open space wide enough${o.placement === 'opening' ? ' (including its trim)' : ''}.\n\n${NO_ROOM_TIP}`);
  Object.assign(it, spot); if (!it.gable) delete it.gable;
  if (['wall_interior', 'loft'].includes(o.placement) && !state.interior) setInterior(true);
  rebuild(); selectItem(uid); showWall(wall); renderPanel();
}
/** Make sure every item still fits after a style/size change; move or drop what doesn't. */
function setGable(uid, on) {
  const it = state.config.items.find(i => i.uid === uid); if (!it) return; const o = optById[it.option_id];
  if (on && (!WALLS.includes(it.wall) || !geo().isGable(it.wall) || gableMode(o) !== 'allow')) return;
  const cand = { ...it, gable: on || undefined };
  if (!canPlace(geo(), optById, state.config.items, o, cand, uid)) {
    const spot = findSpot(geo(), optById, state.config.items, o, it.wall, it.offset, uid, { w: it.w, h: it.h, gable: on });
    if (!spot || spot.wall !== it.wall || !!spot.gable !== on) return notice(on ? 'Not enough room in the gable' : `No room on the ${it.wall} wall`, on
      ? `The ${o.name} is too big to fit up in the gable of this ${sizeTxt()} ${curStyle().name}${it.wall ? '' : ''}, or something else is already there.\n\nTry a smaller gable window or a larger shed.`
      : `There's no open spot on the ${it.wall} wall for the ${o.name}.\n\n${NO_ROOM_TIP}`);
    Object.assign(cand, spot);
  }
  Object.assign(it, cand); if (!it.gable) delete it.gable;
  rebuild(); selectItem(uid); renderPanel();
}
function fitItems(announce) {
  const g = geo(); const keep = [], moved = [], dropped = [];
  for (const it of state.config.items) {
    const o = optById[it.option_id];
    if (!o) continue; // option no longer exists
    if (it.package_of && !state.config.items.some(x => x.uid === it.package_of)) continue; // its package was removed
    if (it.gable && !(WALLS.includes(it.wall) && g.isGable(it.wall) && gableMode(o) === 'allow')) delete it.gable;
    if (!it.package_of && !avail(o) && !(it.standard_of && it.standard_of === it.option_id)) { dropped.push(o.name + ' (not offered on this style)'); continue; }
    const wallOk = !(o.placement === 'loft' && !g.isGable(it.wall));
    if (!it.wall || !WALLS.includes(it.wall) || (wallOk && canPlace(g, optById, keep, o, it, it.uid))) { keep.push(it); continue; }
    const spot = findSpot(g, optById, keep, o, it.wall, it.offset, it.uid, { w: it.w, h: it.h, elev: it.elev, gable: it.gable && g.isGable(it.wall) });
    if (spot) { const n = { ...it, ...spot }; if (!n.gable) delete n.gable; keep.push(n); if (spot.wall !== it.wall) moved.push(`${o.name} → ${spot.wall} wall`); }
    else dropped.push(o.name);
  }
  const keepUids = new Set(keep.map(i => i.uid));
  state.config.items = keep.filter(i => !i.package_of || keepUids.has(i.package_of));
  if (dropped.length) notice('Some items no longer fit', `There's no room for ${dropped.length === 1 ? 'this item' : 'these items'} on the ${sizeTxt()} ${curStyle().name}, so ${dropped.length === 1 ? 'it was' : 'they were'} removed:\n\n• ${dropped.join('\n• ')}${moved.length ? `\n\nMoved to fit: ${moved.join(', ')}` : ''}`);
  else if (announce && moved.length) toast('Moved to fit: ' + moved.join(', '), 5000);
}

// ---- Drag & drop: called continuously while an item is dragged on the 3D model
let dragQueued = null;
function dragItem(uid, hit) {
  $('#viewport').classList.add('dragging');
  const it = state.config.items.find(i => i.uid === uid); if (!it) return;
  const o = optById[it.option_id]; const g = geo();
  let { wall, offset } = hit;
  offset = Math.round(offset * 4) / 4; // snap to 3"
  if (o.placement === 'ceiling' || o.placement === 'roof') {
    const lim = o.placement === 'ceiling' ? (g.ridgeAlongZ ? g.D : g.W) / 2 - 1 : g.L / 2 - 1.5;
    if (o.placement === 'ceiling' && wall !== 'ceiling') return;
    if (o.placement === 'roof' && wall !== 'roof') return;
    offset = Math.max(-lim, Math.min(lim, offset));
    // ceiling/roof offsets run along the ridge; front/back camera axis flips sign
    if (offset === it.offset) return;
    it.offset = offset; queueRebuild(uid); return;
  }
  if (!WALLS.includes(wall)) return;
  if ((o.kind === 'vent' || gableMode(o) === 'only') && !g.isGable(wall)) return;
  if (o.placement === 'loft') { if (wall === it.wall || !g.isGable(wall)) return; if (state.config.items.some(i => i.uid !== uid && i.wall === wall && optById[i.option_id]?.placement === 'loft')) return; it.wall = wall; it.offset = 0; queueRebuild(uid); return; }
  // clamp into the wall so dragging past a corner edge still slides it to the end
  const gable = it.gable && g.isGable(wall) ? true : undefined;
  offset = resolvePlacement(g, o, { ...it, wall, offset, gable }).offset;
  if (wall === it.wall && offset === it.offset) return;
  const cand = { ...it, wall, offset, gable };
  if (!canPlace(g, optById, state.config.items, o, cand, uid)) { // blocked: stay at last good spot
    if (Date.now() - (dragItem.warned || 0) > 2500) { dragItem.warned = Date.now(); toast(`No room there for the ${o.name}`); }
    return;
  }
  it.wall = wall; it.offset = offset; if (gable) it.gable = true; else delete it.gable; queueRebuild(uid);
}
function queueRebuild(uid) {
  if (dragQueued) return;
  dragQueued = requestAnimationFrame(() => { dragQueued = null; rebuild(); scene.select(uid); });
}
function renderPanelIfOptions() { if (STEPS[state.step].key === 'options') renderPanel(); }

function showWall(wall) {
  const v = state.interior ? 'in_' + wall : wall;
  scene.view(v); document.querySelectorAll('#views button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
}

// ---------------------------------------------------------------------------
// Selected item card
// ---------------------------------------------------------------------------
function selectItem(uid) {
  state.selected = uid; scene.select(uid);
  const card = $('#itemcard');
  const it = uid && state.config.items.find(i => i.uid === uid);
  if (!it) { card.hidden = true; return; }
  const o = optById[it.option_id];
  const pk = pkgOf(it);
  const alts = pk ? [o] : state.catalog.options.filter(x => (listable(x) || x.id === o.id) && (o.swap_group ? x.swap_group === o.swap_group : (x.category === o.category && x.placement === o.placement)));
  const isStd = it.standard_of && it.standard_of === it.option_id;
  const price = optDelta(o, it);
  const isLoft = o.placement === 'loft';
  const wallable = ['opening', 'wall_interior', 'wall_exterior', 'ground'].includes(o.placement);
  const movable = !isLoft;
  const ends = WALLS.filter(w => geo().isGable(w));
  const loftOn = w => state.config.items.some(i => i.uid !== uid && i.wall === w && optById[i.option_id]?.placement === 'loft');
  const p0 = pricing(); const removedCredit = it.standard_of && S().remove_credit !== false
    ? (() => { try { const c = { ...state.config, items: state.config.items.filter(i => i.uid !== uid) }; return priceConfig(state.catalog, c).subtotal - p0.subtotal; } catch { return 0; } })() : 0;
  card.innerHTML = `
    <div class="ic-head"><div><div class="ic-title">${esc(o.name)}</div>
      <div class="ic-meta">${pk ? `Included in the ${esc(optById[pk.option_id].name)}` : isStd ? 'Included standard' : (showPrices() ? (price < 0 ? fmt(price) + ' credit' : '+' + fmt(price)) : '')}${it.wall && WALLS.includes(it.wall) ? ' · ' + it.wall + ' wall' : ''}</div></div>
      <button class="x" data-act="close" aria-label="Close">&times;</button></div>
    ${alts.length > 1 ? `<div class="ic-label">${it.standard_of ? 'Upgrade or change' : 'Change to'}</div>
    <div class="swaps">${alts.map(a => {
      const d = optDelta(a, it) - price;
      const tag = a.id === o.id ? (isStd ? 'Included' : 'Selected') : (Math.abs(d) < 0.5 ? 'Same price' : (d > 0 ? '+' : '') + fmt(d));
      return `<button class="swap ${a.id === o.id ? 'on' : ''}" data-swap="${a.id}"><div class="ico">${iconFor(a)}</div><b>${esc(a.name)}</b>${showPrices() ? `<span class="${d < -0.4 ? 'neg' : ''}">${tag}</span>` : ''}</button>`;
    }).join('')}</div>` : ''}
    ${isLoft ? `<div class="ic-label">Which end?</div><div class="ic-row"><div class="walls">${ends.map(w => `<button data-wall="${w}" class="${it.wall === w ? 'on' : ''}" ${loftOn(w) ? 'disabled title="There is already a loft on this end"' : ''}>${w} end</button>`).join('')}</div></div>` : ''}
    ${(wallable || movable) ? `<div class="ic-label">Position</div><div class="ic-row">
      ${wallable ? `<div class="walls">${WALLS.map(w => { const no = gableMode(o) === 'only' && !geo().isGable(w); return `<button data-wall="${w}" class="${it.wall === w ? 'on' : ''}" ${no ? 'disabled title="Gable ends only"' : ''}>${w}</button>`; }).join('')}</div>` : ''}
      ${movable ? `<div class="mv"><button data-move="-1" aria-label="Move left"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button><button data-move="1" aria-label="Move right"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button></div>` : ''}
    </div>` : ''}
    ${gableMode(o) === 'allow' && geo().isGable(it.wall) ? `<div class="ic-label">Height</div><div class="walls"><button data-gable="0" class="${it.gable ? '' : 'on'}">On the wall</button><button data-gable="1" class="${it.gable ? 'on' : ''}">Up in the gable</button></div>` : ''}
    ${gableMode(o) === 'only' ? `<div class="ic-meta" style="margin-top:8px">Sits up in the gable end.</div>` : ''}
    <div class="ic-foot">${pk ? '<span class="ic-meta">Drag it or use the arrows to move it</span>' : `<button class="link-danger" data-act="remove">Remove${removedCredit && showPrices() ? ` (${fmt(removedCredit)})` : ''}</button>`}
      <button class="btn primary sm" data-act="close">Done</button></div>`;
  card.hidden = false;
}
$('#itemcard').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const uid = state.selected;
  if (b.dataset.act === 'close') selectItem(null);
  else if (b.dataset.act === 'remove') removeItem(uid);
  else if (b.dataset.swap) swapItem(uid, Number(b.dataset.swap));
  else if (b.dataset.wall) moveToWall(uid, b.dataset.wall);
  else if (b.dataset.move) moveItem(uid, Number(b.dataset.move));
  else if (b.dataset.gable !== undefined) setGable(uid, b.dataset.gable === '1');
});

// ---------------------------------------------------------------------------
// Panel steps
// ---------------------------------------------------------------------------
function renderSteps() {
  $('#steps').innerHTML = STEPS.map((s, i) => `<button data-step="${i}" class="${i === state.step ? 'on' : ''} ${i < state.maxStep || (state.submitted && i < QUOTE) ? 'done' : ''}" ${i > state.maxStep ? 'disabled' : ''}><span class="n">${i + 1}</span><span class="lbl">${s.label}</span></button>`).join('');
}
$('#steps').addEventListener('click', e => { const b = e.target.closest('button[data-step]'); if (b && !b.disabled) go(Number(b.dataset.step)); });

function go(i) {
  if (i === QUOTE) selectItem(null);
  state.step = Math.max(0, Math.min(STEPS.length - 1, i));
  state.maxStep = Math.max(state.maxStep, state.step);
  renderSteps(); renderPanel();
  $('#panel').scrollTop = 0;
  if (window.innerWidth <= 900) window.scrollTo({ top: 0, behavior: 'smooth' });
}
$('#next').onclick = () => { if (state.step === QUOTE) return submitQuote(); go(state.step + 1); };
$('#back').onclick = () => go(state.step - 1);

function renderPanel() {
  const key = STEPS[state.step].key;
  const el = $('#panel');
  $('#back').style.visibility = state.step === 0 ? 'hidden' : 'visible';
  $('#next').innerHTML = state.step === QUOTE ? quoteBtnLabel() : `<span>Next<span class="next-long">: ${esc(STEPS[state.step + 1]?.label || '')}</span></span>`;
  $('#next').hidden = !!(state.step === QUOTE && state.submitted);
  const keep = {}; const f0 = el.querySelector('#qform');
  if (f0) for (const i of f0.elements) if (i.name) keep[i.name] = i.type === 'checkbox' ? i.checked : i.value;
  const loc = state.submitted ? '' : renderLoc();
  if (key === 'style') el.innerHTML = loc + renderStyle() + renderSize();
  if (key === 'colors') el.innerHTML = loc + renderColors();
  if (key === 'options') el.innerHTML = loc + renderOptions();
  if (key === 'quote') el.innerHTML = state.submitted ? renderDone() : loc + renderQuote();
  const f1 = el.querySelector('#qform');
  if (f1) {
    for (const [k, v] of Object.entries(keep)) { const i = f1.elements[k]; if (i) i.type === 'checkbox' ? (i.checked = v) : (i.value = v); }
    if (mode() === 'zip' && state.config.zip && !f1.elements.zip.value) f1.elements.zip.value = state.config.zip;
  }
  renderTotal();
}

function renderStyle() {
  const cur = curStyle();
  return `<h2>${esc(S().headline || 'Choose a style & size')}</h2><p class="sub">Pick a style and a size to start. You can change anything later.</p>
  <h3>Style</h3><div class="cards">${state.catalog.styles.map(s => {
    const from = Math.min(...s.sizes.map(z => z.price));
    return `<button class="card ${s.id === cur.id ? 'on' : ''}" data-style="${s.id}">
      <div class="thumb">${s.image_url ? `<img src="${esc(s.image_url)}" alt="">` : (ROOF_ICON[s.roof_type] || ROOF_ICON.gable)}</div>
      <div class="ct"><b>${esc(s.name)}</b><small>${showPrices() ? `From <strong>${fmt(from)}</strong>` : `${s.sizes.length} sizes`}</small></div></button>`;
  }).join('')}</div>
  ${cur.description ? `<p class="desc">${esc(cur.description)}</p>` : ''}`;
}
function renderSize() {
  const st = curStyle();
  return `<h3 id="sizeHead">${esc(st.name)} sizes</h3><p class="sub" style="margin-top:-4px">Width × depth — the front wall is the width.</p>
  <div class="sizes">${st.sizes.map(z => `<button class="size ${z.id === state.config.size_id ? 'on' : ''}" data-size="${z.id}">
    <b>${z.width}' × ${z.depth}'</b><small>${z.width * z.depth} sq ft</small>${showPrices() ? `<span>${fmt(z.price)}</span>` : ''}</button>`).join('')}</div>`;
}
const ROOF_ICONS = {
  shingle: '<svg viewBox="0 0 48 32"><path d="M2 8h44M2 16h44M2 24h44"/><path d="M8 8v8M18 8v8M30 8v8M40 8v8M13 16v8M25 16v8M35 16v8M6 24v6M20 24v6M32 24v6M42 24v6"/></svg>',
  metal: '<svg viewBox="0 0 48 32"><path d="M2 4v24M14 4v24M26 4v24M38 4v24"/><path d="M6 4v24M10 4v24M18 4v24M22 4v24M30 4v24M34 4v24M42 4v24" stroke-width="0.8"/><circle cx="14" cy="10" r="1"/><circle cx="26" cy="10" r="1"/><circle cx="38" cy="10" r="1"/><circle cx="14" cy="22" r="1"/><circle cx="26" cy="22" r="1"/><circle cx="38" cy="22" r="1"/></svg>',
};
function roofDelta(mat) {
  const st = curStyle(), z = curSize();
  const std = roofingList(state.catalog).find(r => r.key === st.roof_material);
  if (!std || std.key === mat.key) return 0;
  const d = roofMaterialPrice(mat, st, z) - roofMaterialPrice(std, st, z);
  return Math.round(S().downgrade_credit === false ? Math.max(0, d) : d);
}
function renderColors() {
  const groups = [['siding', 'Siding'], ['trim', 'Trim'], ['roof', 'Roof color'], ['door', 'Doors'], ['window', 'Windows']]
    .filter(([k]) => colorGroupEnabled(state.catalog, k));
  const cs = state.catalog.colors;
  const choices = roofChoices(state.catalog, curStyle());
  let html = `<h2>${choices.length > 1 ? 'Roofing &amp; colors' : 'Colors'}</h2><p class="sub">Tap an option — the 3D shed updates instantly.</p>`;
  if (choices.length > 1) {
    html += `<h3>Roofing</h3><div class="roofs">${choices.map(r => {
      const d = roofDelta(r);
      return `<button class="roofopt ${r.key === state.config.roof_material ? 'on' : ''}" data-roofmat="${esc(r.key)}"><span class="ri">${ROOF_ICONS[r.key] || ROOF_ICONS.shingle}</span><span class="rt"><b>${esc(r.name)}</b>${r.description ? `<small>${esc(r.description)}</small>` : ''}</span>${showPrices() ? `<em class="${d < 0 ? 'neg' : ''}">${d ? (d > 0 ? '+' : '') + fmt(d) : 'Included'}</em>` : ''}</button>`;
    }).join('')}</div>`;
  }
  html += groups.map(([k, label]) => {
    const list = k === 'roof' ? roofColorsFor(state.catalog, state.config.roof_material) : cs.filter(c => c.category === k && c.active !== 0);
    if (!list.length) return '';
    const sel = list.find(c => c.id === state.config.colors[k]);
    return `<h3>${label}</h3><p class="chosen">${sel ? `<b>${esc(sel.name)}</b>${sel.price && showPrices() ? ' · +' + fmt(sel.price) : ''}` : ''}</p>
    <div class="swatches">${list.map(c => `<button class="sw ${c.id === state.config.colors[k] ? 'on' : ''}" data-color="${k}:${c.id}" title="${esc(c.name)}"><i style="background:${esc(c.hex)}"></i>${esc(c.name)}${c.price && showPrices() ? `<em>+${fmt(c.price)}</em>` : ''}</button>`).join('')}</div>`;
  }).join('');
  return html;
}
function setRoofMaterial(key) {
  state.config.roof_material = key;
  const ok = roofColorsFor(state.catalog, key);
  if (!ok.some(c => c.id === state.config.colors.roof)) state.config.colors.roof = ok[0]?.id ?? state.config.colors.roof;
}
function renderOptions() {
  const items = state.config.items;
  const onShed = items.filter(i => optById[i.option_id]?.placement !== 'none');
  const counts = {}; for (const i of items) if (!i.package_of) counts[i.option_id] = (counts[i.option_id] || 0) + 1;
  const size = curSize();
  let html = `<h2>Add options</h2><p class="sub">Standard items are already on your shed. Click anything on the 3D model to upgrade, move or remove it.</p>`;
  if (onShed.length) html += `<h3>On your shed</h3><div class="onshed">${onShed.map(i => { const o = optById[i.option_id]; return `<button class="${i.standard_of || i.package_of ? 'std' : ''}" data-sel="${i.uid}" ${i.package_of ? `title="Included in the ${esc(optById[pkgOf(i)?.option_id]?.name || 'package')}"` : ''}>${esc(o.name)}${i.wall && WALLS.includes(i.wall) ? ` · ${i.wall}` : ''}</button>`; }).join('')}</div>`;
  for (const [cat, label] of CATS) {
    const list = state.catalog.options.filter(o => o.category === cat && listable(o));
    if (!list.length) continue;
    const n = list.reduce((s, o) => s + (counts[o.id] || 0), 0);
    html += `<div class="acc ${state.openCats.has(cat) ? 'open' : ''}" data-cat="${cat}"><button data-acc="${cat}">${esc(label)}${n ? `<span class="cnt">${n}</span>` : ''}<svg class="chev" viewBox="0 0 24 24" ${n ? '' : 'style="margin-left:auto"'}><path d="M6 9l6 6 6-6"/></svg></button><div class="acc-body">`;
    for (const o of list) {
      const c = counts[o.id] || 0;
      const pr = (() => { try { return priceConfig(state.catalog, { ...state.config, items: [{ uid: 'p', option_id: o.id, wall: 'back' }] }).lines.find(l => l.type === 'option')?.amount ?? 0; } catch { return o.price; } })();
      const unit = { per_sqft: ` (${fmt(o.price)}/sq ft)`, per_ft_wall: ` (${fmt(o.price)}/ft)`, per_ft_width: ` (${fmt(o.price)}/ft)` }[o.price_unit] || '';
      const incl = isPackage(o) ? o.package_items.map(pi => { const x = optById[pi.option_id]; return x ? `${Number(pi.qty) > 1 ? pi.qty + ' × ' : ''}${x.name}` : ''; }).filter(Boolean).join(' · ') : '';
      html += `<div class="opt"><div class="ico">${iconFor(o)}</div><div class="meta"><b>${esc(o.name)}</b>${o.description ? `<small>${esc(o.description)}</small>` : ''}${incl ? `<small class="incl">Includes: ${esc(incl)}</small>` : ''}${showPrices() ? `<span class="p">${fmt(pr)}${unit}</span>` : ''}</div>`;
      if (o.placement === 'none') html += `<button class="tog ${c ? 'on' : ''}" data-toggle="${o.id}" aria-label="Toggle ${esc(o.name)}"></button>`;
      else html += `<div class="qty">${c ? `<button data-dec="${o.id}" aria-label="Remove one">−</button><span>${c}</span>` : ''}<button class="add" data-add="${o.id}" aria-label="Add ${esc(o.name)}">+</button></div>`;
      html += `</div>`;
    }
    html += `</div></div>`;
  }
  return html;
}
function renderQuote() {
  const p = pricing();
  const sp = showPrices();
  const lines = p.lines.filter(l => l.type !== 'color' || l.amount);
  const st = S();
  const pf = state.pos ? posPrefill() : {};
  const v = k => (pf[k] ? ` value="${esc(pf[k])}"` : '');
  const head = state.pos
    ? `<h2>Save this design</h2><p class="sub">${pf.first_name ? `It goes back to the contract for <b>${esc([pf.first_name, pf.last_name].filter(Boolean).join(' '))}</b>.` : 'Enter the customer, then save. It goes straight back to the contract.'} Nothing is sent to the customer.</p>`
    : `<h2>Your quote</h2><p class="sub">Review your shed and tell us where to send your quote.</p>`;
  return `${head}
  <div class="lines">${lines.map(l => `<div class="line"><div>${esc(l.label)}${l.note ? `<small>${esc(l.note)}</small>` : ''}${l.wall && WALLS.includes(l.wall) ? `<small>${esc(l.wall)} wall</small>` : ''}</div><div class="${l.amount < 0 ? 'neg' : ''}">${sp ? (l.note === 'Standard' ? 'Included' : fmt(l.amount)) : ''}</div></div>`).join('')}
  ${sp && p.delivery ? `<div class="line"><div>Delivery</div><div>${fmt(p.delivery)}</div></div>` : ''}
  ${sp && p.tax ? `<div class="line"><div>Tax (${p.tax_rate}%)</div><div>${fmt(p.tax)}</div></div>` : ''}
  ${sp ? `<div class="line tot"><div>Total</div><div>${fmt(p.total)}</div></div>` : ''}
  ${p.dealer ? `<div class="line"><div><small>Dealer lot</small>${esc(p.dealer.name)}</div><div></div></div>` : ''}</div>
  <form class="form" id="qform" novalidate>
    <div class="field"><label>First name *</label><input name="first_name" autocomplete="given-name" required${v('first_name')}></div>
    <div class="field"><label>Last name</label><input name="last_name" autocomplete="family-name"${v('last_name')}></div>
    <div class="field full"><label>Email${state.pos ? '' : ' *'}</label><input name="email" type="email" autocomplete="email" ${state.pos ? '' : 'required'}${v('email')}></div>
    <div class="field full"><label>Phone${st.require_phone && !state.pos ? ' *' : ''}</label><input name="phone" type="tel" autocomplete="tel" ${st.require_phone && !state.pos ? 'required' : ''}${v('phone')}></div>
    <div class="field full"><label>Delivery address</label><input name="address" autocomplete="street-address"${v('address')}></div>
    <div class="field"><label>City</label><input name="city" autocomplete="address-level2"${v('city')}></div>
    <div class="field"><label>State / ZIP</label><div style="display:flex;gap:6px"><input name="state" autocomplete="address-level1" style="width:40%" maxlength="20"${v('state')}><input name="zip" autocomplete="postal-code" inputmode="numeric" style="width:60%"${v('zip')}></div></div>
    <div class="field full"><label>${state.pos ? 'Notes for this design' : 'Anything else we should know?'}</label><textarea name="notes" placeholder="${state.pos ? 'Optional' : 'Site details, timeline, questions…'}"></textarea></div>
    ${st.consent_text && !state.pos ? `<label class="consent full"><input type="checkbox" name="sms_consent">${esc(st.consent_text)}${st.privacy_url ? ` <a href="${esc(st.privacy_url)}" target="_blank" rel="noopener">Privacy policy</a>` : ''}</label>` : ''}
    <div class="err full" id="qerr" hidden></div>
  </form>`;
}
function renderDone() {
  const q = state.submitted;
  return `<div class="done"><div class="ok"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></div>
    <h2>Quote sent!</h2><p class="sub">${esc(S().success_message || 'Thanks! We will be in touch shortly.')}</p>
    <div class="qn">Quote ${esc(q.number)}${showPrices() && q.pricing && !q.pricing.hidden ? ' · ' + fmt(q.pricing.total) : ''}</div>
    <div class="stack">
      ${state.dealer && posOn() && q.id && ['admin', 'sales'].includes(state.dealer.role) && /^\d+$/.test(params.get('revise') || '') ? `<a class="btn primary block" href="${ADMIN_URL}#/pos/revise/${params.get('revise')}?quote=${encodeURIComponent(q.id)}"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>Update the contract with this design</a>` : ''}
      ${state.dealer && posOn() && q.id && !params.get('revise') && ['admin', 'sales'].includes(state.dealer.role) ? `<a class="btn primary block" href="${ADMIN_URL}#/pos/new?quote=${encodeURIComponent(q.id)}${q.contact_id ? '&contact=' + q.contact_id : ''}"><svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 17l2-2 2 1 4-4"/></svg>Write it up — start a contract</a>` : ''}
      <button class="btn ghost block" data-dl="glb"><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v3h16v-3"/></svg>Download 3D model (.glb)</button>
      ${S().customer_pdf !== false ? `<button class="btn primary block" data-dl="quotepdf"><svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 18v-6m0 6-3-3m3 3 3-3"/></svg>${showPrices() ? 'Download quote PDF' : 'Download design PDF'}</button>` : ''}
      <button class="btn ghost block" data-dl="plan"><svg viewBox="0 0 24 24"><path d="M3 3h18v18H3zM3 12h7M14 3v7M14 14v7"/></svg>View / print floor plan</button>
      <button class="btn ghost block" data-dl="link"><svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>Copy link to my design</button>
    </div></div>`;
}

$('#panel').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const d = b.dataset;
  if (d.style) {
    const id = Number(d.style); if (id === state.config.style_id) return;
    const old = curSize(); const st = state.catalog.styles.find(s => s.id === id);
    const near = st.sizes.reduce((a, z) => (Math.abs(z.width * z.depth - old.width * old.depth) < Math.abs(a.width * a.depth - old.width * old.depth) ? z : a), st.sizes[0]);
    const keepColors = state.config.colors, keepRoof = state.config.roof_material;
    const keepLoc = { dealer_id: state.config.dealer_id, zip: state.config.zip };
    state.config = defaultConfig(state.catalog, id, near.id);
    for (const [k, v] of Object.entries(keepLoc)) if (v) state.config[k] = v;
    if (state.maxStep >= stepOf('colors')) {
      state.config.colors = { ...keepColors };
      if (roofChoices(state.catalog, st).some(r => r.key === keepRoof)) state.config.roof_material = keepRoof;
      setRoofMaterial(state.config.roof_material);
    }
    fitItems(false);
    selectItem(null); rebuild(); renderPanel();
    $('#sizeHead')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else if (d.size) {
    state.config.size_id = Number(d.size);
    fitItems(true);
    rebuild(); renderPanel();
  } else if (d.roofmat) {
    setRoofMaterial(d.roofmat); rebuild(); renderPanel();
  } else if (d.color) {
    const [k, id] = d.color.split(':'); state.config.colors[k] = Number(id); rebuild(); renderPanel();
  } else if (d.acc) {
    state.openCats.has(d.acc) ? state.openCats.delete(d.acc) : state.openCats.add(d.acc); b.parentElement.classList.toggle('open');
  } else if (d.add) addOption(optById[d.add]);
  else if (d.toggle) addOption(optById[d.toggle]);
  else if (d.dec) {
    const list = state.config.items.filter(i => i.option_id === Number(d.dec) && !i.package_of);
    const nonStd = list.filter(i => !i.standard_of); removeItem((nonStd.at(-1) || list.at(-1)).uid);
  } else if (d.sel) { selectItem(d.sel); const it = state.config.items.find(i => i.uid === d.sel); if (it && WALLS.includes(it.wall)) showWall(it.wall); }
  else if (d.zipgo !== undefined) setLocation({ zip: ($('#zipIn')?.value || '').trim() });
  else if (d.dl === 'glb') downloadGLB();
  else if (d.dl === 'quotepdf') downloadQuotePDF(b);
  else if (d.dl === 'plan') openPlan();
  else if (d.dl === 'link') {
    const link = new URL(state.submitted.links?.view_3d || `/?q=${state.submitted.token}`, location.href).href;
    if (!navigator.clipboard) notice('Your design link', link);
    else navigator.clipboard.writeText(link).then(() => toast('Link copied'), () => notice('Your design link', link));
  }
});

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------
async function submitQuote() {
  const f = $('#qform'); const err = $('#qerr');
  const data = Object.fromEntries(new FormData(f).entries());
  data.sms_consent = !!f.querySelector('[name=sms_consent]')?.checked;
  if (state.pos) { // sales rep saving a design for a contract: name + (contact on file, email or mobile)
    if (!String(data.first_name || '').trim()) { err.textContent = "Enter the customer's first name."; err.hidden = false; f.querySelector('[name=first_name]')?.focus(); return; }
    if (!state.pos.contact && !state.pos.contactId && !String(data.email || '').trim() && !String(data.phone || '').trim()) { err.textContent = "Enter the customer's email or mobile."; err.hidden = false; f.querySelector('[name=email]')?.focus(); return; }
    if (String(data.email || '').trim() && !/^\S+@\S+\.\S+$/.test(data.email)) { err.textContent = 'Please enter a valid email.'; err.hidden = false; f.querySelector('[name=email]')?.focus(); return; }
  } else {
  const need = ['first_name', 'email', ...(S().require_phone ? ['phone'] : [])];
  const miss = need.filter(k => !String(data[k] || '').trim());
  if (miss.length || !/^\S+@\S+\.\S+$/.test(data.email || '')) {
    err.textContent = miss.length ? 'Please fill in the required fields.' : 'Please enter a valid email.'; err.hidden = false;
    (f.querySelector(`[name=${miss[0] || 'email'}]`))?.focus(); return;
  }
  }
  if (mode() === 'dealer' && !findDealer(state.base, state.config.dealer_id)) {
    err.textContent = 'Please choose your dealer lot at the top so we can price your shed.'; err.hidden = false; $('#dealerSel')?.focus(); return;
  }
  if (mode() === 'zip' && !state.config.zip) {
    err.textContent = 'Please enter your 5-digit delivery ZIP code.'; err.hidden = false; f.querySelector('[name=zip]')?.focus(); return;
  }
  const btn = $('#next'); btn.disabled = true; btn.textContent = 'Sending…';
  const utm = {}; for (const [k, v] of params) if (k.startsWith('utm_') || k === 'gclid' || k === 'fbclid') utm[k] = v;
  try {
    const body = { config: state.config, customer: data, utm, source: params.get('source') || document.referrer || 'configurator' };
    // the contact id is kept even when the CRM is off (the lookup above fails), so the design stays on the same customer
    if (state.pos) Object.assign(body, { pos: true, contact_id: state.pos.contact?.id || state.pos.contactId || null, source: 'Point of sale' });
    const r = await fetch('/api/v1/quotes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Something went wrong');
    if (state.pos) { state.submitted = j; btn.textContent = 'Saved — opening the contract…'; posReturn(j.id); return; }
    const u = new URL(j.links.view_3d, location.href);
    j.token = u.searchParams.get('q') || (u.hash.match(/^#q-([a-f0-9]+)/) || [])[1];
    state.submitted = j;
    try { window.parent !== window && window.parent.postMessage({ type: 'shedbuilder:quote', quote: j }, '*'); } catch { /* ignore */ }
    history.replaceState(null, '', `?q=${j.token}`);
    renderSteps(); renderPanel();
    if (S().thank_you_url) setTimeout(() => { (window.top || window).location.href = S().thank_you_url + (S().thank_you_url.includes('?') ? '&' : '?') + 'quote=' + encodeURIComponent(j.number); }, 2500);
  } catch (e) { err.textContent = e.message; err.hidden = false; }
  finally { btn.disabled = false; if (!state.submitted) btn.textContent = quoteBtnLabel(); }
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------
function fileBase() { const q = state.submitted; const st = curStyle(), z = curSize(); return (q ? q.number + '-' : '') + `${st.name}-${z.width}x${z.depth}`.replace(/[^a-z0-9-]+/gi, '-'); }
function saveBlob(blob, name) { if (window.__shedSave) return window.__shedSave(blob, name); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
async function downloadQuotePDF(btn) {
  const q = state.submitted; if (!q) return;
  const label = btn.innerHTML; btn.disabled = true; btn.textContent = 'Building your PDF…';
  try {
    const p = pricing();
    const quote = { ...q, config: state.config, pricing_lines: p.lines, pricing: { ...(q.pricing || {}), tax_rate: p.tax_rate },
      created_at: new Date().toISOString().replace('T', ' ').slice(0, 19), dealer: p.dealer || q.dealer || null };
    const priced = showPrices() && q.pricing && !q.pricing.hidden;
    const blob = await buildDrawingPackage(state.catalog, quote, { company: S().company_name || '', withPricing: priced, terms: priced ? S().quote_terms || '' : '', money: fmt });
    saveBlob(blob, `${q.number}-${priced ? 'quote' : 'design'}.pdf`); toast(priced ? 'Quote PDF downloaded' : 'Design PDF downloaded');
  } catch (e) { console.error(e); toast('Could not build the PDF'); }
  finally { btn.disabled = false; btn.innerHTML = label; }
}
async function downloadGLB() {
  toast('Preparing 3D model…');
  try { saveBlob(await scene.exportGLB(), fileBase() + '.glb'); toast('3D model downloaded (.glb)'); }
  catch (e) { console.error(e); toast('Could not export model'); }
}
function planSVG() {
  const q = state.submitted;
  return floorPlanSVG(state.catalog, state.config, { customer: q ? q.customer : {}, quote_number: q?.number });
}
function openPlan() { $('#planBox').innerHTML = planSVG(); $('#planDlg').showModal(); }
$('#btnPlan').onclick = openPlan;
$('#btnGlb').onclick = downloadGLB;
$('#planSvg').onclick = () => saveBlob(new Blob([planSVG()], { type: 'image/svg+xml' }), fileBase() + '-floor-plan.svg');
$('#planPrint').onclick = () => window.print();
document.querySelectorAll('[data-close]').forEach(b => (b.onclick = () => b.closest('dialog').close()));

// ---------------------------------------------------------------------------
// Viewport controls
// ---------------------------------------------------------------------------
function setInterior(on) {
  state.interior = on; scene.setInterior(on);
  document.querySelectorAll('#viewMode button').forEach(b => b.classList.toggle('on', (b.dataset.mode === 'int') === on));
  scene.view(on ? 'inside' : 'front34');
  document.querySelectorAll('#views button').forEach(b => b.classList.toggle('on', b.dataset.v === (on ? '' : 'front34')));
}
$('#viewMode').onclick = e => { const b = e.target.closest('button'); if (b) setInterior(b.dataset.mode === 'int'); };
$('#views').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  scene.view(b.dataset.v); document.querySelectorAll('#views button').forEach(x => x.classList.toggle('on', x === b));
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function renderDealerBadge() {
  let el = $('#dealerBadge');
  if (!el) { el = document.createElement('div'); el.id = 'dealerBadge'; el.className = 'dealer-badge'; $('#topbar .brand').after(el); }
  const cv = state.customerView;
  el.classList.toggle('cv', !!cv);
  el.innerHTML = `<span class="dot"></span><span class="dl-txt">${cv ? 'Customer view' : 'Dealer mode'}</span><span class="dl-who">· ${esc(state.dealer.name || '')}</span>
    <button type="button" id="dealerToggle" title="${cv ? 'Back to dealer mode (prices always shown)' : 'Preview exactly what customers see'}">${cv ? 'Dealer mode' : 'Customer view'}</button>`;
  $('#dealerToggle').onclick = () => {
    state.customerView = !state.customerView;
    try { sessionStorage.setItem(CV_KEY, state.customerView ? '1' : '0'); } catch { /* */ }
    renderDealerBadge(); renderPanel(); if (state.selected) selectItem(state.selected);
    toast(state.customerView ? `Customer view — prices are ${S().show_prices !== false ? 'shown' : 'hidden'} for customers` : 'Dealer mode — prices always shown');
  };
}
// ---------------------------------------------------------------------------
// Point of sale: a sales rep opened this from a contract. Saving brings the design straight back to it.
// ---------------------------------------------------------------------------
const ADMIN_URL = window.__adminUrl || '/admin/';
const posOn = () => state.dealer?.modules?.pos !== false; // Point of sale module
const quoteBtnLabel = () => (state.pos ? 'Save design &amp; return to contract' : 'Get my quote');
function posPrefill() {
  const c = state.pos?.contact || {};
  const [first, ...rest] = String(state.pos?.name || '').trim().split(/\s+/);
  const pick = (k, alt) => c[k] || alt || '';
  return { first_name: pick('first_name', first), last_name: pick('last_name', rest.join(' ')), email: pick('email', state.pos?.email), phone: pick('phone', state.pos?.phone), address: pick('address'), city: pick('city'), state: pick('state'), zip: pick('zip') };
}
function posReturn(quoteId) {
  const back = state.pos.back;
  location.href = ADMIN_URL + back + (quoteId ? (back.includes('?') ? '&' : '?') + 'quote=' + encodeURIComponent(quoteId) : '');
}
function renderPosBar() {
  let el = $('#posBar');
  if (!el) { el = document.createElement('div'); el.id = 'posBar'; el.className = 'pos-bar'; $('#topbar').after(el); document.body.classList.add('has-pos-bar'); }
  const pf = posPrefill(); const who = [pf.first_name, pf.last_name].filter(Boolean).join(' ');
  const rev = (state.pos.back.match(/^#\/pos\/revise\/(\d+)/) || [])[1];
  el.innerHTML = `<div class="pos-txt"><b>${who ? 'Designing for ' + esc(who) : 'Designing for a contract'}</b><span>${rev ? 'Editing a contract' : 'New contract'} · save to bring this design back to it</span></div>
    <button type="button" class="pos-save" id="posSave">Save design &amp; return</button><button type="button" class="pos-cancel" id="posCancel">Cancel</button>`;
  $('#posSave').onclick = () => {
    if (state.submitted) return;
    if (state.step !== QUOTE) go(QUOTE);
    // a contact on file is all we need; otherwise the rep fills in the name on the quote step first
    if (state.pos.contact) submitQuote(); else { $('#qform [name=first_name]')?.focus(); toast('Check the customer details, then click Save design & return to contract'); }
  };
  $('#posCancel').onclick = () => posReturn(null);
}
async function startPos() {
  const back = params.get('back') || '';
  if (params.get('pos') !== '1' || !state.dealer || !['admin', 'sales'].includes(state.dealer.role) || !posOn()) return;
  if (!/^#\/pos\/(new|revise\/\d+)(\?[A-Za-z0-9=&%._-]*)?$/.test(back)) return; // only ever send people back into the point of sale
  state.pos = { back, contact: null, contactId: Number(params.get('contact')) || null, name: params.get('name') || '', email: params.get('email') || '', phone: params.get('phone') || '' };
  state.customerView = false;
  const cid = Number(params.get('contact'));
  if (cid) { try { const r = await fetch('/api/crm/contacts/' + cid); if (r.ok) state.pos.contact = await r.json(); } catch { /* fall back to the name passed along */ } }
  renderPosBar(); renderDealerBadge();
}
async function boot() {
  if (params.get('embed') === '1') document.body.classList.add('embed');
  if (matchMedia('(pointer: coarse)').matches) $('#hint').textContent = 'Tip: tap a door or window to change it · press and drag to move it · pinch to zoom';
  const r = await fetch('/api/v1/catalog'); state.base = await r.json(); state.catalog = state.base;
  const cat = state.base;
  if (!cat.styles.length) { $('#panel').innerHTML = '<h2>Coming soon</h2><p class="sub">No shed styles have been published yet. Add some in the admin.</p>'; $('#loading').classList.add('gone'); return; }
  optById = Object.fromEntries(cat.options.map(o => [o.id, o]));
  const st = cat.settings || {};
  if (cat.viewer?.dealer_mode) {
    state.dealer = cat.viewer;
    try { state.customerView = sessionStorage.getItem(CV_KEY) === '1'; } catch { /* */ }
    renderDealerBadge();
  }
  // Location: ?dealer=ID or #dealer-ID locks the dealer (one link per lot); otherwise remember the last choice
  let savedLoc = {}; try { savedLoc = JSON.parse(localStorage.getItem(LOC_KEY) || '{}') || {}; } catch { /* ignore */ }
  const urlDealer = params.get('dealer') || (location.hash.match(/^#dealer-([A-Za-z0-9._~-]+)$/) || [])[1];
  if (urlDealer && findDealer(cat, urlDealer)) { savedLoc.dealer_id = findDealer(cat, urlDealer).id; state.lockDealer = true; }
  // lot staff signed in to the dealer configurator always quote for their own lot
  if (state.dealer?.dealer_id && findDealer(cat, state.dealer.dealer_id)) { savedLoc.dealer_id = findDealer(cat, state.dealer.dealer_id).id; state.lockDealer = true; }
  if (params.get('zip')) savedLoc.zip = params.get('zip');
  await startPos();
  if (st.brand_color) document.documentElement.style.setProperty('--brand', st.brand_color);
  $('#company').textContent = st.company_name || 'Shed Builder';
  document.title = `${st.company_name ? st.company_name + ' — ' : ''}Design your shed in 3D`;
  if (st.logo_url) { $('#logo').src = st.logo_url; $('#logo').hidden = false; $('#company').hidden = true; }
  if (st.phone) { $('#phone').textContent = st.phone; $('#phone').href = 'tel:' + st.phone.replace(/[^\d+]/g, ''); $('#phone').hidden = false; }

  scene = new ShedScene($('#viewport'), {
    onSelect: uid => { selectItem(uid); $('#hint').classList.add('gone'); },
    ...(new URLSearchParams(location.search).has('debug') ? {} : {}),
    onDrag: dragItem,
    onDragEnd: uid => { $('#viewport').classList.remove('dragging'); selectItem(uid); renderPanelIfOptions(); },
  });
  const hq = location.hash.match(/^#q-([a-f0-9]+)(?:\.(glb|plan))?$/);
  const token = params.get('q') || hq?.[1];
  const dlWant = params.get('download') || hq?.[2];
  if (token) {
    try {
      const q = await (await fetch('/api/v1/shared/' + encodeURIComponent(token))).json();
      if (q.config) {
        state.config = q.config;
        if (!state.config.roof_material) state.config.roof_material = cat.styles.find(s => s.id === q.config.style_id)?.roof_material || 'shingle';
        state.maxStep = stepOf('options'); state.step = stepOf('options');
        const qs = cat.styles.find(s => s.id === q.config.style_id);
        if (!qs) throw new Error('style gone');
        // the size may have been removed since the quote was made: use the closest one
        if (!qs.sizes.some(z => z.id === state.config.size_id)) {
          const old = q.size || {}; const area = (old.width || 0) * (old.depth || 0);
          state.config.size_id = qs.sizes.reduce((a, z) => (Math.abs(z.width * z.depth - area) < Math.abs(a.width * a.depth - area) ? z : a), qs.sizes[0]).id;
        }
        state.config.items = (state.config.items || []).map((it, i) => ({ ...it, uid: it.uid || 'q' + i })).filter(it => optById[it.option_id]);
        fitItems(false);
      }
    } catch { state.config = null; }
  }
  if (!state.config) {
    const sid = Number(params.get('style')) || cat.styles[0].id;
    const style = cat.styles.find(s => s.id === sid) || cat.styles[0];
    const zid = Number(params.get('size'));
    state.config = defaultConfig(cat, style.id, style.sizes.find(z => z.id === zid)?.id);
    fitItems(false);
    if (params.get('style')) state.jumpToSize = true;
  }
  if (savedLoc.dealer_id && !state.config.dealer_id && findDealer(cat, savedLoc.dealer_id)) state.config.dealer_id = findDealer(cat, savedLoc.dealer_id).id;
  if (savedLoc.zip && !state.config.zip && /^\d{5}$/.test(savedLoc.zip)) state.config.zip = savedLoc.zip;
  applyTier();
  rebuild();
  if (params.has('debug')) window.__shed = { scene, state, optById, addOption, removeItem, swapItem, moveItem, moveToWall, setGable, dragItem, fitItems, pricing, notice, go };
  renderSteps(); renderPanel();
  if (state.jumpToSize) setTimeout(() => $('#sizeHead')?.scrollIntoView({ block: 'start' }), 50);
  setTimeout(() => $('#loading').classList.add('gone'), 150);
  setTimeout(() => $('#hint').classList.add('gone'), 9000);
  if (dlWant === 'glb') setTimeout(downloadGLB, 1200);
  if (dlWant === 'plan') setTimeout(openPlan, 600);
}
$('#noticeOk').onclick = () => $('#noticeDlg').close();
boot().catch(e => { console.error(e); $('#panel').innerHTML = `<h2>Something went wrong</h2><p class="sub">${esc(e.message)}</p>`; });
