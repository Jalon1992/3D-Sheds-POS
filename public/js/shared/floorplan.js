// Floor plan generator (top-down, to scale). Returns a standalone SVG string.
// Shared between browser (customer download) and server (API / admin download).
import { wallPoint, wallLength, roofingList } from './pricing.js';
import { itemSize, skidLayout } from './geometry.js';

/** "3 skids (4x4), 45\" on centre" for drawings and production notes */
export function skidNote(style, size) {
  const k = skidLayout(style, size);
  return `${k.count} skid${k.count === 1 ? '' : 's'} (${k.lumber})${k.count > 1 ? `, ${k.spacingIn}" on centre` : ''}`;
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtFt(ft) {
  const f = Math.floor(ft + 1e-6), i = Math.round((ft - f) * 12);
  return i ? `${f}'-${i}"` : `${f}'-0"`;
}

/**
 * @param catalog  { styles, options, colors, settings }
 * @param config   sanitised configuration
 * @param meta     { customer, quote_number, date }
 */
export function floorPlanSVG(catalog, config, meta = {}) {
  const style = catalog.styles.find(s => s.id === config.style_id);
  const size = style.sizes.find(s => s.id === config.size_id);
  const optById = Object.fromEntries(catalog.options.map(o => [o.id, o]));
  const W = size.width, D = size.depth;
  const S = 40;                         // px per foot
  const groundExtra = Math.max(0, ...(config.items || []).map(it => optById[it.option_id]).filter(o => o && o.placement === 'ground').map(o => (o.depth || 3) * S));
  const margin = 210 + groundExtra, titleH = 120;
  const vbW = W * S + margin * 2, vbH = D * S + margin * 2 + titleH;
  const ox = margin + (W * S) / 2, oz = margin + (D * S) / 2;  // world (0,0) in svg
  const X = x => ox + x * S, Z = z => oz + z * S;
  const T = 0.33 * S; // wall thickness px
  const out = [];
  const settings = catalog.settings || {};
  const accent = settings.brand_color || '#1f6f5c';

  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vbW} ${vbH}" width="${vbW}" height="${vbH}" font-family="Helvetica, Arial, sans-serif">`);
  out.push(`<defs><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="#9aa5a1" stroke-width="1.5"/></pattern>
  <pattern id="grid" width="${S}" height="${S}" patternUnits="userSpaceOnUse"><path d="M ${S} 0 L 0 0 0 ${S}" fill="none" stroke="#e4e9e7" stroke-width="1"/></pattern></defs>`);
  out.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  // floor grid
  out.push(`<rect x="${X(-W / 2)}" y="${Z(-D / 2)}" width="${W * S}" height="${D * S}" fill="url(#grid)"/>`);
  // skids under the floor (dashed: hidden below), running front to back
  const skl = skidLayout(style, size); for (const x of skl.xs) out.push(`<rect x="${X(x - skl.w / 2)}" y="${Z(-D / 2)}" width="${skl.w * S}" height="${D * S}" fill="none" stroke="#8a7a5c" stroke-width="1" stroke-dasharray="6 4"/>`);

  // Openings by wall to cut gaps
  const items = (config.items || []).filter(it => optById[it.option_id]).map(it => { const o = optById[it.option_id]; const z = itemSize(o, it); return { it, o: { ...o, width: z.w, height: z.h } }; });
  const gaps = { front: [], back: [], left: [], right: [] };
  const iw = (o, it) => (Number(it.w) > 0 ? Number(it.w) : Number(o.width) || 1);
  for (const { it, o } of items) if (o.placement === 'opening' && gaps[it.wall] && !it.gable && o.gable_mode !== 'only' && o.kind !== 'vent') gaps[it.wall].push([it.offset - iw(o, it) / 2, it.offset + iw(o, it) / 2, o, it]);

  // Walls with gaps
  for (const wall of ['front', 'back', 'left', 'right']) {
    const L = wallLength(wall, size);
    const segs = [];
    let cur = -L / 2;
    const gs = gaps[wall].map(g => [g[0], g[1]]).sort((a, b) => a[0] - b[0]);
    for (const [a, b] of gs) { if (a > cur) segs.push([cur, a]); cur = Math.max(cur, b); }
    if (cur < L / 2) segs.push([cur, L / 2]);
    for (const [a, b] of segs) {
      const p1 = wallPoint(wall, a, size), p2 = wallPoint(wall, b, size);
      // inset by half thickness so walls sit inside footprint
      const ix = -p1.nx * T / 2, iz = -p1.nz * T / 2;
      out.push(`<line x1="${X(p1.x) + ix}" y1="${Z(p1.z) + iz}" x2="${X(p2.x) + ix}" y2="${Z(p2.z) + iz}" stroke="#1d2624" stroke-width="${T}" stroke-linecap="square"/>`);
    }
  }

  // Items
  const elec = new Set();
  for (const { it, o } of items) {
    const kind = o.kind || '';
    if (o.placement === 'opening') {
      const p = wallPoint(it.wall, it.offset, size);
      const w = iw(o, it) * S;
      const ang = Math.atan2(p.nz, p.nx) * 180 / Math.PI - 90; // rotate so local +x runs along the wall
      const cx = X(p.x) - p.nx * T / 2, cz = Z(p.z) - p.nz * T / 2;
      out.push(`<g transform="translate(${cx} ${cz}) rotate(${ang})">`);
      // local frame: x along wall, +y = outward
      if (kind === 'nest_box') {
        // outside nest box: drawn outside the wall, with the nest compartments
        const dd = Math.max(0.8, Number(o.depth) || 1.33) * S, nn = Math.max(1, Math.round(iw(o, it)));
        out.push(`<line x1="${-w / 2}" y1="0" x2="${w / 2}" y2="0" stroke="#fff" stroke-width="${T - 2}"/>`);
        out.push(`<rect x="${-w / 2}" y="${T / 2}" width="${w}" height="${dd}" fill="#f4efe4" stroke="#1d2624" stroke-width="1.5"/>`);
        for (let k = 1; k < nn; k++) out.push(`<line x1="${-w / 2 + w * k / nn}" y1="${T / 2}" x2="${-w / 2 + w * k / nn}" y2="${T / 2 + dd}" stroke="#1d2624" stroke-opacity=".5"/>`);
      } else if (kind === 'pop_door') {
        const rd = Math.max(1.4, Number(o.depth) || 2.5) * S;
        out.push(`<line x1="${-w / 2}" y1="0" x2="${w / 2}" y2="0" stroke="#fff" stroke-width="${T + 2}"/>`);
        out.push(`<rect x="${-w / 2}" y="${T / 2}" width="${w}" height="${rd}" fill="#efe6d6" stroke="#1d2624" stroke-width="1"/>`);
        for (let k = 1; k < 5; k++) out.push(`<line x1="${-w / 2}" y1="${T / 2 + rd * k / 5}" x2="${w / 2}" y2="${T / 2 + rd * k / 5}" stroke="#1d2624" stroke-opacity=".4"/>`);
      } else if (kind.startsWith('door')) {
        if (kind === 'door_rollup') {
          out.push(`<line x1="${-w / 2}" y1="0" x2="${w / 2}" y2="0" stroke="#1d2624" stroke-width="2" stroke-dasharray="6 4"/>`);
          out.push(`<rect x="${-w / 2}" y="${-T / 2}" width="${w}" height="${T}" fill="none" stroke="#1d2624" stroke-width="1"/>`);
        } else {
          const leaves = (kind === 'door_double' || kind === 'door_french' || kind === 'door_carriage_double' || kind === 'door_panel_double') ? 2 : 1;
          const lw = w / leaves;
          out.push(`<line x1="${-w / 2}" y1="0" x2="${w / 2}" y2="0" stroke="#fff" stroke-width="${T + 2}"/>`);
          for (let k = 0; k < leaves; k++) {
            // swing inward (local -y)
            const hinge = leaves === 2 ? (k === 0 ? -w / 2 : w / 2) : (kind === 'door_panel' || kind === 'door_carriage_right' || kind === 'door_coop' ? w / 2 : -w / 2);
            const dir = hinge < 0 ? 1 : -1;
            out.push(`<line x1="${hinge}" y1="${-T / 2}" x2="${hinge}" y2="${-T / 2 - lw}" stroke="#1d2624" stroke-width="3"/>`);
            out.push(`<path d="M ${hinge} ${-T / 2 - lw} A ${lw} ${lw} 0 0 ${dir > 0 ? 1 : 0} ${hinge + dir * lw} ${-T / 2}" fill="none" stroke="#1d2624" stroke-width="1.2" stroke-dasharray="4 3"/>`);
          }
        }
      } else if (kind.startsWith('window') || kind === 'vent') {
        out.push(`<rect x="${-w / 2}" y="${-T / 2}" width="${w}" height="${T}" fill="#fff" stroke="#1d2624" stroke-width="1.5"/>`);
        out.push(`<line x1="${-w / 2}" y1="0" x2="${w / 2}" y2="0" stroke="#1d2624" stroke-width="1.5"/>`);
      }
      out.push(`</g>`);
      // label outside
      // label just outside the wall; side-wall labels are anchored away from the wall so they never overlap it
      // a window above an outside nest box: its label goes past the box; the nest box is labelled inside its outline
      if (kind === 'nest_box') { const dd = Math.max(0.8, Number(o.depth) || 1.33) * S; out.push(`<text x="${X(p.x) + p.nx * (T / 2 + dd / 2)}" y="${Z(p.z) + p.nz * (T / 2 + dd / 2) + 4}" font-size="11" text-anchor="middle" fill="#3b4744" transform="rotate(${p.nx ? -90 : 0} ${X(p.x) + p.nx * (T / 2 + dd / 2)} ${Z(p.z) + p.nz * (T / 2 + dd / 2)})">${esc(shortName(o))}</text>`); continue; }
      const nest = items.find(r => r.o.kind === 'nest_box' && r.it.wall === it.wall && Math.abs((r.it.offset || 0) - (it.offset || 0)) < iw(r.o, r.it) / 2 + 0.2);
      const push = nest ? Math.max(0.8, Number(nest.o.depth) || 1.33) * S : 0;
      const lp = { x: X(p.x) + p.nx * (22 + push), z: Z(p.z) + p.nz * (30 + push) };
      const anchor = p.nx < 0 ? 'end' : p.nx > 0 ? 'start' : 'middle';
      out.push(`<text x="${lp.x}" y="${lp.z + 4}" font-size="12" text-anchor="${anchor}" fill="#3b4744">${esc(shortName(o) + (it.gable || o.gable_mode === 'only' ? ' (in gable)' : ''))}</text>`);
      continue;
    }
    if (o.placement === 'wall_interior' || o.placement === 'floor') {
      const p = wallPoint(it.wall, it.offset, size);
      // full-length built-ins (e.g. 12' shelves on a 12' wall) are drawn fitted between the walls
      const w = (String(o.length_choices || '').trim() ? Math.min(iw(o, it), wallLength(it.wall, size) - 0.68) : iw(o, it)) * S, d = Math.max(0.3, o.depth || 1) * S;
      const ang = Math.atan2(p.nz, p.nx) * 180 / Math.PI - 90;
      const cx = X(p.x) - p.nx * T, cz = Z(p.z) - p.nz * T;
      out.push(`<g transform="translate(${cx} ${cz}) rotate(${ang})">`);
      if (kind === 'outlet') {
        out.push(`<circle cx="0" cy="${-8}" r="7" fill="#fff" stroke="#1d2624" stroke-width="1.5"/><line x1="-3" y1="-14" x2="-3" y2="-2" stroke="#1d2624"/><line x1="3" y1="-14" x2="3" y2="-2" stroke="#1d2624"/>`);
        elec.add('outlet');
      } else if (kind === 'switch') {
        out.push(`<text x="0" y="-4" font-size="15" font-weight="bold" text-anchor="middle" fill="#1d2624" transform="rotate(${-ang} 0 -9)">S</text>`);
        elec.add('switch');
      } else if (kind === 'breaker') {
        out.push(`<rect x="${-w / 2}" y="${-Math.max(d, 10)}" width="${w}" height="${Math.max(d, 10)}" fill="#1d2624"/><text x="0" y="${-Math.max(d, 10) - 6}" font-size="11" font-weight="bold" text-anchor="middle" fill="#1d2624" transform="rotate(${-ang} 0 ${-Math.max(d, 10) - 10})">PANEL</text>`);
        elec.add('breaker');
      } else {
        out.push(`<rect x="${-w / 2}" y="${-d}" width="${w}" height="${d}" fill="${kind === 'workbench' ? '#efe6d6' : 'none'}" stroke="#55615e" stroke-width="1.5" ${kind.startsWith('shelf') ? 'stroke-dasharray="6 3"' : ''}/>`);
        out.push(`<text x="0" y="${-d / 2 + 4}" font-size="11" text-anchor="middle" fill="#3b4744" transform="rotate(${-ang} 0 ${-d / 2})">${esc(shortName(o))}</text>`);
      }
      out.push(`</g>`);
      continue;
    }
    if (o.placement === 'loft') {
      const wall = it.wall || 'back';
      const p = wallPoint(wall, 0, size);
      const L = wallLength(wall, size), d = (o.depth || 4) * S;
      const ang = Math.atan2(p.nz, p.nx) * 180 / Math.PI - 90;
      out.push(`<g transform="translate(${X(p.x) - p.nx * T} ${Z(p.z) - p.nz * T}) rotate(${ang})">`);
      out.push(`<rect x="${-L * S / 2 + T}" y="${-d}" width="${L * S - 2 * T}" height="${d}" fill="url(#hatch)" fill-opacity=".5" stroke="#55615e" stroke-dasharray="8 4"/>`);
      out.push(`<text x="0" y="${-d / 2 + 4}" font-size="12" text-anchor="middle" fill="#1d2624" font-weight="bold" transform="rotate(${-ang} 0 ${-d / 2})">LOFT ABOVE (${o.depth || 4}')</text></g>`);
      continue;
    }
    if (o.placement === 'ceiling') {
      // ceiling items run along the ridge
      const alongZ = style.ridge_axis !== 'width';
      const cx = alongZ ? X(0) : X(it.offset || 0), cz = alongZ ? Z(it.offset || 0) : Z(0);
      elec.add('light');
      out.push(`<circle cx="${cx}" cy="${cz}" r="10" fill="#fff" stroke="#1d2624" stroke-width="1.5"/><path d="M ${cx - 7} ${cz - 7} L ${cx + 7} ${cz + 7} M ${cx + 7} ${cz - 7} L ${cx - 7} ${cz + 7}" stroke="#1d2624" stroke-width="1.5"/>`);
      continue;
    }
    if (o.placement === 'ground') {
      const p = wallPoint(it.wall, it.offset, size);
      const w = o.width * S, d = (o.depth || 3) * S;
      const ang = Math.atan2(p.nz, p.nx) * 180 / Math.PI - 90;
      out.push(`<g transform="translate(${X(p.x)} ${Z(p.z)}) rotate(${ang})"><rect x="${-w / 2}" y="0" width="${w}" height="${d}" fill="#f4f1ea" stroke="#8a8f8d" stroke-width="1.2"/>`);
      for (let k = 1; k < 5; k++) out.push(`<line x1="${-w / 2}" y1="${(d * k) / 5}" x2="${w / 2}" y2="${(d * k) / 5}" stroke="#c8c4bb"/>`);
      out.push(`</g>`);
    }
  }

  // Dimensions
  const dimY = Z(D / 2) + 84 + groundExtra, dimX = X(-W / 2) - 190;
  out.push(dimLine(X(-W / 2), dimY, X(W / 2), dimY, fmtFt(W), false));
  out.push(dimLine(dimX, Z(-D / 2), dimX, Z(D / 2), fmtFt(D), true));
  // Wall labels
  out.push(`<text x="${X(0)}" y="${Z(D / 2) + 56 + groundExtra}" font-size="13" font-weight="bold" text-anchor="middle" fill="${accent}" letter-spacing="2">FRONT</text>`);
  out.push(`<text x="${X(0)}" y="${Z(-D / 2) - 52}" font-size="13" font-weight="bold" text-anchor="middle" fill="#7d8885" letter-spacing="2">BACK</text>`);
  out.push(`<text x="${X(W / 2) + 175}" y="${Z(0)}" font-size="13" font-weight="bold" text-anchor="middle" fill="#7d8885" letter-spacing="2" transform="rotate(90 ${X(W / 2) + 175} ${Z(0)})">RIGHT</text>`);
  out.push(`<text x="${X(-W / 2) - 160}" y="${Z(0)}" font-size="13" font-weight="bold" text-anchor="middle" fill="#7d8885" letter-spacing="2" transform="rotate(-90 ${X(-W / 2) - 160} ${Z(0)})">LEFT</text>`);

  // Title block
  const ty = vbH - titleH + 10;
  out.push(`<line x1="20" y1="${ty}" x2="${vbW - 20}" y2="${ty}" stroke="${accent}" stroke-width="3"/>`);
  out.push(`<text x="24" y="${ty + 30}" font-size="20" font-weight="bold" fill="#1d2624">${esc(style.name)} — ${size.width}' x ${size.depth}' (${size.width * size.depth} sq ft)</text>`);
  const c = meta.customer || {};
  const who = [c.first_name, c.last_name].filter(Boolean).join(' ');
  out.push(`<text x="24" y="${ty + 54}" font-size="13" fill="#3b4744">${esc(settings.company_name || '')}${who ? ' · Prepared for ' + esc(who) : ''}${meta.quote_number ? ' · Quote ' + esc(meta.quote_number) : ''}</text>`);
  const roofName = (roofingList(catalog).find(r => r.key === config.roof_material) || {}).name;
  out.push(`<text x="24" y="${ty + 74}" font-size="12" fill="#7d8885">${roofName ? esc(roofName) + ' roof · ' : ''}${esc(meta.date || new Date().toLocaleDateString('en-US'))} · ${esc(skidNote(style, size))} (dashed) · Scale: 1 grid square = 1 ft · Door swings shown inward</text>`);
  // electrical legend
  if (elec.size) {
    const L = [['outlet', 'Outlet'], ['switch', 'Switch'], ['light', 'Ceiling light'], ['breaker', 'Breaker panel']].filter(([k]) => elec.has(k));
    let lx = vbW - 24;
    for (const [k, label] of L.reverse()) {
      const tw = label.length * 6.4 + 30; lx -= tw;
      const sy = ty + 26;
      if (k === 'outlet') out.push(`<circle cx="${lx + 8}" cy="${sy}" r="7" fill="#fff" stroke="#1d2624" stroke-width="1.5"/><line x1="${lx + 5}" y1="${sy - 5}" x2="${lx + 5}" y2="${sy + 5}" stroke="#1d2624"/><line x1="${lx + 11}" y1="${sy - 5}" x2="${lx + 11}" y2="${sy + 5}" stroke="#1d2624"/>`);
      if (k === 'switch') out.push(`<text x="${lx + 8}" y="${sy + 5}" font-size="15" font-weight="bold" text-anchor="middle" fill="#1d2624">S</text>`);
      if (k === 'light') out.push(`<circle cx="${lx + 8}" cy="${sy}" r="8" fill="#fff" stroke="#1d2624" stroke-width="1.5"/><path d="M ${lx + 3} ${sy - 5} L ${lx + 13} ${sy + 5} M ${lx + 13} ${sy - 5} L ${lx + 3} ${sy + 5}" stroke="#1d2624" stroke-width="1.5"/>`);
      if (k === 'breaker') out.push(`<rect x="${lx}" y="${sy - 5}" width="16" height="10" fill="#1d2624"/>`);
      out.push(`<text x="${lx + 21}" y="${sy + 4}" font-size="12" fill="#3b4744">${label}</text>`);
    }
  }
  out.push(`</svg>`);
  return out.join('\n');
}

function dimLine(x1, y1, x2, y2, label, vertical) {
  const t = 8;
  const ticks = vertical
    ? `<line x1="${x1 - t}" y1="${y1}" x2="${x1 + t}" y2="${y1}" stroke="#1d2624"/><line x1="${x2 - t}" y1="${y2}" x2="${x2 + t}" y2="${y2}" stroke="#1d2624"/>`
    : `<line x1="${x1}" y1="${y1 - t}" x2="${x1}" y2="${y1 + t}" stroke="#1d2624"/><line x1="${x2}" y1="${y2 - t}" x2="${x2}" y2="${y2 + t}" stroke="#1d2624"/>`;
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const txt = vertical
    ? `<text x="${mx - 8}" y="${my}" font-size="15" font-weight="bold" text-anchor="middle" fill="#1d2624" transform="rotate(-90 ${mx - 8} ${my})">${label}</text>`
    : `<text x="${mx}" y="${my - 8}" font-size="15" font-weight="bold" text-anchor="middle" fill="#1d2624">${label}</text>`;
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#1d2624" stroke-width="1"/>${ticks}${txt}`;
}

function shortName(o) { return o.plan_label || o.name.replace(/\s*\(.*\)$/, ''); }
