// Pure shed geometry (no Three.js) — roof profiles, wall heights, placement & collision rules.
export const WALLS = ['front', 'right', 'back', 'left'];
/** Rake / fly-rafter tail: true = cut flat (level) at the bottom of the fascia, false = plumb cut only.
 *  Set per style; blank = flat on gambrel barns, plumb on everything else. */
export function rakeTailLevel(style) { return style?.rake_tail === 'level' || style?.rake_tail === 'plumb' ? style.rake_tail === 'level' : style?.roof_type === 'barn'; }
export function wallLength(wall, size) { return (wall === 'front' || wall === 'back') ? size.width : size.depth; }

export const FLOOR_Y = 0.75;     // skids + floor
export const WALL_T = 0.33;      // wall thickness (ft)

export function shedGeometry(style, size) {
  const W = size.width, D = size.depth, H = Number(style.wall_height) || 7;
  let k = (Number(style.roof_pitch) || 6) / 12;
  const ridgeAlongZ = style.ridge_axis !== 'width';
  const S = ridgeAlongZ ? W : D;           // span (across the slope)
  const L = ridgeAlongZ ? D : W;           // ridge length
  const s = S / 2;
  let profile;
  switch (style.roof_type) {
    case 'barn': {
      // Gambrel: steep lower slope (roof_pitch_lower), shallow upper slope (roof_pitch),
      // break point at gambrel_break % of the half-span measured in from the wall.
      // Lower section size: gambrel_lower_len = length along the slope in ft (preferred),
      // otherwise gambrel_break % of the half-span.
      // Hip (lower section) and upper section lengths can be set per style and overridden per size.
      // If the upper length is set too, the upper pitch follows from it.
      const kl = (Number(style.roof_pitch_lower) || 18) / 12;
      const hip = Number(size.hip_len) > 0 ? Number(size.hip_len) : Number(style.gambrel_lower_len) > 0 ? Number(style.gambrel_lower_len) : 0;
      let run = hip ? hip / Math.hypot(1, kl) : s * Math.min(0.9, Math.max(0.1, (Number(style.gambrel_break) || 42) / 100));
      run = Math.min(run, s * 0.9);
      const bs = s - run, r1 = run * kl;
      const up = Number(size.upper_len) > 0 ? Number(size.upper_len) : Number(style.gambrel_upper_len) > 0 ? Number(style.gambrel_upper_len) : 0;
      let r2 = bs * k;
      if (up > bs + 0.01) { r2 = Math.min(Math.sqrt(up * up - bs * bs), bs * 2.5); k = r2 / bs; } // upper pitch follows (capped at 30/12)
      profile = [[-s, 0], [-bs, r1], [0, r1 + r2], [bs, r1], [s, 0]]; break;
    }
    case 'lean_to': profile = [[-s, 0], [s, S * k]]; break;
    case 'saltbox': {
      // Long (shallow) slope = roof_pitch, short (steep) slope = roof_pitch_back; the ridge sits where they meet.
      const kb = (Number(style.roof_pitch_back) || (k * 12 * 1.86)) / 12;
      const x = s * (kb - k) / (k + kb); // ridge position (front is -s side)
      profile = [[-s, 0], [x, k * (x + s)], [s, 0]]; break;
    }
    default: profile = [[-s, 0], [0, s * k], [s, 0]];
  }
  const prof = u => {
    u = Math.max(-s, Math.min(s, u));
    for (let i = 0; i < profile.length - 1; i++) {
      const [u0, h0] = profile[i], [u1, h1] = profile[i + 1];
      if (u >= u0 - 1e-9 && u <= u1 + 1e-9) return h0 + (h1 - h0) * ((u - u0) / (u1 - u0 || 1));
    }
    return 0;
  };
  const isGable = w => ridgeAlongZ ? (w === 'front' || w === 'back') : (w === 'left' || w === 'right');
  // map wall-local u (viewed from outside, + to the right) to span coordinate
  const spanCoord = (w, u) => {
    if (ridgeAlongZ) return { front: u, back: -u, left: -s, right: s }[w];
    return { left: u, right: -u, front: s, back: -s }[w];
  };
  const topAt = (w, u) => H + prof(spanCoord(w, u));
  // wall-local u of each profile vertex for gable walls
  const profileUs = w => {
    const sign = ridgeAlongZ ? (w === 'front' ? 1 : -1) : (w === 'left' ? 1 : -1);
    return profile.map(([u, h]) => [u * sign, H + h]);
  };
  const peak = Math.max(...profile.map(p => p[1]));
  const eaveOv = Number(style.overhang ?? 0.75) || 0;
  // second eave (right wall; front when the ridge runs across): a deeper overhang, e.g. over a coop's windows
  const eaveOv2 = style.overhang_right == null || style.overhang_right === '' ? eaveOv : Number(style.overhang_right) || 0;
  const gableOv = style.gable_overhang == null || style.gable_overhang === '' ? eaveOv : Number(style.gable_overhang) || 0;
  const inch = (v, d) => (v === null || v === undefined || v === '' ? d : Number(v)) / 12;
  const casing = inch(style.casing_trim, 4), corner = inch(style.corner_trim, 5);
  return { W, D, H, S, L, s, k, ridgeAlongZ, profile, prof, isGable, topAt, profileUs, peak, eaveOv, eaveOv2, gableOv, casing, corner, wallLen: w => wallLength(w, size) };
}

