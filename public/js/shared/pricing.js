// Shared pricing + configuration helpers. Used by the browser AND the server
// (the server re-prices every quote with this same code, so prices can't be tampered with).

import { shedGeometry, roofArea, WALLS, wallLength, canPlace, findSpot, gableMode, resolvePlacement } from './geometry.js';
export { WALLS, wallLength };

/** Roofing materials. Admin can rename/re-price these in Settings → Roofing. */
export const DEFAULT_ROOFING = [
  { key: 'shingle', name: 'Architectural Shingles', description: '30-year dimensional asphalt shingles.', price: 0, price_unit: 'per_roof_sqft', active: true },
  { key: 'metal', name: 'Ag Panel Metal', description: '29-ga ribbed steel panels, 40-year paint.', price: 0.85, price_unit: 'per_roof_sqft', active: true },
];
// ---------------------------------------------------------------------------
// Price tiers (up to 4). Pricing mode decides how a customer's tier is chosen:
//   none   – everyone gets the default tier
//   dealer – the tier of the dealer lot the customer picks
//   zip    – the tier assigned to the customer's ZIP (exact, range "38300-38399" or prefix "383")
// A tier = { id, name, adjust_pct, delivery_fee?, overrides: { 'size:12': 3999, 'option:5': 300,
//           'color:8': 150, 'roofing:metal': 0.95 } }. Overrides win; anything else gets adjust_pct.
// ---------------------------------------------------------------------------
export const MAX_TIERS = 4;
export function findDealer(catalog, id) {
  return (catalog.settings?.dealers || []).find(d => String(d.id) === String(id)) || null;
}
export function zipTierId(entries, zip) {
  if (!/^\d{5}$/.test(String(zip || ''))) return null;
  const z = String(zip); let best = null, bestLen = -1;
  for (const e of entries || []) {
    const m = String(e.match || '').trim();
    if (m === z) return e.tier;
    const r = m.match(/^(\d{5})\s*-\s*(\d{5})$/);
    if (r && z >= r[1] && z <= r[2] && bestLen < 5) { best = e.tier; bestLen = 4.5; }
    else if (/^\d{1,4}$/.test(m) && z.startsWith(m) && m.length > bestLen) { best = e.tier; bestLen = m.length; }
  }
  return best;
}
export function resolveTier(catalog, config = {}) {
  const st = catalog.settings || {};
  const tiers = Array.isArray(st.price_tiers) ? st.price_tiers : [];
  if (!tiers.length) return null;
  let id = null, dealer = null;
  if (st.pricing_mode === 'dealer') { dealer = findDealer(catalog, config.dealer_id); id = dealer?.tier ?? null; }
  else if (st.pricing_mode === 'zip') id = zipTierId(st.zip_tiers, config.zip);
  const tier = tiers.find(t => String(t.id) === String(id ?? st.default_tier ?? 1)) || tiers[0];
  return { ...tier, dealer };
}
const r2 = n => Math.round(n * 100) / 100;
/** A copy of the catalog with every price set for one tier. */
export function tierCatalog(catalog, tier) {
  if (!tier) return { ...catalog, _tiered: true, _tier: null };
  const pct = 1 + (Number(tier.adjust_pct) || 0) / 100, ov = tier.overrides || {};
  const has = k => ov[k] !== undefined && ov[k] !== null && ov[k] !== '';
  const adj = (base, key, whole) => has(key) ? Number(ov[key]) : (pct === 1 ? base : (whole ? Math.round((Number(base) || 0) * pct) : r2((Number(base) || 0) * pct)));
  const styles = catalog.styles.map(s => ({ ...s, sizes: s.sizes.map(z => ({ ...z, price: adj(z.price, 'size:' + z.id, true) })) }));
  const options = catalog.options.map(o => ({ ...o, price: adj(o.price, 'option:' + o.id, !o.price_unit || o.price_unit === 'each') }));
  const colors = catalog.colors.map(c => ({ ...c, price: adj(c.price, 'color:' + c.id, true) }));
  const settings = { ...catalog.settings, roofing: roofingList(catalog).map(r => ({ ...r, price: adj(r.price, 'roofing:' + r.key, r.price_unit === 'each') })) };
  if (tier.delivery_fee !== undefined && tier.delivery_fee !== null && tier.delivery_fee !== '') settings.delivery_fee = Number(tier.delivery_fee);
  return { ...catalog, styles, options, colors, settings, _tiered: true, _tier: tier };
}

