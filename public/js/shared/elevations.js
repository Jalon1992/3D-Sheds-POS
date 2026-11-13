// To-scale exterior elevations (front / right / back / left) as standalone SVG strings.
// Built from the same geometry as the 3D model, so openings, pitches and overhangs match exactly.
import { shedGeometry, resolvePlacement, FLOOR_Y, rakeTailLevel } from './geometry.js';
import { roofingList } from './pricing.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function ftIn(ft) {
  const t = Math.round(ft * 12 * 4) / 4, f = Math.floor(t / 12 + 1e-9), i = t - f * 12;
  const whole = Math.floor(i + 1e-9), frac = { 0.25: '¼', 0.5: '½', 0.75: '¾' }[+(i - whole).toFixed(2)] || '';
  return `${f}'-${whole}${frac}"`;
}
const shortName = o => o.plan_label || o.name.replace(/\s*\(.*\)$/, '');

/**
 * @param wall 'front' | 'right' | 'back' | 'left'
 * @returns {{ svg: string, width: number, height: number }}
 */
export function elevationSVG(catalog, config, wall, opts = {}) {
  const style = catalog.styles.find(s => s.id === config.style_id);
  const size = style.sizes.find(z => z.id === config.size_id);
  const geo = shedGeometry(style, size);
  const optById = Object.fromEntries(catalog.options.map(o => [o.id, o]));
  const colorById = Object.fromEntries(catalog.colors.map(c => [c.id, c]));
  const roofHex = colorById[config.colors?.roof]?.hex || '#555';
  const sidingHex = colorById[config.colors?.siding]?.hex || '#c9bda5';
  const isMetal = (config.roof_material || style.roof_material) === 'metal';
  const roofName = (roofingList(catalog).find(r => r.key === (config.roof_material || style.roof_material)) || {}).name || '';

  const S = opts.scale || 36;               // px per ft
  const L = geo.wallLen(wall), F = geo.floorY ?? FLOOR_Y, H = geo.H, th = 0.22;
  const gable = geo.isGable(wall);
  // Horizontal extent including roof overhangs seen in this view
  const ov2 = geo.eaveOv2 ?? geo.eaveOv;
  const sideOv = gable ? Math.max(geo.eaveOv, ov2) + 0.4 : geo.gableOv + 0.2;
  const peakY = F + H + geo.peak + th + 0.1;
  const padL = 120, padR = 120, padT = 60, padB = 110;
  const width = (L + 2 * sideOv) * S + padL + padR, height = peakY * S + padT + padB;
  const X = u => padL + (u + L / 2 + sideOv) * S;
  const Y = y => padT + (peakY - y) * S;
  const o = [];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width.toFixed(1)} ${height.toFixed(1)}" width="${width.toFixed(1)}" height="${height.toFixed(1)}" font-family="Helvetica, Arial, sans-serif">`);
  o.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);

  // --- ground + skids/floor
  o.push(`<line x1="${X(-L / 2 - sideOv) - 30}" y1="${Y(0)}" x2="${X(L / 2 + sideOv) + 30}" y2="${Y(0)}" stroke="#1d2624" stroke-width="2"/>`);
  o.push(`<rect x="${X(-L / 2)}" y="${Y(F)}" width="${L * S}" height="${F * S}" fill="#e8e2d6" stroke="#1d2624" stroke-width="1"/>`);
  // skid ends show on the front and back (they run front to back); from the sides you see the outer skid
  const sk = geo.skids, skTop = 0.025 + sk.h;
  if (wall === 'front' || wall === 'back') for (const x of sk.xs) o.push(`<rect x="${X(x - sk.w / 2)}" y="${Y(skTop)}" width="${sk.w * S}" height="${sk.h * S}" fill="#cbb994" stroke="#1d2624" stroke-width="1"/>`);
  else o.push(`<line x1="${X(-L / 2)}" y1="${Y(skTop)}" x2="${X(L / 2)}" y2="${Y(skTop)}" stroke="#1d2624" stroke-opacity=".5"/>`);

  // --- wall outline (top follows the roof underside)
  const top = [];
  if (gable) for (const [u, h] of geo.profileUs(wall).sort((a, b) => a[0] - b[0])) top.push([Math.max(-L / 2, Math.min(L / 2, u)), F + h]);
  else { top.push([-L / 2, F + geo.topAt(wall, -L / 2)]); top.push([L / 2, F + geo.topAt(wall, L / 2)]); }
  const wallPts = [[-L / 2, F], ...top, [L / 2, F]];
  o.push(`<polygon points="${wallPts.map(([u, y]) => `${X(u)},${Y(y)}`).join(' ')}" fill="${sidingHex}" fill-opacity="0.28" stroke="#1d2624" stroke-width="2"/>`);
  // siding grooves (8" o.c.) or lap lines, clipped to the wall
  const clipId = 'w' + wall;
  o.push(`<clipPath id="${clipId}"><polygon points="${wallPts.map(([u, y]) => `${X(u)},${Y(y)}`).join(' ')}"/></clipPath><g clip-path="url(#${clipId})" stroke="#1d2624" stroke-opacity="0.18" stroke-width="1">`);
  if ((style.siding_type || 'lp_smartside') === 'lap') for (let y = F + 0.5; y < F + H + geo.peak; y += 0.5) o.push(`<line x1="${X(-L / 2)}" y1="${Y(y)}" x2="${X(L / 2)}" y2="${Y(y)}"/>`);
  else for (let u = -L / 2 + 8 / 12; u < L / 2; u += 8 / 12) o.push(`<line x1="${X(u)}" y1="${Y(F)}" x2="${X(u)}" y2="${Y(F + H + geo.peak)}"/>`);
  o.push(`</g>`);
  // corner boards
  const cw = (style.corner_trim ?? 5) / 12;
  for (const u of [-L / 2, L / 2 - cw]) {
    const hTop = F + geo.topAt(wall, u < 0 ? -L / 2 : L / 2);
    o.push(`<rect x="${X(u)}" y="${Y(hTop)}" width="${cw * S}" height="${(hTop - F) * S}" fill="#ffffff" stroke="#1d2624" stroke-width="1"/>`);
  }

  // --- roof
  const roofFill = roofHex, roofStroke = '#1d2624';
  if (gable) {
    // roof seen end-on: a band following the profile, extended by the eave overhang
    const pts = geo.profileUs(wall).sort((a, b) => a[0] - b[0]).map(([u, h]) => [u, F + h]);
    const ext = (a, b, d) => { const dx = a[0] - b[0], dy = a[1] - b[1], l = Math.hypot(dx, dy); const k = d / Math.max(Math.abs(dx) / l, 0.3); return [a[0] + dx / l * k, a[1] + dy / l * k]; };
    // the profile runs left→right as seen from the front (or left) wall; from the opposite wall it's mirrored
    const fromStart = geo.ridgeAlongZ ? wall === 'front' : wall === 'left';
    pts[0] = ext(pts[0], pts[1], fromStart ? geo.eaveOv : ov2); pts[pts.length - 1] = ext(pts[pts.length - 1], pts[pts.length - 2], fromStart ? ov2 : geo.eaveOv);
    const upper = pts.map(([u, y]) => [u, y + th]);
    o.push(`<polygon points="${[...pts, ...upper.slice().reverse()].map(([u, y]) => `${X(u)},${Y(y)}`).join(' ')}" fill="${roofFill}" stroke="${roofStroke}" stroke-width="1.5"/>`);
    // rake trim band
    const rk = (style.roof_edge === 'board_drip' || !isMetal ? (style.rake_size ?? 5.5) : (style.metal_rake_size ?? 5.5)) / 12;
    // rake bottom edge, with the tails cut plumb then LEVEL at the bottom of the fascia (no point hanging below)
    const fasciaH = (style.fascia_size ?? 5.5) / 12;
    // rake depth is measured square to the slope, so its plumb depth is rk / cos(pitch)
    const sec = i => { const a = pts[Math.min(i, pts.length - 2)], b = pts[Math.min(i, pts.length - 2) + 1]; return Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.max(1e-6, Math.abs(b[0] - a[0])); };
    let low = pts.map(([u, y], i) => {
      const k = i === 0 ? sec(0) : i === pts.length - 1 ? sec(pts.length - 2) : Math.min(sec(i - 1), sec(i));
      return [u, y + th - rk * k];
    });
    const cutEnd = (line, end, prev, edge) => {
      const yCut = edge[1] + th - fasciaH, b = line[end], a = line[prev];
      if (!rakeTailLevel(style) || b[1] >= yCut || a[1] <= yCut) return [b, [edge[0], b[1]]];
      const t = (yCut - b[1]) / (a[1] - b[1]);
      return [[b[0] + (a[0] - b[0]) * t, yCut], [edge[0], yCut]];
    };
    const n = low.length - 1, L0 = cutEnd(low, 0, 1, pts[0]), L1 = cutEnd(low, n, n - 1, pts[n]);
    low = [[pts[0][0], pts[0][1] + th], L0[1], L0[0], ...low.slice(1, n), L1[0], L1[1], [pts[n][0], pts[n][1] + th]];
    o.push(`<polyline points="${low.map(([u, y]) => `${X(u)},${Y(y)}`).join(' ')}" fill="none" stroke="${roofStroke}" stroke-width="1"/>`);
  } else {
    // roof seen from the eave side: horizontal bands between the profile heights
    const hs = [...new Set(geo.profile.map(p => +(F + H + p[1]).toFixed(4)))].sort((a, b) => a - b);
    const u0 = -L / 2 - geo.gableOv, u1 = L / 2 + geo.gableOv;
    // lean-to: which edge faces this wall decides what's visible; draw full outline either way
    // the deeper second eave (e.g. a coop's window side) hangs lower than the wall top by its extra overhang × pitch
    const pr = geo.profile, endSide = geo.ridgeAlongZ ? wall === 'right' : wall === 'front';
    const slopeEnd = Math.abs((pr[pr.length - 1][1] - pr[pr.length - 2][1]) / ((pr[pr.length - 1][0] - pr[pr.length - 2][0]) || 1));
    const extraDrop = endSide && ov2 > geo.eaveOv ? (ov2 - geo.eaveOv) * slopeEnd : 0;
    const yLow = hs[0] - 0.05 - extraDrop, yHigh = hs[hs.length - 1] + th;
    const fascia = (style.fascia_size ?? 5.5) / 12;
    o.push(`<rect x="${X(u0)}" y="${Y(yHigh)}" width="${(u1 - u0) * S}" height="${(yHigh - yLow) * S}" fill="${roofFill}" stroke="${roofStroke}" stroke-width="1.5"/>`);
    if (isMetal) for (let u = u0 + 0.75; u < u1; u += 0.75) o.push(`<line x1="${X(u)}" y1="${Y(yHigh)}" x2="${X(u)}" y2="${Y(yLow)}" stroke="#000" stroke-opacity="0.25" stroke-width="1"/>`);
    for (const h of hs.slice(1, -1)) o.push(`<line x1="${X(u0)}" y1="${Y(h + th)}" x2="${X(u1)}" y2="${Y(h + th)}" stroke="${roofStroke}" stroke-width="1"/>`);
    // fascia along the lowest eave on this side
    o.push(`<rect x="${X(u0)}" y="${Y(yLow + 0.02)}" width="${(u1 - u0) * S}" height="${fascia * S}" fill="#ffffff" stroke="${roofStroke}" stroke-width="1"/>`);
  }

  // --- openings and wall items on this wall
  const labels = [];
  for (const it of config.items || []) {
    if (it.wall !== wall) continue;
    const op = optById[it.option_id]; if (!op) continue;
    const p = resolvePlacement(geo, op, it);
    const x0 = X(p.offset - p.w / 2), x1 = X(p.offset + p.w / 2), y0 = Y(F + p.elev + p.h), y1 = Y(F + p.elev), wpx = x1 - x0, hpx = y1 - y0;
    const kind = op.kind || '', o2 = op;
    if (op.placement === 'opening' && kind === 'nest_box') {
      // outside nest box: hinge board, sloped lid, box front, end boards running below
      const D = Math.max(0.8, Number(op.depth) || 1.33), backTop = p.h + 0.15, frontTop = Math.max(p.h * 0.6, backTop - D * 0.38);
      const yb = F + p.elev, eb = 0.29 * S, xe0 = X(p.offset - p.w / 2 - 0.03), xe1 = X(p.offset + p.w / 2 + 0.03);
      o.push(`<rect x="${X(p.offset - p.w / 2 - 0.3)}" y="${Y(yb + backTop + 0.28)}" width="${(p.w + 0.6) * S}" height="${0.28 * S}" fill="#ffffff" stroke="#1d2624" stroke-width="1.2"/>`);
      o.push(`<polygon points="${xe0},${Y(yb + backTop)} ${xe1},${Y(yb + backTop)} ${xe1},${Y(yb + frontTop)} ${xe0},${Y(yb + frontTop)}" fill="${sidingHex}" fill-opacity="0.45" stroke="#1d2624" stroke-width="1.2"/>`);
      o.push(`<rect x="${x0}" y="${Y(yb + frontTop)}" width="${wpx}" height="${(frontTop + 0.1) * S}" fill="${sidingHex}" fill-opacity="0.35" stroke="#1d2624" stroke-width="1.4"/>`);
      if (!Number(op.no_corner_trim)) for (const xe of [xe0, xe1 - eb]) o.push(`<rect x="${xe}" y="${Y(yb + frontTop)}" width="${eb}" height="${(frontTop + 0.32) * S}" fill="#ffffff" stroke="#1d2624" stroke-width="1"/>`);
      labels.push({ x: (x0 + x1) / 2, text: `${shortName(op)} (${ftIn(p.w)} long)` });
      continue;
    }
    if (op.placement === 'opening') {
      const cas = (style.casing_trim ?? 4) / 12 * S;
      o.push(`<rect x="${x0 - cas}" y="${y0 - cas}" width="${wpx + 2 * cas}" height="${hpx + cas + (kind.startsWith('door') ? 0 : cas)}" fill="#ffffff" stroke="#1d2624" stroke-width="1.2"/>`);
      if (kind.startsWith('door')) {
        o.push(`<rect x="${x0}" y="${y0}" width="${wpx}" height="${hpx}" fill="${kind === 'door_coop' ? sidingHex : '#f4f3ef'}" fill-opacity="${kind === 'door_coop' ? 0.45 : 1}" stroke="#1d2624" stroke-width="1.6"/>`);
        if (kind === 'door_coop') { const b = 0.3 * S, mid = y1 - hpx * 0.47; o.push(`<path d="M${x0 + b} ${y0 + b}H${x1 - b}V${mid - b / 2}H${x0 + b}Z M${x0 + b} ${mid + b / 2}H${x1 - b}V${y1 - b}H${x0 + b}Z" fill="#ffffff" fill-opacity=".001" stroke="#1d2624" stroke-opacity=".7"/>`); }
        else if (kind === 'door_garage') {
          const car = o2.garage_panel === 'carriage', n = Math.max(3, Math.round(p.h / (car ? 2.25 : 1.75))), sh = hpx / n;
          const cols = Math.max(2, Math.round(p.w / 2.25)), mx = 0.3 * S, gp = 0.24 * S, pw = (wpx - 2 * mx - (cols - 1) * gp) / cols, ph = sh - (car ? 0.42 : 0.5) * S;
          for (let i = 0; i < n; i++) {
            const yt = y1 - (i + 1) * sh, yc = yt + sh / 2;
            if (i) o.push(`<line x1="${x0}" y1="${yt + sh}" x2="${x1}" y2="${yt + sh}" stroke="#1d2624" stroke-opacity=".6"/>`);
            if (Number(o2.garage_windows) && i === n - 1) {
              for (let c = 0; c + 1 < cols; c += 2) { const a = x0 + mx + c * (pw + gp), ww = 2 * pw + gp; o.push(`<rect x="${a}" y="${yc - ph * 0.46}" width="${ww}" height="${ph * 0.92}" fill="#3a4448" stroke="#1d2624"/>`); for (let k = 1; k < 6; k++) o.push(`<line x1="${a + ww * k / 6}" y1="${yc - ph * 0.46}" x2="${a + ww * k / 6}" y2="${yc + ph * 0.46}" stroke="#fff" stroke-width="1.3"/>`); o.push(`<line x1="${a}" y1="${yc}" x2="${a + ww}" y2="${yc}" stroke="#fff" stroke-width="1.3"/>`); }
              continue;
            }
            for (let c = 0; c < cols; c++) { const a = x0 + mx + c * (pw + gp); o.push(`<rect x="${a}" y="${yc - ph / 2}" width="${pw}" height="${ph}" fill="none" stroke="#1d2624" stroke-opacity=".55"/>`); if (car) for (let k = 1; k < 5; k++) o.push(`<line x1="${a + pw * k / 5}" y1="${yc - ph / 2 + 3}" x2="${a + pw * k / 5}" y2="${yc + ph / 2 - 3}" stroke="#1d2624" stroke-opacity=".35"/>`); }
          }
          if (car) { const hl = Math.min(1.25, p.w * 0.14) * S; for (const yy of [y1 - sh / 2, y1 - sh * (n - (Number(o2.garage_windows) ? 1.5 : 0.5))]) { o.push(`<path d="M${x0 + 2} ${yy}h${hl}M${x1 - 2} ${yy}h${-hl}" stroke="#1d2624" stroke-width="3"/>`); } const hy = y1 - sh * (Math.floor(n / 2) + 0.5 * (n % 2 ? 1 : 0.15)); for (const sx of [-1, 1]) o.push(`<line x1="${(x0 + x1) / 2 + sx * 0.16 * S}" y1="${hy - 0.31 * S}" x2="${(x0 + x1) / 2 + sx * 0.16 * S}" y2="${hy + 0.31 * S}" stroke="#1d2624" stroke-width="2.5"/>`); }
        }
        else if (kind === 'door_rollup') for (let k = 1; k < 12; k++) o.push(`<line x1="${x0}" y1="${y0 + hpx * k / 12}" x2="${x1}" y2="${y0 + hpx * k / 12}" stroke="#1d2624" stroke-opacity=".45"/>`);
        else if (kind === 'door_double' || kind === 'door_french') {
          o.push(`<line x1="${(x0 + x1) / 2}" y1="${y0}" x2="${(x0 + x1) / 2}" y2="${y1}" stroke="#1d2624" stroke-width="1.4"/>`);
          if (kind === 'door_double') for (const [a, b] of [[x0, (x0 + x1) / 2], [(x0 + x1) / 2, x1]]) o.push(`<path d="M${a} ${y0}L${b} ${y1}M${b} ${y0}L${a} ${y1}" stroke="#1d2624" stroke-opacity=".5" fill="none"/>`);
          else for (const [a, b] of [[x0, (x0 + x1) / 2], [(x0 + x1) / 2, x1]]) o.push(`<rect x="${a + 6}" y="${y0 + 6}" width="${b - a - 12}" height="${hpx * 0.75}" fill="#dfe8ee" stroke="#1d2624" stroke-opacity=".6"/>`);
        } else if (kind === 'door_carriage' || kind === 'door_carriage_right' || kind === 'door_carriage_double' || kind === 'door_panel' || kind === 'door_panel_double') {
          const nL = kind === 'door_carriage_double' || kind === 'door_panel_double' ? 2 : 1, lwp = (x1 - x0) / nL, win = kind.startsWith('door_carriage');
          for (let L = 0; L < nL; L++) {
            const a = x0 + L * lwp, b = a + lwp, st = lwp * 0.12, wt = y0 + hpx * 0.04, wb = wt + hpx * 0.16, mid = y0 + hpx * 0.56;
            if (L) o.push(`<line x1="${a}" y1="${y0}" x2="${a}" y2="${y1}" stroke="#1d2624"/>`);
            if (!win) { o.push(`<rect x="${a + st}" y="${y0 + hpx * 0.06}" width="${lwp - 2 * st}" height="${mid - y0 - hpx * 0.09}" fill="none" stroke="#1d2624" stroke-opacity=".6"/>`); o.push(`<rect x="${a + st}" y="${mid + hpx * 0.03}" width="${lwp - 2 * st}" height="${y1 - mid - hpx * 0.1}" fill="none" stroke="#1d2624" stroke-opacity=".6"/>`); continue; }
            o.push(`<rect x="${a + st}" y="${wt}" width="${lwp - 2 * st}" height="${wb - wt}" fill="#3a4448" stroke="#1d2624"/>`);
            for (let k = 1; k < 5; k++) o.push(`<line x1="${a + st + (lwp - 2 * st) * k / 5}" y1="${wt}" x2="${a + st + (lwp - 2 * st) * k / 5}" y2="${wb}" stroke="#ffffff" stroke-width="1.5"/>`);
            o.push(`<rect x="${a + st}" y="${wb + hpx * 0.05}" width="${lwp - 2 * st}" height="${mid - wb - hpx * 0.08}" fill="none" stroke="#1d2624" stroke-opacity=".6"/>`);
            o.push(`<rect x="${a + st}" y="${mid + hpx * 0.03}" width="${lwp - 2 * st}" height="${y1 - mid - hpx * 0.1}" fill="none" stroke="#1d2624" stroke-opacity=".6"/>`);
          }
        } else if (kind === 'door_glass') o.push(`<rect x="${x0 + wpx * 0.18}" y="${y0 + hpx * 0.08}" width="${wpx * 0.64}" height="${hpx * 0.4}" fill="#dfe8ee" stroke="#1d2624" stroke-opacity=".6"/>`);
        else { o.push(`<rect x="${x0 + wpx * 0.15}" y="${y0 + hpx * 0.08}" width="${wpx * 0.7}" height="${hpx * 0.36}" fill="none" stroke="#1d2624" stroke-opacity=".5"/><rect x="${x0 + wpx * 0.15}" y="${y0 + hpx * 0.54}" width="${wpx * 0.7}" height="${hpx * 0.36}" fill="none" stroke="#1d2624" stroke-opacity=".5"/>`); }
        if (Number(o2.slanted_corners)) { const c = Math.min(0.85, Math.max(0.4, p.w * 0.09)) * S; o.push(`<path d="M${x0} ${y0}h${c}L${x0} ${y0 + c}ZM${x1} ${y0}h${-c}L${x1} ${y0 + c}Z" fill="#ffffff" stroke="#1d2624" stroke-width="1.2"/>`); }
        if (kind !== 'door_rollup' && kind !== 'door_garage') o.push(`<circle cx="${kind === 'door_carriage_double' || kind === 'door_panel_double' ? (x0 + x1) / 2 + 9 : kind === 'door_double' || kind === 'door_french' ? (x0 + x1) / 2 + 7 : kind === 'door_panel' || kind === 'door_carriage_right' || kind === 'door_coop' ? x0 + 9 : x1 - 9}" cy="${y0 + hpx * 0.53}" r="3" fill="#1d2624"/>`);
      } else if (kind === 'pop_door') {
        o.push(`<rect x="${x0}" y="${y0}" width="${wpx}" height="${hpx}" fill="#3a4448" stroke="#1d2624" stroke-width="1.4"/>`);
        o.push(`<rect x="${x0 + 2}" y="${y1}" width="${wpx - 4}" height="${(F + p.elev) * S}" fill="${sidingHex}" fill-opacity="0.45" stroke="#1d2624" stroke-width="1"/>`);
        for (let k = 1; k < 4; k++) o.push(`<line x1="${x0 + 2}" y1="${y1 + (F + p.elev) * S * k / 4}" x2="${x1 - 2}" y2="${y1 + (F + p.elev) * S * k / 4}" stroke="#1d2624" stroke-opacity=".5"/>`);
      } else if (kind === 'vent') {
        o.push(`<rect x="${x0}" y="${y0}" width="${wpx}" height="${hpx}" fill="#ffffff" stroke="#1d2624" stroke-width="1.2"/>`);
        for (let k = 1; k < 5; k++) o.push(`<line x1="${x0}" y1="${y0 + hpx * k / 5}" x2="${x1}" y2="${y0 + hpx * k / 5}" stroke="#1d2624" stroke-opacity=".6"/>`);
      } else {
        o.push(`<rect x="${x0}" y="${y0}" width="${wpx}" height="${hpx}" fill="#dfe8ee" stroke="#1d2624" stroke-width="1.6"/>`);
        const pg = v => { if (v === undefined || v === null || v === '') return null; const m = String(v).match(/^(\d+)\s*[x×]\s*(\d+)$/i); return m ? [+m[1], +m[2]] : [1, 1]; };
        const gT = kind !== 'window_transom' && pg(o2.grid_top), gB = kind !== 'window_transom' && pg(o2.grid_bottom);
        const lines = (cols, rows, ya, yb) => {
          for (let k = 1; k < cols; k++) o.push(`<line x1="${x0 + wpx * k / cols}" y1="${ya}" x2="${x0 + wpx * k / cols}" y2="${yb}" stroke="#1d2624"/>`);
          for (let k = 1; k < rows; k++) o.push(`<line x1="${x0}" y1="${ya + (yb - ya) * k / rows}" x2="${x1}" y2="${ya + (yb - ya) * k / rows}" stroke="#1d2624"/>`);
        };
        if (gT || gB) {
          const ym = (y0 + y1) / 2;
          o.push(`<line x1="${x0}" y1="${ym}" x2="${x1}" y2="${ym}" stroke="#1d2624" stroke-width="2.4"/>`);
          lines(...(gT || [1, 1]), y0, ym - 1.2); lines(...(gB || [1, 1]), ym + 1.2, y1);
        } else {
          const cols = kind === 'window_transom' ? Math.max(2, Math.round(p.w / 1.2)) : p.w >= 3 ? 3 : 2, rows = kind === 'window_transom' ? 1 : 2;
          lines(cols, rows, y0, y1);
        }
        if (kind === 'window_shutters') for (const sx of [-1, 1]) { const sw = wpx * 0.5, xs = sx < 0 ? x0 - cas - sw - 2 : x1 + cas + 2; o.push(`<rect x="${xs}" y="${y0 - 3}" width="${sw}" height="${hpx + 6}" fill="#ffffff" stroke="#1d2624"/>`); for (let k = 1; k < 9; k++) o.push(`<line x1="${xs + 3}" y1="${y0 + hpx * k / 9}" x2="${xs + sw - 3}" y2="${y0 + hpx * k / 9}" stroke="#1d2624" stroke-opacity=".5"/>`); }
      }
      labels.push({ x: (x0 + x1) / 2, text: `${shortName(op)} (${ftIn(p.w)} × ${ftIn(p.h)})` });
    } else if (op.placement === 'wall_exterior') {
      o.push(`<rect x="${x0}" y="${y0}" width="${wpx}" height="${hpx}" fill="#ffffff" stroke="#1d2624" stroke-width="1.2"/>`);
      labels.push({ x: (x0 + x1) / 2, text: shortName(op) });
    } else if (op.placement === 'ground') {
      const rx0 = X(p.offset - p.w / 2), rx1 = X(p.offset + p.w / 2);
      o.push(`<polygon points="${rx0},${Y(0)} ${rx1},${Y(0)} ${rx1},${Y(F)} ${rx0},${Y(F)}" fill="#efe6d6" stroke="#1d2624" stroke-width="1"/>`);
      labels.push({ x: (rx0 + rx1) / 2, text: shortName(op) });
    }
  }
  // labels under the grade line: identical ones merged ("3 × Coop Window …"), each in the first row where it
  // doesn't run into its neighbour
  const merged = [];
  for (const l of labels) { const m = merged.find(x => x.text === l.text); if (m) m.xs.push(l.x); else merged.push({ text: l.text, xs: [l.x] }); }
  const rowEnd = [];
  merged.map(m => ({ x: m.xs.reduce((a, b) => a + b, 0) / m.xs.length, text: (m.xs.length > 1 ? `${m.xs.length} × ` : '') + m.text }))
    .sort((a, b) => a.x - b.x).forEach(l => {
      const half = l.text.length * 3.1 + 6;
      let row = rowEnd.findIndex(e => e < l.x - half); if (row < 0) row = Math.min(rowEnd.length, 2);
      rowEnd[row] = l.x + half;
      o.push(`<text x="${l.x}" y="${Y(0) + 20 + row * 14}" font-size="11" text-anchor="middle" fill="#3b4744">${esc(l.text)}</text>`);
    });

  // --- dimensions
  const dim = (x1, y1, x2, y2, text, vertical, off) => {
    const t = 6; let s = '';
    if (vertical) {
      s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#1d2624"/><line x1="${x1 - t}" y1="${y1}" x2="${x1 + t}" y2="${y1}" stroke="#1d2624"/><line x1="${x2 - t}" y1="${y2}" x2="${x2 + t}" y2="${y2}" stroke="#1d2624"/>`;
      const mx = x1 + (off || -10), my = (y1 + y2) / 2;
      s += `<text x="${mx}" y="${my}" font-size="13" font-weight="bold" text-anchor="middle" fill="#1d2624" transform="rotate(-90 ${mx} ${my})">${text}</text>`;
    } else {
      s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#1d2624"/><line x1="${x1}" y1="${y1 - t}" x2="${x1}" y2="${y1 + t}" stroke="#1d2624"/><line x1="${x2}" y1="${y2 - t}" x2="${x2}" y2="${y2 + t}" stroke="#1d2624"/>`;
      s += `<text x="${(x1 + x2) / 2}" y="${y1 + (off || 18)}" font-size="13" font-weight="bold" text-anchor="middle" fill="#1d2624">${text}</text>`;
    }
    return s;
  };
  o.push(dim(X(-L / 2), Y(0) + 58, X(L / 2), Y(0) + 58, ftIn(L), false, 18));
  const eaveTop = F + Math.min(geo.topAt(wall, -L / 2), geo.topAt(wall, L / 2));
  o.push(dim(X(-L / 2 - sideOv) - 40, Y(F), X(-L / 2 - sideOv) - 40, Y(eaveTop), `${ftIn(eaveTop - F)} wall`, true, -12));
  const ridge = F + H + geo.peak + th;
  o.push(dim(X(L / 2 + sideOv) + 40, Y(0), X(L / 2 + sideOv) + 40, Y(ridge), `${ftIn(ridge)} overall`, true, 16));

  // --- title
  const name = { front: 'FRONT', back: 'BACK', left: 'LEFT', right: 'RIGHT' }[wall];
  o.push(`<text x="${padL}" y="${Y(0) + 96}" font-size="16" font-weight="bold" fill="#1d2624" letter-spacing="1.5">${name} ELEVATION</text>`);
  o.push(`<text x="${padL + 175}" y="${Y(0) + 96}" font-size="11" fill="#7d8885">${esc(style.name)} ${size.width}' × ${size.depth}' · ${esc(roofName)}</text>`);
  o.push(`</svg>`);
  return { svg: o.join('\n'), width, height };
}