/** Each roof section: pitch (x/12), length along the slope and horizontal run, in ft (no overhang). */
export function roofSections(geo) {
  const out = [];
  for (let i = 0; i < geo.profile.length - 1; i++) {
    const [u0, h0] = geo.profile[i], [u1, h1] = geo.profile[i + 1];
    const run = Math.abs(u1 - u0), rise = Math.abs(h1 - h0);
    out.push({ pitch: run ? (rise / run) * 12 : 0, length: Math.hypot(run, rise), run, rise });
  }
  return out;
}

/** Sloped roof surface area in sq ft, including eave and gable overhangs. */
export function roofArea(geo) {
  const pr = geo.profile;
  let len = 0;
  for (let i = 0; i < pr.length - 1; i++) {
    const du = pr[i + 1][0] - pr[i][0], dh = pr[i + 1][1] - pr[i][1], l = Math.hypot(du, dh);
    len += l;
    const ux = Math.max(Math.abs(du) / l, 0.3);
    if (i === 0) len += geo.eaveOv / ux;
    if (i === pr.length - 2) len += (geo.eaveOv2 ?? geo.eaveOv) / ux;
  }
  return len * (geo.L + 2 * geo.gableOv);
}

/** Effective width/height of an item (per-item override, else the option's own size). */
export function itemSize(opt, item) {
  const w = Number(item?.w) > 0 ? Number(item.w) : Number(opt.width) || 1;
  const h = Number(item?.h) > 0 ? Number(item.h) : Number(opt.height) || 1;
  return { w, h };
}

/** Gable placement: 'only' = must sit up in the gable, 'allow' = customer can choose wall or gable. */
export function gableMode(opt) { return opt?.gable_mode === 'only' || opt?.gable_mode === 'allow' ? opt.gable_mode : ''; }
export function inGable(geo, opt, item) {
  if (!WALLS.includes(item.wall) || !geo.isGable(item.wall)) return false;
  const m = gableMode(opt); return m === 'only' || (m === 'allow' && !!item.gable);
}

/** Trim around an opening (ft): side casing, head casing and (windows/vents) the flat bottom casing. */
function trimPad(geo, opt) {
  if (opt.placement !== 'opening') return { side: 0, head: 0, sill: 0 };
  // outside nest box: end boards beside it, the sloped lid + hinge board above, end boards running below
  if (opt.kind === 'nest_box') return { side: 0.3, head: 0.45, sill: 0.3 };
  const win = String(opt.kind || '').startsWith('window'), cw = geo.casing ?? 0.33;
  let side = cw + (win ? 0.1 : 0.05);
  if (opt.kind === 'window_shutters') side = Math.max(side, cw + (Number(opt.width) || 2) * 0.55);
  return { side, head: cw, sill: win || opt.kind === 'vent' ? cw : 0 };
}

/** Resolve where an item actually sits (clamped to the wall, clear of the corner boards, under the roof line).
 *  fits=false means it cannot sit there at its proper size/height (e.g. a gable window that is too tall). */