/** Color groups customers can pick from (each can be switched off in Settings). */
export const COLOR_GROUPS = [['siding', 'Siding'], ['trim', 'Trim'], ['roof', 'Roof'], ['door', 'Doors'], ['window', 'Windows']];
export function colorGroupEnabled(catalog, key) {
  const g = catalog.settings?.color_groups;
  return !(g && g[key] === false);
}

export function roofingList(catalog) {
  const r = catalog.settings?.roofing;
  return Array.isArray(r) && r.length ? r : DEFAULT_ROOFING;
}
/** Roofing materials a style allows (in admin order). */
export function roofChoices(catalog, style) {
  const all = roofingList(catalog).filter(r => r.active !== false && r.active !== 0);
  const allowed = Array.isArray(style.roof_choices) && style.roof_choices.length ? style.roof_choices : all.map(r => r.key);
  const list = all.filter(r => allowed.includes(r.key));
  return list.length ? list : all.filter(r => r.key === style.roof_material);
}
export function roofMaterialPrice(mat, style, size) {
  if (!mat) return 0;
  const p = Number(mat.price) || 0;
  switch (mat.price_unit) {
    case 'per_roof_sqft': return p * roofArea(shedGeometry(style, size));
    case 'per_sqft': return p * size.width * size.depth;
    default: return p;
  }
}
/** Roof colors that work with a roofing material (colors with no material set work with all). */
export function roofColorsFor(catalog, matKey) {
  return catalog.colors.filter(c => c.category === 'roof' && c.active !== 0 && (!c.material || c.material === matKey));
}

export function money(n, symbol = '$') {
  const raw = Math.round((Number(n) || 0) * 100) / 100;
  const v = Math.abs(raw);
  return (raw < 0 ? '−' : '') + symbol + v.toLocaleString('en-US', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

/** Price of one option for a given shed size, before standard-option credit. */
/** Lengths (ft) a customer may pick for an option, e.g. "4, 6, 8, 10" → [4, 6, 8, 10]. Empty = fixed length. */
export function lengthChoices(opt) {
  return [...new Set(String(opt?.length_choices || '').split(/[,\s]+/).map(Number).filter(n => n > 0 && n <= 40))].sort((a, b) => a - b);
}
/** Window heights are customer-adjustable when the setting is on (default on). */
export const windowHeightAdjustable = catalog => catalog?.settings?.customer_window_height !== false;
export const isWindow = o => o?.placement === 'opening' && String(o.kind || '').startsWith('window');

export function optionPrice(opt, size, qty = 1, wall = null, item = null) {
  const p = Number(opt.price) || 0;
  switch (opt.price_unit) {
    case 'per_ft_item': return p * (Number(item?.w) > 0 ? Number(item.w) : Number(opt.width) || 1) * qty;
    case 'per_ft_wall': return p * (wall && wall !== 'ceiling' && wall !== 'roof' ? wallLength(wall, size) : size.width) * qty;
    case 'per_ft_width': return p * size.width * qty;
    case 'per_ft_depth': return p * size.depth * qty;
    case 'per_sqft': return p * size.width * size.depth * qty;
    case 'per_ft_perimeter': return p * 2 * (size.width + size.depth) * qty;
    default: return p * qty;
  }
}

/** Build the default configuration for a style + size (standard options pre-placed). */
export function defaultConfig(catalog, styleId, sizeId) {
  const style = catalog.styles.find(s => s.id === styleId) || catalog.styles[0];
  const size = (style.sizes.find(s => s.id === sizeId)) || style.sizes[0];
  const firstColor = cat => (catalog.colors.find(c => c.category === cat && c.active !== 0) || {}).id || null;
  const d = style.default_colors || {};
  // skip standard options whose option was deleted or hidden since the style was set up
  const live = new Set(catalog.options.filter(o => o.active !== 0).map(o => Number(o.id)));
  const items0 = (style.standard_options || []).filter(s => live.has(Number(s.option_id))).map((s, i) => ({
    uid: 'std' + i,
    option_id: s.option_id,
    wall: s.wall || null,
    offset: Number(s.offset) || 0,
    ...(Number(s.w) > 0 ? { w: Number(s.w) } : {}),
    ...(Number(s.h) > 0 ? { h: Number(s.h) } : {}),
    ...(s.gable ? { gable: true } : {}),
    standard_of: s.option_id,
  }));
  const optById0 = Object.fromEntries(catalog.options.map(o => [o.id, o]));
  const items = [...items0];
  for (const it of items0) if (isPackage(optById0[it.option_id])) items.push(...placePackage(catalog, style, size, items, it).added);

  const choices = roofChoices(catalog, style);
  const roof_material = (choices.find(r => r.key === style.roof_material) || choices[0] || {}).key || 'shingle';
  const roofCols = roofColorsFor(catalog, roof_material);
  return {
    style_id: style.id,
    size_id: size ? size.id : null,
    roof_material,
    colors: {
      siding: d.siding || firstColor('siding'),
      trim: d.trim || firstColor('trim'),
      roof: roofCols.find(c => c.id === d.roof)?.id || roofCols[0]?.id || d.roof || firstColor('roof'),
      door: d.door || firstColor('door'),
      window: d.window || firstColor('window'),
    },
    items,
  };
}

/**
 * Compute line items + totals for a configuration.
 * Standard options are included in the base price. Swapping a standard option for another
 * charges only the difference (never a credit). Removing a standard option gives no credit.
 */
const inchTxt = ft => { const t = Math.round(ft * 12); return t >= 12 ? `${Math.floor(t / 12)}'${t % 12 ? `-${t % 12}"` : ''}` : `${t}"`; };
function lineDetail(o, it) {
  const d = [];
  if (lengthChoices(o).length && Number(it.w) > 0) d.push(`${inchTxt(Number(it.w))} long`);
  if (isWindow(o) && Number.isFinite(Number(it.elev)) && it.elev !== null && it.elev !== '' && it.elev !== undefined) d.push(`bottom ${Math.round(Number(it.elev) * 12)}" off floor`);
  if (it.gable) d.push('in gable');
  return d.join(' · ');
}
export function priceConfig(catalog, config) {
  if (!catalog._tiered) catalog = tierCatalog(catalog, resolveTier(catalog, config));
  const tier = catalog._tier;
  const settings = catalog.settings || {};
  const style = catalog.styles.find(s => s.id === config.style_id);
  if (!style) throw new Error('Unknown style');
  const size = style.sizes.find(s => s.id === config.size_id);
  if (!size) throw new Error('Unknown size for this style');
  const optById = Object.fromEntries(catalog.options.map(o => [o.id, o]));
  const colorById = Object.fromEntries(catalog.colors.map(c => [c.id, c]));
  const lines = [];
  // Pricing rules (Admin → Settings → Pricing)
  const credits = settings.downgrade_credit !== false;   // swapping a standard item for a cheaper one lowers the price
  const removeCredit = settings.remove_credit !== false; // removing a standard item credits its price

  lines.push({ type: 'base', label: `${style.name} ${size.width}' x ${size.depth}'`, amount: Number(size.price) || 0 });

  // Roofing: the style's default material is included; other materials charge the difference.
  const roofing = roofingList(catalog);
  const mat = roofing.find(r => r.key === config.roof_material) || roofing.find(r => r.key === style.roof_material);
  if (mat) {
    const std = roofing.find(r => r.key === style.roof_material);
    const isStd = !std || std.key === mat.key;
    let amt = isStd ? 0 : roofMaterialPrice(mat, style, size) - roofMaterialPrice(std, style, size);
    if (!credits) amt = Math.max(0, amt);
    lines.push({ type: 'roof', label: `Roofing: ${mat.name}`, amount: Math.round(amt), roof_material: mat.key,
      note: isStd ? 'Standard' : `${amt < 0 ? 'Change' : 'Upgrade'} from ${std.name}` });
  }

  for (const [cat, id] of Object.entries(config.colors || {})) {
    const c = colorById[id];
    if (!c) continue;
    const amt = Number(c.price) || 0;
    lines.push({ type: 'color', category: cat, label: `${cap(cat)} color: ${c.name}`, amount: amt, color_id: c.id });
  }

  for (const it of config.items || []) {
    const o = optById[it.option_id];
    if (!o) continue;
    let amt = optionPrice(o, size, it.qty || 1, it.wall, it);
    let note = '';
    const pkgIt = it.package_of && (config.items || []).find(x => x.uid === it.package_of);
    if (pkgIt && optById[pkgIt.option_id]) { amt = 0; note = `Included in ${optById[pkgIt.option_id].name}`; }
    else if (it.standard_of) {
      if (it.standard_of === it.option_id) { amt = 0; note = 'Standard'; }
      else {
        const orig = optById[it.standard_of];
        const credit = orig ? optionPrice(orig, size, 1, it.wall, it) : 0;
        amt = amt - credit;
        if (!credits) amt = Math.max(0, amt);
        note = orig ? `${amt < 0 ? 'Change' : 'Upgrade'} from ${orig.name}` : 'Upgrade';
      }
    }
    lines.push({
      type: 'option', label: o.name, amount: round2(amt), option_id: o.id, uid: it.uid,
      category: o.category, wall: it.wall || null, note, ...(it.package_of ? { package_of: it.package_of } : {}),
      ...(lineDetail(o, it) ? { detail: lineDetail(o, it) } : {}),
    });
  }

  if (removeCredit) {
    const want = {}, have = {};
    for (const so of style.standard_options || []) want[so.option_id] = (want[so.option_id] || 0) + 1;
    for (const it of config.items || []) if (it.standard_of) have[it.standard_of] = (have[it.standard_of] || 0) + 1;
    for (const [id, n] of Object.entries(want)) {
      const o = optById[id]; const missing = n - (have[id] || 0);
      for (let k = 0; k < missing && o; k++) lines.push({ type: 'option', label: `Removed: ${o.name}`, amount: -round2(optionPrice(o, size, 1)), option_id: o.id, category: o.category, note: 'Credit for removed standard item' });
    }
  }

  const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  const delivery = round2(Number(settings.delivery_fee) || 0);
  const taxRate = Number(settings.tax_rate) || 0;
  const tax = round2((subtotal + (settings.tax_delivery ? delivery : 0)) * taxRate / 100);
  const total = round2(subtotal + delivery + tax);
  const dealer = settings.pricing_mode === 'dealer' ? findDealer(catalog, config.dealer_id) : null;
  return { lines, subtotal, delivery, tax, tax_rate: taxRate, total, style, size,
    tier_id: tier?.id ?? null, tier_name: tier?.name ?? null,
    dealer: dealer ? { id: dealer.id, name: dealer.name, city: dealer.city, state: dealer.state, phone: dealer.phone, email: dealer.email } : null,
    zip: settings.pricing_mode === 'zip' ? (config.zip || null) : null };
}

/** Validate/sanitise a config coming from an untrusted client. */
/** Is this option offered on this style? style.available_options = list of option ids (null/absent = all).
 *  The style's own standard options are always available. */
export function optionAvailable(style, opt) {
  if (!style || !opt) return false;
  const list = style.available_options;
  if (!Array.isArray(list)) return true;
  if ((style.standard_options || []).some(s => Number(s.option_id) === Number(opt.id))) return true;
  return list.map(Number).includes(Number(opt.id));
}

// ---------------------------------------------------------------------------
// Packages (e.g. Electrical Package): an option whose package_items list the parts it includes,
// each with a quantity and where it goes: wall (front/back/left/right/ceiling or 'auto'),
// offset in ft from the wall centre (seen from outside; blank = auto) and an optional height.
// ---------------------------------------------------------------------------
export function isPackage(o) { return Array.isArray(o?.package_items) && o.package_items.length > 0; }
const finite = v => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v));
/** Place the parts of one package item. Returns { added, skipped } (skipped = part names with no room). */
export function placePackage(catalog, style, size, items, pkgItem) {
  const byId = Object.fromEntries(catalog.options.map(o => [o.id, o]));
  const pkg = byId[pkgItem.option_id]; const added = [], skipped = [];
  if (!isPackage(pkg)) return { added, skipped };
  const geo = shedGeometry(style, size);
  pkg.package_items.forEach((pi, ci) => {
    const o = byId[Number(pi.option_id)]; if (!o || isPackage(o)) return;
    const qty = Math.max(1, Math.min(20, Number(pi.qty) || 1));
    for (let q = 0; q < qty; q++) {
      const it = { uid: `${pkgItem.uid}-p${ci}-${q}`, option_id: o.id, package_of: pkgItem.uid, ...(finite(pi.elev) ? { elev: Number(pi.elev) } : {}) };
      const all = [...items, ...added];
      if (o.placement === 'none') { added.push({ ...it, wall: null, offset: 0 }); continue; }
      if (o.placement === 'ceiling' || o.placement === 'roof') {
        const lim = o.placement === 'ceiling' ? (geo.ridgeAlongZ ? geo.D : geo.W) / 2 - 1 : geo.L / 2 - 1.5;
        // spread several lights evenly unless a position is given
        const off = finite(pi.offset) ? Number(pi.offset) + q * 4 : -lim + 2 * lim * (q + 0.5) / qty;
        added.push({ ...it, wall: o.placement, offset: +Math.max(-lim, Math.min(lim, off)).toFixed(2) }); continue;
      }
      const wantWall = WALLS.includes(pi.wall) ? pi.wall : (pi.wall === 'auto' || !pi.wall) && qty > 1 ? WALLS[(q + 1) % 4] : null;
      const cand = { ...it, wall: wantWall || 'back', offset: finite(pi.offset) ? Number(pi.offset) : 0 };
      if (WALLS.includes(cand.wall) && canPlace(geo, byId, all, o, cand, it.uid)) { added.push(cand); continue; }
      const spot = findSpot(geo, byId, all, o, wantWall, cand.offset, it.uid, { elev: it.elev });
      if (spot) { const n = { ...it, ...spot }; if (!n.gable) delete n.gable; added.push(n); } else skipped.push(o.name);
    }
  });
  return { added, skipped };
}