export function resolvePlacement(geo, opt, item) {
  const sz = itemSize(opt, item);
  let w = sz.w;
  let h = sz.h;
  const baseElev = item.elev !== undefined && item.elev !== null && item.elev !== '' && Number.isFinite(Number(item.elev)) ? Number(item.elev) : Number(opt.elevation) || 0;
  if (!WALLS.includes(item.wall)) return { offset: item.offset || 0, elev: baseElev, w, h, fits: true };
  const L = geo.wallLen(item.wall);
  const pad = trimPad(geo, opt);
  // exterior items stay clear of the corner boards; interior items clear of the inside wall face
  const exterior = opt.placement === 'opening' || opt.placement === 'wall_exterior' || opt.placement === 'ground';
  let margin = (exterior ? Math.max(WALL_T + 0.1, (geo.corner ?? 0.42) - 0.06) : WALL_T + 0.1) + pad.side;
  // Built-ins sold by length (double shelves) may run wall to wall: a length as long as the wall (e.g. 12' on a
  // 12' end wall) is fitted between the inside faces of the side walls.
  if (opt.placement === 'wall_interior' && String(opt.length_choices || '').trim()) {
    margin = WALL_T + 0.01;
    if (w > L - 2 * margin && w <= L + 0.01) w = L - 2 * margin;
  }
  const span = opt.placement === 'loft' ? 0 : w;
  let offset = Math.max(-L / 2 + margin + span / 2, Math.min(L / 2 - margin - span / 2, Number(item.offset) || 0));
  let fits = true;
  if (span > L - 2 * margin) { offset = 0; fits = opt.placement === 'loft'; }
  let elev = baseElev;
  if (opt.placement === 'opening' || opt.placement === 'wall_exterior' || opt.placement === 'wall_interior') {
    const top = Math.min(geo.topAt(item.wall, offset - w / 2 - pad.side), geo.topAt(item.wall, offset + w / 2 + pad.side));
    const maxTop = top - (opt.placement === 'opening' ? pad.head + 0.08 : 0.15);
    if (inGable(geo, opt, item)) {
      // centred in the gable: above the top of the wall, head trim clear of the rake board
      const lo = geo.H + 0.15 + pad.sill, hi = maxTop - 0.15;
      elev = Math.max(lo, lo + (hi - lo - h) / 2);
      if (elev + h > hi + 1e-6) fits = false;
      return { offset, elev, w, h, fits, gable: true };
    }
    if (opt.kind === 'vent' || elev < 0) {
      const room = geo.topAt(item.wall, offset) - geo.H;
      elev = room > h + 0.8 ? geo.H + room * 0.42 - h / 2 : geo.H - h - 0.35;
    }
    if (elev + h > maxTop) elev = maxTop - h;
    if (elev < 0) { h = Math.max(0.3, h + elev); elev = 0; }
  }
  return { offset, elev, w, h, fits };
}

/** Space an item occupies on a wall, INCLUDING its trim (for collision checks). */
function extents(geo, opt, item) {
  const p = resolvePlacement(geo, opt, item);
  const layer = opt.placement === 'opening' ? 'through' : opt.placement === 'wall_interior' ? 'in' : opt.placement === 'wall_exterior' ? 'out' : opt.placement === 'ground' ? 'ground' : null;
  const t = trimPad(geo, opt);
  return { a: p.offset - p.w / 2 - t.side, b: p.offset + p.w / 2 + t.side, y0: p.elev - t.sill, y1: p.elev + p.h + t.head, layer, kind: opt.kind };
}

/** Nothing on a wall may overlap anything else on that wall — trim included. Inside items (shelves)
 *  and outside items (lights, flower boxes) are on opposite faces, so they only clash with openings
 *  and with items on their own face. Ramps only clash with other ramps. */
// Floor-plan footprint of a deep interior item (shelves, workbench): along-wall span x depth into the room.
const deepInterior = o => o?.placement === 'wall_interior' && Number(o.depth) > 0.4;
function footprint(geo, e, wall, depth) {
  const W = geo.wallLen('front'), D = geo.wallLen('left');
  const wp = t => wall === 'front' ? [t, D / 2, 0, 1] : wall === 'back' ? [-t, -D / 2, 0, -1] : wall === 'right' ? [W / 2, -t, 1, 0] : [-W / 2, t, -1, 0];
  const [x1, z1, nx, nz] = wp(e.a), [x2, z2] = wp(e.b);
  const pa = [x1 - nx * WALL_T, z1 - nz * WALL_T], pb = [x2 - nx * (WALL_T + depth), z2 - nz * (WALL_T + depth)];
  return { x0: Math.min(pa[0], pb[0]), x1: Math.max(pa[0], pb[0]), z0: Math.min(pa[1], pb[1]), z1: Math.max(pa[1], pb[1]) };
}
function collides(geo, optById, items, opt, cand, ignoreUid) {
  const e = extents(geo, opt, cand);
  if (!e.layer) return false;
  for (const it of items) {
    if (it.uid === ignoreUid) continue;
    if (it.wall !== cand.wall) {
      // shelves meeting in a corner: a wall-to-wall shelf on one wall and a shelf on the side wall can't overlap
      const o2 = optById[it.option_id];
      if (deepInterior(opt) && deepInterior(o2) && WALLS.includes(it.wall) && WALLS.includes(cand.wall)) {
        const f = extents(geo, o2, it);
        if (e.y0 < f.y1 - 0.01 && f.y0 < e.y1 - 0.01) {
          const A = footprint(geo, e, cand.wall, Number(opt.depth)), B = footprint(geo, f, it.wall, Number(o2.depth));
          if (A.x0 < B.x1 - 0.01 && B.x0 < A.x1 - 0.01 && A.z0 < B.z1 - 0.01 && B.z0 < A.z1 - 0.01) return true;
        }
      }
      continue;
    }
    const o = optById[it.option_id]; if (!o) continue;
    const f = extents(geo, o, it);
    if (!f.layer) continue;
    if (e.layer === 'ground' || f.layer === 'ground') { if (e.layer !== f.layer) continue; }
    else if (!(f.layer === e.layer || f.layer === 'through' || e.layer === 'through')) continue;
    const eps = 0.01;
    const hOverlap = e.a < f.b - eps && f.a < e.b - eps;
    // a flower box tucks right under a window's bottom trim (its flowers may overlap the trim a little)
    const vTol = (e.kind === 'flowerbox' || f.kind === 'flowerbox') ? 0.25 : eps;
    const vOverlap = e.layer === 'ground' || (e.y0 < f.y1 - vTol && f.y0 < e.y1 - vTol);
    if (hOverlap && vOverlap) return true;
  }
  return false;
}