/** Same placement rules as the builder: max quantities, lofts/vents/gable windows on gable ends,
 *  nothing overlapping (trim included). Items that don't fit slide to the nearest free spot or are dropped. */
function fitAll(style, size, optById, items) {
  const geo = shedGeometry(style, size), keep = [], counts = {}, seen = new Set();
  const pkgUids = new Set(items.filter(i => isPackage(optById[i.option_id])).map(i => i.uid));
  for (const raw of items) {
    const it = { ...raw }, o = optById[it.option_id];
    if (it.package_of && !pkgUids.has(it.package_of)) continue;          // part of a package that isn't there
    if (!it.package_of && o.package_only) continue;                      // only sold inside a package
    if (!it.package_of) { counts[o.id] = (counts[o.id] || 0) + 1; if (counts[o.id] > (Number(o.max_qty) || 10)) continue; }
    while (seen.has(it.uid)) it.uid += '_'; seen.add(it.uid);
    if (o.placement === 'none') { if (counts[o.id] > 1) continue; it.wall = null; keep.push(it); continue; }
    if (o.placement === 'ceiling' || o.placement === 'roof') { it.wall = o.placement; keep.push(it); continue; }
    if (it.gable && !(WALLS.includes(it.wall) && geo.isGable(it.wall) && gableMode(o) === 'allow')) delete it.gable;
    // record the height a customer-set window really ends up at (kept under the roof line)
    if (it.elev !== undefined && !it.package_of && WALLS.includes(it.wall)) it.elev = Math.round(resolvePlacement(geo, o, it).elev * 48) / 48;
    if (WALLS.includes(it.wall) && canPlace(geo, optById, keep, o, it, it.uid)) { keep.push(it); continue; }
    const spot = findSpot(geo, optById, keep, o, WALLS.includes(it.wall) ? it.wall : null, it.offset || 0, it.uid, { w: it.w, h: it.h, gable: it.gable, elev: it.elev });
    if (spot) { const n = { ...it, ...spot }; if (!n.gable) delete n.gable; keep.push(n); }
  }
  return keep;
}

export function sanitizeConfig(catalog, raw) {
  const style = catalog.styles.find(s => s.id === Number(raw?.style_id));
  if (!style) throw new Error('style_id is invalid');
  const size = style.sizes.find(s => s.id === Number(raw.size_id));
  if (!size) throw new Error('size_id is invalid for this style');
  const colorIds = new Set(catalog.colors.map(c => c.id));
  const optIds = new Set(catalog.options.map(o => o.id));
  const choices = roofChoices(catalog, style);
  const roof_material = (choices.find(r => r.key === raw.roof_material) || choices.find(r => r.key === style.roof_material) || choices[0] || {}).key || null;
  const colors = {};
  const defaults = defaultConfig(catalog, style.id, size.id).colors;
  for (const k of COLOR_GROUPS.map(g => g[0])) {
    const v = Number(raw.colors?.[k]);
    if (!colorGroupEnabled(catalog, k)) { if (defaults[k]) colors[k] = defaults[k]; continue; }
    if (colorIds.has(v)) colors[k] = v;
  }
  const optById = Object.fromEntries(catalog.options.map(o => [o.id, o]));
  const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, 200)
    .filter(i => i && typeof i === 'object' && optIds.has(Number(i.option_id)) && (i.package_of || optionAvailable(style, optById[Number(i.option_id)])))
    .map((i, n) => ({
      uid: String(i.uid || 'i' + n).slice(0, 40),
      option_id: Number(i.option_id),
      wall: WALLS.includes(i.wall) ? i.wall : (i.wall === 'ceiling' || i.wall === 'roof' ? i.wall : null),
      offset: clampNum(i.offset, -100, 100),
      qty: Math.max(1, Math.min(99, Number(i.qty) || 1)),
      ...(Number(i.w) > 0 ? { w: clampNum(i.w, 0.25, 40) } : {}),
      ...(Number(i.h) > 0 ? { h: clampNum(i.h, 0.25, 20) } : {}),
      standard_of: optIds.has(Number(i.standard_of)) ? Number(i.standard_of) : null,
      ...(i.gable && optById[Number(i.option_id)]?.gable_mode === 'allow' ? { gable: true } : {}),
      ...(i.package_of ? { package_of: String(i.package_of).slice(0, 60) } : {}),
      ...(finite(i.elev) ? { elev: clampNum(i.elev, 0, 30) } : {}),
    }));
  for (const it of items) {
    const o = optById[it.option_id];
    const lc = lengthChoices(o);
    if (lc.length && Number(it.w) > 0) it.w = lc.reduce((a, b) => (Math.abs(b - it.w) < Math.abs(a - it.w) ? b : a), lc[0]);
    // only options with a list of lengths can be resized: a length sent for anything else would change a
    // "per ft of its length" price (e.g. a 0.25 ft shelf), so it's ignored and the catalog width is used
    else if (!lc.length && 'w' in it && !it.package_of) delete it.w;
    // customer window heights only when the setting allows it (package parts keep their admin-set heights)
    if (it.elev !== undefined && !it.package_of && (!isWindow(o) || !windowHeightAdjustable(catalog))) delete it.elev;
    else if (it.elev !== undefined && !it.package_of) it.elev = Math.max(1, it.elev); // windows at least 12" off the floor
  }
  for (const it of [...items]) {
    if (!isPackage(optById[it.option_id]) || items.some(x => x.package_of === it.uid)) continue;
    items.push(...placePackage(catalog, style, size, items, it).added);
  }
  // Standard slots must actually be standard for this style
  const std = new Set((style.standard_options || []).map(s => s.option_id));
  for (const it of items) if (it.standard_of && !std.has(it.standard_of)) it.standard_of = null;
  const out = { style_id: style.id, size_id: size.id, roof_material, colors, items: fitAll(style, size, optById, items) };
  if (findDealer(catalog, raw.dealer_id)) out.dealer_id = findDealer(catalog, raw.dealer_id).id;
  if (/^\d{5}$/.test(String(raw.zip || ''))) out.zip = String(raw.zip);
  return out;
}