/** Find a free spot for a new/moved item. Tries the preferred wall first, then the others. */
export function findSpot(geo, optById, items, opt, prefWall, prefOffset = 0, ignoreUid = null, extra = {}) {
  if (opt.placement === 'none') return { wall: null, offset: 0 };
  if (opt.placement === 'ceiling') {
    const used = items.filter(i => i.wall === 'ceiling' && i.uid !== ignoreUid).map(i => i.offset);
    const lim = geo.D / 2 - 1;
    for (const off of spiral(prefOffset, lim, 2)) if (!used.some(u => Math.abs(u - off) < 1.5)) return { wall: 'ceiling', offset: off };
    return { wall: 'ceiling', offset: 0 };
  }
  if (opt.placement === 'roof') return { wall: 'roof', offset: prefOffset || 0 };
  const walls = prefWall ? [prefWall, ...WALLS.filter(w => w !== prefWall)] : WALLS;
  for (const wall of walls) {
    if ((opt.kind === 'vent' || gableMode(opt) === 'only') && !geo.isGable(wall)) continue;
    if (opt.placement === 'loft') {
      if (!geo.isGable(wall)) continue; // lofts span an end (gable) wall
      if (!items.some(i => i.wall === wall && optById[i.option_id]?.placement === 'loft' && i.uid !== ignoreUid)) return { wall, offset: 0 };
      continue;
    }
    const L = geo.wallLen(wall);
    if (Number(opt.width) > L - 0.8) continue;
    const g = gableMode(opt) === 'only' || (gableMode(opt) === 'allow' && extra.gable && geo.isGable(wall));
    for (const off of spiral(wall === prefWall ? prefOffset : 0, L / 2, 0.25)) {
      const cand = { wall, offset: off, uid: '__cand', option_id: opt.id, ...(extra.w ? { w: extra.w } : {}), ...(extra.h ? { h: extra.h } : {}), ...(extra.elev != null ? { elev: extra.elev } : {}), ...(g ? { gable: true } : {}) };
      const p = resolvePlacement(geo, opt, cand);
      if (Math.abs(p.offset - off) > 0.01 || !p.fits) continue;
      if (!collides(geo, optById, items, opt, cand, ignoreUid)) return { wall, offset: off, ...(g ? { gable: true } : { gable: undefined }) };
    }
  }
  return null;
}

export function canPlace(geo, optById, items, opt, cand, ignoreUid) {
  if ((opt.kind === 'vent' || gableMode(opt) === 'only' || opt.placement === 'loft') && WALLS.includes(cand.wall) && !geo.isGable(cand.wall)) return false;
  if (opt.placement === 'loft') return !items.some(i => i.uid !== ignoreUid && i.wall === cand.wall && optById[i.option_id]?.placement === 'loft');
  const p = resolvePlacement(geo, opt, cand);
  return p.fits !== false && Math.abs(p.offset - cand.offset) < 0.01 && !collides(geo, optById, items, opt, cand, ignoreUid);
}

function* spiral(start, lim, step) {
  yield start;
  for (let d = step; d <= lim * 2 + step; d += step) {
    if (start + d <= lim) yield +(start + d).toFixed(2);
    if (start - d >= -lim) yield +(start - d).toFixed(2);
  }
}