/** World-space centre of a wall-mounted item (x, z) in feet. Front wall faces +z. */
export function wallPoint(wall, offset, size) {
  const W = size.width, D = size.depth;
  switch (wall) {
    case 'front': return { x: offset, z: D / 2, nx: 0, nz: 1 };
    case 'back': return { x: -offset, z: -D / 2, nx: 0, nz: -1 };
    case 'right': return { x: W / 2, z: -offset, nx: 1, nz: 0 };
    case 'left': return { x: -W / 2, z: offset, nx: -1, nz: 0 };
    default: return { x: 0, z: offset, nx: 0, nz: 0 };
  }
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function round2(n) { return Math.round(n * 100) / 100; }
function clampNum(v, a, b) { v = Number(v) || 0; return Math.max(a, Math.min(b, v)); }

// ---------------------------------------------------------------------------
// Price visibility. Customers see prices only when settings.show_prices is on; signed-in staff
// (the dealer-facing configurator) always see them. When hidden, prices never leave the server.
// ---------------------------------------------------------------------------
export function stripPrices(cat) {
  const c = structuredClone(cat);
  for (const st of c.styles || []) for (const z of st.sizes || []) z.price = 0;
  for (const o of c.options || []) o.price = 0;
  for (const col of c.colors || []) col.price = 0;
  const s = c.settings || (c.settings = {});
  s.roofing = (s.roofing || []).map(r => ({ ...r, price: 0 }));
  s.price_tiers = (s.price_tiers || []).map(t => ({ id: t.id, name: t.name, adjust_pct: 0, delivery_fee: 0, overrides: {} }));
  s.delivery_fee = 0; s.tax_rate = 0; s.prices_hidden = true;
  return c;
}
/** Remove every price from a formatted quote (customer response when prices are hidden). */
export function hideQuotePrices(out) {
  const o = { ...out, pricing: { hidden: true } };
  o.options = (out.options || []).map(({ price, ...x }) => x);
  o.summary = String(out.summary || '').replace(/\s*\|\s*Total:[^|]*$/, '');
  delete o.pricing_lines;
  return o;
}
