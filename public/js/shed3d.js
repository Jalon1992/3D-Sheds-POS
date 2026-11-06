// 3D shed renderer (Three.js). Builds a shed procedurally from a style/size/config,
// renders built-in models for every option kind, supports custom .glb models,
// click-to-select, interior view, camera presets and GLB export.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { shedGeometry, resolvePlacement, FLOOR_Y, WALL_T, rakeTailLevel } from './shared/geometry.js';

const T = WALL_T;

// ---------------------------------------------------------------------------
// Procedural textures (grayscale; multiplied by the chosen colour)
// ---------------------------------------------------------------------------
const texCache = {};
function canvasTex(key, size, draw, tileFt) {
  if (texCache[key]) return texCache[key];
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); draw(g, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  t.userData.tileFt = tileFt;
  return (texCache[key] = t);
}
function noise(g, n, a, b, alpha = 0.05) {
  for (let i = 0; i < a * b / 6; i++) {
    g.fillStyle = `rgba(${Math.random() > .5 ? '0,0,0' : '255,255,255'},${Math.random() * alpha})`;
    g.fillRect(Math.random() * a, Math.random() * b, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }
}
// ---- LP SmartSide: embossed cedar-grain engineered wood -------------------------------
// Panel siding: 4 ft tile, V-grooves every 8" o.c. Grain runs vertically (panels stand vertical).
function cedarGrain(g, n, seedStart, strength, vertical = true) {
  let seed = seedStart; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n * 1.6; i++) {
    const a = rnd() * n, len = 30 + rnd() * 180, w = 1 + rnd() * 2.2, off = rnd() * n;
    const v = rnd() > 0.5 ? 0 : 255, alpha = (0.03 + rnd() * 0.07) * strength;
    g.strokeStyle = `rgba(${v},${v},${v},${alpha})`; g.lineWidth = w;
    g.beginPath();
    const wob = 2 + rnd() * 5;
    if (vertical) { g.moveTo(a, off); g.bezierCurveTo(a + wob, off + len / 3, a - wob, off + 2 * len / 3, a + rnd() * 2, off + len); }
    else { g.moveTo(off, a); g.bezierCurveTo(off + len / 3, a + wob, off + 2 * len / 3, a - wob, off + len, a + rnd() * 2); }
    g.stroke();
  }
}
const lpPanel = bump => canvasTex(bump ? 'lp-panel-bump' : 'lp-panel', 1024, (g, n) => {
  g.fillStyle = bump ? '#9a9a9a' : '#ededed'; g.fillRect(0, 0, n, n);
  // Painted finish: the cedar emboss shows only as light relief (bump map), never as colour streaks.
  if (bump) cedarGrain(g, n, 11, 1.4, true);
  else noise(g, n, n, n, 0.008);
  const step = n / 6; // 6 grooves per 4 ft = 8" o.c.
  for (let i = 0; i < 6; i++) {
    const x = i * step;
    // V-groove: dark centre, shaded walls
    const gr = g.createLinearGradient(x - 7, 0, x + 7, 0);
    if (bump) { gr.addColorStop(0, '#9a9a9a'); gr.addColorStop(0.5, '#000'); gr.addColorStop(1, '#9a9a9a'); }
    else { gr.addColorStop(0, 'rgba(0,0,0,0.05)'); gr.addColorStop(0.45, 'rgba(0,0,0,0.42)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.30)'); gr.addColorStop(1, 'rgba(255,255,255,0.25)'); }
    g.fillStyle = gr; g.fillRect(x - 7, 0, 14, n);
  }
}, 4);
// Trim: short cedar flecks in both directions so grain reads on every face of a board.
const lpTrim = bump => canvasTex(bump ? 'lp-trim-bump' : 'lp-trim', 256, (g, n) => {
  g.fillStyle = bump ? '#9a9a9a' : '#eeeeee'; g.fillRect(0, 0, n, n);
  if (bump) { cedarGrain(g, n, 23, 1.6, true); cedarGrain(g, n, 37, 0.8, false); }
  else noise(g, n, n, n, 0.008);
}, 1);

const SIDING = {
  lp_smartside: () => lpPanel(false),
  lap: () => canvasTex('lap', 512, (g, n) => {
    g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, n, n);
    const row = n / 8; // 6" exposure on a 4' tile
    for (let i = 0; i < 8; i++) {
      const y = i * row;
      const grd = g.createLinearGradient(0, y, 0, y + row);
      grd.addColorStop(0, '#d2d2d2'); grd.addColorStop(0.12, '#f7f7f7'); grd.addColorStop(1, '#e6e6e6');
      g.fillStyle = grd; g.fillRect(0, y, n, row);
      g.fillStyle = '#9a9a9a'; g.fillRect(0, y + row - 2, n, 2);
    }
    noise(g, n, n, n, 0.04);
  }, 4),
  board_batten: () => canvasTex('bb', 512, (g, n) => {
    g.fillStyle = '#ececec'; g.fillRect(0, 0, n, n);
    const step = n / 4; // 12" o.c.
    for (let i = 0; i < 4; i++) {
      const x = i * step;
      g.fillStyle = '#a9a9a9'; g.fillRect(x + step / 2 - 14, 0, 4, n);
      g.fillStyle = '#ffffff'; g.fillRect(x + step / 2 - 10, 0, 18, n);
      g.fillStyle = '#c4c4c4'; g.fillRect(x + step / 2 + 8, 0, 4, n);
    }
    noise(g, n, n, n, 0.035);
  }, 4),
  t111: () => canvasTex('t111', 512, (g, n) => {
    g.fillStyle = '#efefef'; g.fillRect(0, 0, n, n);
    for (let y = 0; y < n; y += 3) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.03})`; g.fillRect(0, y, n, 2); }
    const step = n / 6; // 8" o.c.
    for (let i = 0; i < 6; i++) { g.fillStyle = '#8f8f8f'; g.fillRect(i * step, 0, 5, n); g.fillStyle = '#ffffff'; g.fillRect(i * step + 5, 0, 2, n); }
    noise(g, n, n, n, 0.04);
  }, 4),
  metal: () => canvasTex('metalw', 512, (g, n) => {
    g.fillStyle = '#e9e9e9'; g.fillRect(0, 0, n, n);
    const step = n / 4.5;
    for (let i = 0; i < 5; i++) {
      const x = i * step;
      const grd = g.createLinearGradient(x, 0, x + 26, 0);
      grd.addColorStop(0, '#b5b5b5'); grd.addColorStop(0.5, '#ffffff'); grd.addColorStop(1, '#bdbdbd');
      g.fillStyle = grd; g.fillRect(x, 0, 26, n);
    }
  }, 3),
};
// Architectural (dimensional/laminated) shingles. Texture x runs down the slope, y along the ridge.
// Tile = 4 ft; 8 courses of ~5.6" exposure with random-width tabs and shade variation.
const shingleTex = () => canvasTex('arch-shingle', 1024, (g, n) => {
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.fillStyle = '#9a9a9a'; g.fillRect(0, 0, n, n);
  const rows = 8, rw = n / rows;
  for (let r = 0; r < rows; r++) {
    const x = r * rw;
    // base layer (darker, shows through gaps between tabs)
    g.fillStyle = '#6e6e6e'; g.fillRect(x, 0, rw, n);
    let y = -rnd() * 60;
    while (y < n) {
      const len = 40 + rnd() * 110;            // tab width along the ridge
      const v = 150 + Math.floor(rnd() * 90);   // shade variation
      const depth = rw * (0.62 + rnd() * 0.3);  // dragon-tooth tab length
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(x + rw - depth, y + 2, depth - 3, len - 4);
      // granule speckle
      for (let k = 0; k < len * depth / 40; k++) {
        const s2 = v + (rnd() - 0.5) * 70;
        g.fillStyle = `rgb(${s2},${s2},${s2})`;
        g.fillRect(x + rw - depth + rnd() * depth, y + rnd() * len, 2, 2);
      }
      y += len;
    }
    // shadow line under the course above + highlight on the butt edge
    const sh = g.createLinearGradient(x, 0, x + 14, 0);
    sh.addColorStop(0, 'rgba(0,0,0,.55)'); sh.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sh; g.fillRect(x, 0, 14, n);
    g.fillStyle = 'rgba(255,255,255,.18)'; g.fillRect(x + rw - 3, 0, 2, n);
  }
}, 4);
// Ag panel (exposed-fastener ribbed steel). 3 ft coverage panels: major ribs every 9", two minor ribs
// between, screw rows every 2 ft down the slope. Ribs run DOWN the slope (texture x).
const metalRoofTex = () => canvasTex('ag-panel', 1024, (g, n) => {
  g.fillStyle = '#d9d9d9'; g.fillRect(0, 0, n, n);
  const ribs = 4, step = n / ribs;              // 4 major ribs per 3 ft tile = 9" o.c.
  for (let i = 0; i < ribs; i++) {
    const y = i * step;
    // flat pan subtle sheen
    const pan = g.createLinearGradient(0, y, 0, y + step);
    pan.addColorStop(0, '#d2d2d2'); pan.addColorStop(0.5, '#e3e3e3'); pan.addColorStop(1, '#d0d0d0');
    g.fillStyle = pan; g.fillRect(0, y, n, step);
    // minor ribs
    for (const f of [0.36, 0.64]) { g.fillStyle = 'rgba(0,0,0,.14)'; g.fillRect(0, y + step * f, n, 3); g.fillStyle = 'rgba(255,255,255,.5)'; g.fillRect(0, y + step * f - 2, n, 2); }
    // major trapezoidal rib
    const rh = 34, rib = g.createLinearGradient(0, y - rh / 2, 0, y + rh / 2);
    rib.addColorStop(0, '#8e8e8e'); rib.addColorStop(0.18, '#bdbdbd'); rib.addColorStop(0.35, '#ffffff');
    rib.addColorStop(0.65, '#f2f2f2'); rib.addColorStop(0.82, '#a5a5a5'); rib.addColorStop(1, '#7a7a7a');
    g.fillStyle = rib; g.fillRect(0, y - rh / 2, n, rh);
  }
  // panel side-lap seam (every 3 ft = once per tile) – slightly darker rib
  g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(0, 0, n, 4);
  // fastener rows every ~2 ft (texture is 3 ft → at 1/3 and 2/3... use 2 rows per tile)
  for (const fx of [0.18, 0.68]) {
    for (let i = 0; i < ribs; i++) for (const off of [0.2, 0.8]) {
      const cx = n * fx, cy = i * step + step * off;
      g.fillStyle = 'rgba(0,0,0,.35)'; g.beginPath(); g.arc(cx + 1.5, cy + 1.5, 5, 0, 7); g.fill();
      g.fillStyle = '#f0f0f0'; g.beginPath(); g.arc(cx, cy, 5, 0, 7); g.fill();
    }
  }
}, 3);
const osbTex = () => canvasTex('osb', 256, (g, n) => {
  g.fillStyle = '#d8bf91'; g.fillRect(0, 0, n, n);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(${120 + Math.random() * 80},${90 + Math.random() * 50},${40 + Math.random() * 30},${0.35})`;
    g.save(); g.translate(Math.random() * n, Math.random() * n); g.rotate(Math.random() * Math.PI);
    g.fillRect(0, 0, 4 + Math.random() * 14, 2 + Math.random() * 4); g.restore();
  }
}, 4);
const plyTex = () => canvasTex('ply', 256, (g, n) => {
  g.fillStyle = '#d9b98a'; g.fillRect(0, 0, n, n);
  for (let y = 0; y < n; y += 2) { g.fillStyle = `rgba(110,70,30,${Math.random() * 0.12})`; g.fillRect(0, y, n, 1 + Math.random() * 2); }
  g.fillStyle = 'rgba(80,50,20,.4)'; g.fillRect(0, n - 2, n, 2); g.fillRect(n - 2, 0, 2, n);
}, 4);
const grassTex = () => canvasTex('grass', 256, (g, n) => {
  g.fillStyle = '#7f9a5c'; g.fillRect(0, 0, n, n);
  for (let i = 0; i < 6000; i++) { g.fillStyle = `rgba(${60 + Math.random() * 70},${100 + Math.random() * 70},${30 + Math.random() * 40},.5)`; g.fillRect(Math.random() * n, Math.random() * n, 1, 2 + Math.random() * 3); }
}, 6);
const gravelTex = () => canvasTex('gravel', 256, (g, n) => {
  g.fillStyle = '#b9b2a5'; g.fillRect(0, 0, n, n);
  for (let i = 0; i < 4000; i++) { const v = 130 + Math.random() * 110; g.fillStyle = `rgb(${v},${v - 6},${v - 14})`; g.beginPath(); g.arc(Math.random() * n, Math.random() * n, Math.random() * 2.2, 0, 7); g.fill(); }
}, 3);

function tiled(tex, uFt, vFt) {
  const t = tex.clone(); t.needsUpdate = true;
  t.repeat.set(uFt / tex.userData.tileFt, vFt / tex.userData.tileFt);
  return t;
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------
function makeMaterials(style, colors) {
  const c = (hex, d) => new THREE.Color(hex || d);
  const sidingType = style.siding_type || 'lp_smartside';
  const sidingTex = (SIDING[sidingType] || SIDING.lp_smartside)();
  const siding = new THREE.MeshStandardMaterial({ color: c(colors.siding, '#c2b49a'), map: sidingTex, roughness: sidingType === 'metal' ? 0.45 : 0.85, metalness: sidingType === 'metal' ? 0.25 : 0 });
  siding.map.repeat.set(1 / sidingTex.userData.tileFt, 1 / sidingTex.userData.tileFt);
  if (sidingType === 'lp_smartside') {
    const b = lpPanel(true); b.colorSpace = THREE.NoColorSpace; b.repeat.set(1 / 4, 1 / 4);
    siding.bumpMap = b; siding.bumpScale = 1.1;
  }
  // Wood trim: LP SmartSide trim (embossed cedar) unless the style asks for smooth trim. Metal trim stays smooth.
  const trim = new THREE.MeshStandardMaterial({ color: c(colors.trim, '#f4f4ef'), roughness: 0.78 });
  if ((style.trim_type || 'lp') === 'lp') {
    const tb = lpTrim(true); tb.colorSpace = THREE.NoColorSpace;
    trim.map = lpTrim(false); trim.bumpMap = tb; trim.bumpScale = 0.5;
  }
  const roofTex = style.roof_material === 'metal' ? metalRoofTex() : shingleTex();
  return {
    siding, trim,
    roofTex,
    roof: (u, v) => new THREE.MeshStandardMaterial({ color: c(colors.roof, '#3a3c3e'), map: tiled(roofTex, u, v), roughness: style.roof_material === 'metal' ? 0.4 : 0.95, metalness: style.roof_material === 'metal' ? 0.35 : 0 }),
    roofPlain: new THREE.MeshStandardMaterial({ color: c(colors.roof, '#3a3c3e').multiplyScalar(0.85), roughness: 0.8 }),
    roofTrim: new THREE.MeshStandardMaterial({ color: c(colors.roof, '#3a3c3e'), roughness: 0.42, metalness: 0.45 }),
    agPanel: new THREE.MeshStandardMaterial({ color: c(colors.roof, '#3a3c3e'), roughness: 0.38, metalness: 0.55, side: THREE.DoubleSide }),
    screw: new THREE.MeshStandardMaterial({ color: c(colors.roof, '#3a3c3e').multiplyScalar(0.8), roughness: 0.35, metalness: 0.6 }),
    door: new THREE.MeshStandardMaterial({ color: c(colors.door, colors.trim || '#f4f4ef'), roughness: 0.6 }),
    window: new THREE.MeshStandardMaterial({ color: c(colors.window, colors.trim || '#f4f4ef'), roughness: 0.55 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x9db6c4, roughness: 0.08, metalness: 0.35, transparent: true, opacity: 0.55 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x2b2d2f, roughness: 0.35, metalness: 0.8 }),
    steel: new THREE.MeshStandardMaterial({ color: 0xbfc4c7, roughness: 0.3, metalness: 0.85 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x1b1d1e, roughness: 0.9 }),
    wood: new THREE.MeshStandardMaterial({ color: 0xffffff, map: plyTex(), roughness: 0.8 }),
    osb: new THREE.MeshStandardMaterial({ color: 0xffffff, map: osbTex(), roughness: 0.9, side: THREE.BackSide }),
    floor: new THREE.MeshStandardMaterial({ color: 0xffffff, map: tiled(plyTex(), 8, 8), roughness: 0.85 }),
    light: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff6dc, emissiveIntensity: 1.2 }),
    white: new THREE.MeshStandardMaterial({ color: 0xf6f6f2, roughness: 0.5 }),
    soil: new THREE.MeshStandardMaterial({ color: 0x3b2a1e, roughness: 1 }),
    leaf: new THREE.MeshStandardMaterial({ color: 0x3f7a35, roughness: 0.9 }),
    bloomA: new THREE.MeshStandardMaterial({ color: 0xd94a5a, roughness: 0.7 }),
    bloomB: new THREE.MeshStandardMaterial({ color: 0xf2c33d, roughness: 0.7 }),
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function box(w, h, d, mat, x = 0, y = 0, z = 0, parent) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(Math.max(w, 0.001), Math.max(h, 0.001), Math.max(d, 0.001)), mat);
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
  if (parent) parent.add(m);
  return m;
}
function rbox(w, h, d, r, mat, x, y, z, parent) {
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2)), mat);
  m.position.set(x, y, z); m.castShadow = m.receiveShadow = true; parent.add(m); return m;
}

// ---------------------------------------------------------------------------
// Built-in option models. Local frame: x = along wall, y = up (0 = bottom of item),
// z = outward. For "opening" kinds, z = 0 is the CENTRE of the wall (exterior face at +T/2).
// ---------------------------------------------------------------------------
function casing(g, w, h, M, zOut, withSill) {
  if (M.noCasing) return; // exported .glb files: the builder adds its own trim around the opening
  const cw = M.cw ?? 0.33, ct = 0.06;
  // windows/vents: flat picture-frame casing all the way around (no projecting sill); doors: sides + head only
  const lo = withSill ? -cw : 0, sh = h + cw - lo;
  box(cw, sh, ct, M.trim, -w / 2 - cw / 2, lo + sh / 2, zOut + ct / 2, g);
  box(cw, sh, ct, M.trim, w / 2 + cw / 2, lo + sh / 2, zOut + ct / 2, g);
  // windows: head and bottom are flush with the sides (a clean flat frame); doors keep the small head-trim ears
  box(w + cw * 2 + (withSill ? 0 : 0.1), cw, ct + (withSill ? 0 : 0.02), M.trim, 0, h + cw / 2, zOut + ct / 2, g);
  if (withSill) box(w + cw * 2, cw, ct, M.trim, 0, -cw / 2, zOut + ct / 2, g);
}
// Carriage-house door leaf (matches the 72" double / 36" single carriage doors): 5-lite window across the top,
// framed upper & lower panels of vertical boards, black strap hinges on the hinge side.
// Body = door color, window grid = trim color, hardware black.
function carriageLeaf(g, w, h, M, x, zf, hingeSide, { window: hasWin = true } = {}) {
  const T0 = 0.1, F = 0.05;                     // slab and frame-board thickness
  const groove = M.doorGroove || (M.doorGroove = M.door.clone());
  groove.color = M.door.color.clone().multiplyScalar(0.72);
  box(w, h, T0, M.door, x, h / 2, zf, g);
  const zb = zf + T0 / 2 + F / 2, s = Math.min(0.36, w * 0.12);   // stile width ~4.3"
  // top rail is wide enough (4") to carry the top hinge above the window
  const topR = 0.34, winH = hasWin ? Math.min(0.95, h * 0.16) : 0, underWin = hasWin ? 0.3 : 0, midR = 0.36, botR = 0.42;
  const yWinTop = h - topR, yWinBot = yWinTop - winH, yMid = h * 0.44;
  // stiles & rails (raised boards)
  box(s, h, F, M.door, x - w / 2 + s / 2, h / 2, zb, g);
  box(s, h, F, M.door, x + w / 2 - s / 2, h / 2, zb, g);
  const iw = w - 2 * s;
  box(iw, topR, F, M.door, x, h - topR / 2, zb, g);
  if (hasWin) box(iw, underWin, F, M.door, x, yWinBot - underWin / 2, zb, g);
  box(iw, midR, F, M.door, x, yMid, zb, g);
  box(iw, botR, F, M.door, x, botR / 2, zb, g);
  // vertical board grooves in the two panels
  const panels = [[botR, yMid - midR / 2], [yMid + midR / 2, yWinBot - underWin]];
  const boards = Math.max(3, Math.round(iw / 0.33));
  for (const [y0, y1] of panels) for (let k = 1; k < boards; k++) box(0.018, y1 - y0, 0.004, groove, x - iw / 2 + iw * k / boards, (y0 + y1) / 2, zf + T0 / 2 + 0.002, g);
  // shadow line where the raised frame meets each panel, so the frame reads like the real door
  const zl = zf + T0 / 2 + 0.003;
  for (const [y0, y1] of panels) {
    box(iw, 0.03, 0.006, groove, x, y0 + 0.015, zl, g); box(iw, 0.03, 0.006, groove, x, y1 - 0.015, zl, g);
    box(0.03, y1 - y0, 0.006, groove, x - iw / 2 + 0.015, (y0 + y1) / 2, zl, g); box(0.03, y1 - y0, 0.006, groove, x + iw / 2 - 0.015, (y0 + y1) / 2, zl, g);
  }
  // 5-lite window: dark glass, trim-colored frame and muntins
  if (hasWin) {
  const wy = (yWinTop + yWinBot) / 2, gz = zf + T0 / 2;
  box(iw, winH, 0.02, M.glassDark || (M.glassDark = new THREE.MeshStandardMaterial({ color: 0x1b2226, roughness: 0.12, metalness: 0.4 })), x, wy, gz, g);
  const fb = 0.06, mz = gz + 0.02;
  box(iw, fb, 0.04, M.trim, x, yWinTop - fb / 2, mz, g); box(iw, fb, 0.04, M.trim, x, yWinBot + fb / 2, mz, g);
  box(fb, winH, 0.04, M.trim, x - iw / 2 + fb / 2, wy, mz, g); box(fb, winH, 0.04, M.trim, x + iw / 2 - fb / 2, wy, mz, g);
  for (let k = 1; k < 5; k++) box(0.045, winH, 0.035, M.trim, x - iw / 2 + iw * k / 5, wy, mz, g);
  }
  // T-hinges on the hinge edge (top, middle, bottom): an upright plate at the edge and a short strap that
  // tapers to a point across the door
  const ex = x + hingeSide * (w / 2), hz = zb + F / 2 + 0.006, dir = -hingeSide;   // strap runs toward the door's centre
  const strapLen = Math.min(0.72, w * 0.3), plateW = 0.11, plateH = 0.4;
  const strap = new THREE.Shape([new THREE.Vector2(0, -0.07), new THREE.Vector2(strapLen * 0.35, -0.045), new THREE.Vector2(strapLen, -0.012),
    new THREE.Vector2(strapLen, 0.012), new THREE.Vector2(strapLen * 0.35, 0.045), new THREE.Vector2(0, 0.07)]);
  const strapGeo = new THREE.ExtrudeGeometry(strap, { depth: 0.02, bevelEnabled: false });
  // top hinge sits on the top rail (above the window), middle on the mid rail, bottom on the bottom rail
  for (const [y, ph] of [[h - topR / 2, Math.min(plateH, topR - 0.04)], [yMid, plateH], [botR / 2 + 0.03, Math.min(plateH, botR - 0.04)]]) {
    box(plateW, ph, 0.022, M.metal, ex + dir * plateW / 2, y, hz + 0.011, g);   // upright plate at the edge
    const st = new THREE.Mesh(strapGeo, M.metal); st.castShadow = true;
    st.position.set(ex + dir * (plateW - 0.01), y, hz); st.scale.x = dir; g.add(st);
    for (const d of [0.2, 0.42]) { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.012, 8), M.steel); b.rotation.x = Math.PI / 2; b.position.set(ex + dir * (plateW + d), y, hz + 0.024); g.add(b); }
    for (const dy of [-ph * 0.33, ph * 0.33]) { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.012, 8), M.steel); b.rotation.x = Math.PI / 2; b.position.set(ex + dir * plateW / 2, y + dy, hz + 0.026); g.add(b); }
  }
}
function panelDoorLeaf(g, w, h, M, x, z) {
  box(w, h, 0.12, M.door, x, h / 2, z, g);
  const pw = w - 0.5;
  box(pw, h * 0.38, 0.04, M.door, x, h * 0.72, z + 0.07, g);
  box(pw, h * 0.38, 0.04, M.door, x, h * 0.27, z + 0.07, g);
}
function glassLeaf(g, w, h, M, x, z, lites = [3, 3], glassFrac = 1) {
  const st = 0.28;
  const gh = (h - st * 2) * glassFrac;
  // stiles & rails
  box(st, h, 0.14, M.door, x - w / 2 + st / 2, h / 2, z, g);
  box(st, h, 0.14, M.door, x + w / 2 - st / 2, h / 2, z, g);
  box(w, st, 0.14, M.door, x, h - st / 2, z, g);
  const glassBottom = h - st - gh;
  box(w, glassBottom > st ? glassBottom : st, 0.14, M.door, x, (glassBottom > st ? glassBottom : st) / 2, z, g);
  if (glassBottom > st + 0.4) { box(w - 0.7, glassBottom - 0.8, 0.04, M.door, x, glassBottom / 2, z + 0.08, g); }
  box(w - st * 2, gh, 0.03, M.glass, x, glassBottom + gh / 2, z, g);
  const [cols, rows] = lites;
  for (let i = 1; i < cols; i++) box(0.05, gh, 0.16, M.door, x - w / 2 + st + (w - 2 * st) * i / cols, glassBottom + gh / 2, z, g);
  for (let i = 1; i < rows; i++) box(w - st * 2, 0.05, 0.16, M.door, x, glassBottom + gh * i / rows, z, g);
}
function handle(g, x, y, z, M) {
  const k = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), M.steel); k.position.set(x, y, z); g.add(k);
  box(0.1, 0.3, 0.04, M.steel, x, y, z - 0.05, g);
}
function windowUnit(g, w, h, M, opts = {}) {
  // Exterior casing, sill and interior casing use the TRIM color (matches the rest of the trim);
  // the window itself (sash frame + grids) uses the WINDOW color.
  const MW = M.window || M.trim;
  const zOut = T / 2;
  casing(g, w, h, M, zOut, true);
  box(w, h, 0.03, M.glass, 0, h / 2, 0.0, g);
  const fw = Math.min(0.14, w * 0.08), fd = 0.14; // sash frame width/depth
  box(w, fw, fd, MW, 0, h - fw / 2, 0.0, g);
  box(w, fw, fd, MW, 0, fw / 2, 0.0, g);
  box(fw, h, fd, MW, -w / 2 + fw / 2, h / 2, 0.0, g);
  box(fw, h, fd, MW, w / 2 - fw / 2, h / 2, 0.0, g);
  const iw = w - 2 * fw, ih = h - 2 * fw;
  const grid = (cols, rows, y0, hh) => {   // muntins inside one glass area
    for (let i = 1; i < cols; i++) box(0.05, hh, 0.08, MW, -iw / 2 + iw * i / cols, y0 + hh / 2, 0.02, g);
    for (let i = 1; i < rows; i++) box(iw, 0.05, 0.08, MW, 0, y0 + hh * i / rows, 0.02, g);
  };
  if (opts.top || opts.bottom) {
    // two sashes (single-hung look): a meeting rail across the middle, each half with its own grid
    const rail = Math.max(0.09, fw), half = (ih - rail) / 2;
    box(w, rail, 0.12, MW, 0, fw + half + rail / 2, 0.01, g);
    const [tc, tr] = opts.top || [1, 1], [bc, br] = opts.bottom || [1, 1];
    grid(bc, br, fw, half); grid(tc, tr, fw + half + rail, half);
  } else grid(opts.cols ?? 2, opts.rows ?? 2, fw, ih);
  // interior casing (trim color)
  box(w + 0.3, 0.15, 0.04, M.trim, 0, h + 0.075, -T / 2 - 0.02, g);
  box(w + 0.3, 0.15, 0.04, M.trim, 0, -0.075, -T / 2 - 0.02, g);
  for (const sx of [-1, 1]) box(0.15, h, 0.04, M.trim, sx * (w / 2 + 0.075), h / 2, -T / 2 - 0.02, g);
}

export const BUILTIN_KINDS = {
  breaker: 'Breaker box (sub-panel)', switch: 'Light switch', door_single: 'Single door', door_carriage: 'Carriage-house door (single, hinged left)', door_carriage_right: 'Carriage-house door (single, right half of the 72", hinged right)', door_panel: 'Standard door (single, right half of the 6\' double, hinged right)', door_panel_double: 'Panel double doors (no windows)', door_carriage_double: 'Carriage-house double doors', door_glass: 'Glass/lite door', door_double: 'Double barn doors', door_french: 'French doors',
  door_rollup: 'Roll-up door', window: 'Window', window_shutters: 'Window with shutters', window_transom: 'Transom window',
  vent: 'Gable vent', flowerbox: 'Flower box', ext_light: 'Exterior light', shelf: 'Shelf', shelf_double: 'Double shelves (two levels)', workbench: 'Workbench',
  loft: 'Loft', light: 'Ceiling light', outlet: 'Outlet', ramp: 'Ramp', cupola: 'Cupola', box: 'Generic box', none: 'No model (line item only)',
};

/** "3x2" → [3 cols, 2 rows]; "none" / blank → no muntins ([1,1]); undefined when not set. */
export function parseGrid(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const m = String(v).match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  return m ? [Math.max(1, Math.min(8, +m[1])), Math.max(1, Math.min(8, +m[2]))] : [1, 1];
}
const sashGrids = o => { const t = parseGrid(o?.grid_top), b = parseGrid(o?.grid_bottom); return t || b ? { top: t || [1, 1], bottom: b || [1, 1] } : {}; };
function buildKind(kind, w, h, d, M, ctx = {}) {
  const g = new THREE.Group();
  const zOut = T / 2;
  switch (kind) {
    case 'door_single': {
      casing(g, w, h, M, zOut);
      panelDoorLeaf(g, w - 0.06, h - 0.04, M, 0, zOut - 0.12);
      handle(g, w / 2 - 0.35, 3.1, zOut - 0.02, M);
      break;
    }
    case 'door_glass': {
      casing(g, w, h, M, zOut);
      glassLeaf(g, w - 0.06, h - 0.04, M, 0, zOut - 0.12, [3, 3], 0.55);
      handle(g, w / 2 - 0.35, 3.1, zOut - 0.02, M);
      break;
    }
    case 'door_french': {
      casing(g, w, h, M, zOut);
      glassLeaf(g, w / 2 - 0.04, h - 0.04, M, -w / 4, zOut - 0.12, [2, 5], 0.82);
      glassLeaf(g, w / 2 - 0.04, h - 0.04, M, w / 4, zOut - 0.12, [2, 5], 0.82);
      handle(g, -0.18, 3.1, zOut - 0.02, M); handle(g, 0.18, 3.1, zOut - 0.02, M);
      break;
    }
    case 'door_carriage': { // 36" single carriage-house door: hinges on the left, knob on the right
      casing(g, w, h, M, zOut);
      carriageLeaf(g, w - 0.04, h - 0.02, M, 0, zOut - 0.06, -1);
      const k = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12), M.metal); k.position.set(w / 2 - 0.42, h * 0.47, zOut + 0.08); g.add(k);
      box(0.12, 0.22, 0.03, M.metal, w / 2 - 0.42, h * 0.47, zOut + 0.02, g);
      break;
    }
    case 'door_carriage_double': { // 72" carriage-house double doors: hinges on the outer edges, knob + top latch at the centre
      casing(g, w, h, M, zOut);
      const lw = w / 2 - 0.025;
      carriageLeaf(g, lw, h - 0.02, M, -w / 4, zOut - 0.06, -1);
      carriageLeaf(g, lw, h - 0.02, M, w / 4, zOut - 0.06, 1);
      box(0.07, h - 0.06, 0.03, M.door, -0.035, h / 2, zOut + 0.02, g);          // astragal on the left (inactive) door over the meeting edge
      // knob on the RIGHT door, on its stile next to the meeting edge
      const kx = 0.2;
      const k = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12), M.metal); k.position.set(kx, h * 0.47, zOut + 0.1); g.add(k);
      box(0.12, 0.22, 0.03, M.metal, kx, h * 0.47, zOut + 0.04, g);
      break;
    }
    case 'door_panel_double': { // 6' double doors: carriage-house look without the windows; knob on the right door
      casing(g, w, h, M, zOut);
      const lw = w / 2 - 0.025;
      carriageLeaf(g, lw, h - 0.02, M, -w / 4, zOut - 0.06, -1, { window: false });
      carriageLeaf(g, lw, h - 0.02, M, w / 4, zOut - 0.06, 1, { window: false });
      box(0.07, h - 0.06, 0.03, M.door, -0.035, h / 2, zOut + 0.02, g);
      const k = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12), M.metal); k.position.set(0.2, h * 0.47, zOut + 0.1); g.add(k);
      box(0.12, 0.22, 0.03, M.metal, 0.2, h * 0.47, zOut + 0.04, g);
      break;
    }
    case 'door_panel':            // 36" standard door = the RIGHT half of the 6' double doors
    case 'door_carriage_right': { // 36" carriage-house door = the RIGHT half of the 72" carriage doors
      // hinges on the right edge, knob on the left stile exactly where it sits on the double door's right leaf
      casing(g, w, h, M, zOut);
      carriageLeaf(g, w - 0.04, h - 0.02, M, 0, zOut - 0.06, 1, { window: kind === 'door_carriage_right' });
      const kx = -w / 2 + 0.2;
      const k = new THREE.Mesh(new THREE.SphereGeometry(0.08, 16, 12), M.metal); k.position.set(kx, h * 0.47, zOut + 0.1); g.add(k);
      box(0.12, 0.22, 0.03, M.metal, kx, h * 0.47, zOut + 0.04, g);
      break;
    }
    case 'door_double': {
      // Barn-style doors: slab + trim frame + X brace on each leaf
      const lw = w / 2 - 0.03, zf = zOut - 0.06;
      for (const sx of [-1, 1]) {
        const x = sx * (w / 4);
        box(lw, h - 0.04, 0.1, M.door, x, h / 2, zf, g);
        const b = 0.32, z2 = zf + 0.07;
        box(lw, b, 0.05, M.trim, x, h - b / 2 - 0.02, z2, g);
        box(lw, b, 0.05, M.trim, x, b / 2, z2, g);
        box(lw, b * 0.8, 0.05, M.trim, x, h / 2, z2, g);
        box(b, h - 0.04, 0.05, M.trim, x - lw / 2 + b / 2, h / 2, z2, g);
        box(b, h - 0.04, 0.05, M.trim, x + lw / 2 - b / 2, h / 2, z2, g);
        for (const [y0, y1] of [[b, h / 2 - b * 0.4], [h / 2 + b * 0.4, h - b]]) {
          const iw = lw - 2 * b, ih = y1 - y0;
          const len = Math.hypot(iw, ih), ang = Math.atan2(ih, iw);
          const m1 = box(len, b * 0.75, 0.04, M.trim, x, (y0 + y1) / 2, z2, g); m1.rotation.z = ang;
          const m2 = box(len, b * 0.75, 0.04, M.trim, x, (y0 + y1) / 2, z2 + 0.005, g); m2.rotation.z = -ang;
        }
      }
      // hinges + handle
      for (const sx of [-1, 1]) for (const y of [h * 0.2, h * 0.8]) box(0.5, 0.08, 0.03, M.metal, sx * (w / 2 - 0.3), y, zOut + 0.04, g);
      box(0.06, 0.7, 0.05, M.metal, -0.12, h / 2, zOut + 0.06, g); box(0.06, 0.7, 0.05, M.metal, 0.12, h / 2, zOut + 0.06, g);
      casing(g, w, h, M, zOut);
      break;
    }
    case 'door_rollup': {
      casing(g, w, h, M, zOut);
      const n = Math.round(h / 0.33);
      for (let i = 0; i < n; i++) {
        const y = (i + 0.5) * (h / n);
        box(w - 0.04, h / n - 0.03, 0.06, M.door, 0, y, zOut - 0.1, g);
        box(w - 0.04, 0.03, 0.03, M.dark, 0, i * (h / n), zOut - 0.12, g);
      }
      box(0.6, 0.12, 0.08, M.metal, 0, 0.5, zOut - 0.04, g);
      break;
    }
    case 'window': windowUnit(g, w, h, M, { cols: w >= 3 ? 3 : 2, rows: 2, ...sashGrids(ctx.opt) }); break;
    case 'window_transom': windowUnit(g, w, h, M, { cols: Math.max(2, Math.round(w / 1.2)), rows: 1 }); break;
    case 'window_shutters': {
      windowUnit(g, w, h, M, { cols: 2, rows: 2, ...sashGrids(ctx.opt) });
      for (const sx of [-1, 1]) {
        const sw = w * 0.5, x = sx * (w / 2 + (M.cw ?? 0.33) + sw / 2 + 0.02);
        box(sw, h + 0.2, 0.08, M.door, x, h / 2, zOut + 0.05, g);
        for (let i = 1; i < 9; i++) { const l = box(sw - 0.16, 0.05, 0.04, M.dark, x, (h + 0.2) * i / 9 - 0.1, zOut + 0.1, g); l.material = M.door; l.rotation.x = -0.4; }
        box(sw - 0.1, 0.03, 0.05, M.dark, x, h / 2, zOut + 0.1, g);
      }
      break;
    }
    case 'vent': {
      box(w, h, T + 0.02, M.dark, 0, h / 2, 0, g);
      for (let i = 0; i < 5; i++) { const s = box(w - 0.1, 0.05, 0.22, M.trim, 0, h * (i + 0.5) / 5, zOut - 0.05, g); s.rotation.x = 0.6; }
      casing(g, w, h, M, zOut);
      break;
    }
    case 'flowerbox': {
      box(w, h, d, M.door, 0, h / 2, d / 2, g);
      box(w - 0.1, 0.05, d - 0.1, M.soil, 0, h + 0.005, d / 2, g);
      for (let i = 0; i < Math.round(w * 4); i++) {
        const x = -w / 2 + 0.15 + Math.random() * (w - 0.3), z = 0.12 + Math.random() * (d - 0.24);
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.1 + Math.random() * 0.06, 8, 6), i % 3 === 0 ? M.leaf : (i % 2 ? M.bloomA : M.bloomB));
        s.position.set(x, h + 0.08 + Math.random() * 0.18, z); s.castShadow = true; g.add(s);
      }
      break;
    }
    case 'ext_light': {
      box(0.35, 0.5, 0.06, M.metal, 0, 0.25, 0.03, g);
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.75, 8), M.metal);
      arm.rotation.x = Math.PI / 2; arm.position.set(0, 0.35, 0.4); g.add(arm);
      const shade = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.32, 24, 1, true), M.metal); shade.position.set(0, 0.2, 0.75); g.add(shade);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 8), M.light); bulb.position.set(0, 0.1, 0.75); g.add(bulb);
      break;
    }
    case 'shelf': {
      box(w, 0.08, d, M.wood, 0, 0, d / 2, g);
      for (const x of [-w / 2 + 0.4, 0, w / 2 - 0.4]) { if (w < 3 && x === 0) continue; box(0.08, 0.8, 0.08, M.metal, x, -0.4, 0.06, g); const br = box(0.06, 0.06, d * 0.95, M.metal, x, -0.04, d / 2, g); }
      break;
    }
    case 'shelf_double': { // two shelves, one above the other (h = spacing), on wood standards with metal brackets
      const n = Math.max(2, Math.round(w / 2) + 1);
      for (let i = 0; i < n; i++) {
        const x = -w / 2 + 0.25 + (w - 0.5) * i / (n - 1);
        box(0.12, h + 0.9, 0.06, M.wood, x, (h + 0.9) / 2 - 0.85, 0.04, g);                       // upright
        for (const y of [0, h]) { box(0.06, 0.06, d * 0.92, M.metal, x, y - 0.06, d / 2, g); const br = box(0.05, 0.42, 0.05, M.metal, x, y - 0.27, d * 0.38, g); br.rotation.x = -0.75; }
      }
      for (const y of [0, h]) { box(w, 0.08, d, M.wood, 0, y, d / 2, g); box(w, 0.12, 0.05, M.wood, 0, y - 0.02, d - 0.025, g); }
      break;
    }
    case 'workbench': {
      box(w, 0.15, d, M.wood, 0, h - 0.075, d / 2, g);
      box(w - 0.3, 0.08, d - 0.2, M.wood, 0, 0.6, d / 2, g);
      for (const x of [-w / 2 + 0.15, w / 2 - 0.15]) for (const z of [0.15, d - 0.15]) box(0.25, h - 0.15, 0.25, M.wood, x, (h - 0.15) / 2, z, g);
      box(w, 0.35, 0.06, M.wood, 0, h + 0.175, 0.03, g); // low backsplash so it clears windows above
      break;
    }
    case 'light': {
      box(w, 0.12, 0.45, M.white, 0, 0, 0, g);
      box(w - 0.1, 0.03, 0.3, M.light, 0, -0.07, 0, g);
      box(0.03, 0.6, 0.03, M.metal, -w / 3, 0.35, 0, g); box(0.03, 0.6, 0.03, M.metal, w / 3, 0.35, 0, g);
      break;
    }
    case 'breaker': { // load centre: grey steel box with a door, handle and label
      box(w, h, Math.min(d, 0.33), M.steel, 0, h / 2, Math.min(d, 0.33) / 2, g);
      box(w - 0.12, h - 0.12, 0.02, M.white, 0, h / 2, Math.min(d, 0.33) + 0.01, g);
      box(0.06, 0.22, 0.04, M.dark, w / 2 - 0.16, h / 2, Math.min(d, 0.33) + 0.03, g);
      box(w * 0.5, 0.12, 0.01, M.dark, 0, h - 0.22, Math.min(d, 0.33) + 0.02, g);
      // conduit up to the ceiling
      box(0.07, 1.4, 0.07, M.steel, -w / 4, h + 0.7, 0.05, g);
      break;
    }
    case 'switch': {
      box(0.23, 0.38, 0.03, M.white, 0, 0.19, 0.015, g);
      box(0.06, 0.12, 0.04, M.white, 0, 0.19, 0.04, g);
      break;
    }
    case 'outlet': {
      box(0.25, 0.4, 0.03, M.white, 0, 0.2, 0.015, g);
      for (const y of [0.12, 0.28]) { box(0.03, 0.07, 0.01, M.dark, -0.04, y, 0.035, g); box(0.03, 0.07, 0.01, M.dark, 0.04, y, 0.035, g); }
      break;
    }
    case 'ramp': {
      const rise = ctx.floorY ?? FLOOR_Y, len = Math.hypot(d, rise), ang = Math.atan2(rise, d);
      const n = Math.ceil(len / 0.5);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const p = box(w, 0.1, len / n - 0.04, M.wood, 0, rise * (1 - t) - 0.05, d * t, g); p.rotation.x = ang;
      }
      for (const sx of [-1, 1]) { const s = box(0.15, 0.4, len, M.wood, sx * (w / 2 - 0.1), rise / 2 - 0.25, d / 2, g); s.rotation.x = ang; }
      break;
    }
    case 'cupola': {
      const bw = w, bh = h * 0.5;
      box(bw, bh * 0.45, bw, M.trim, 0, bh * 0.225, 0, g);
      box(bw * 0.86, bh * 0.55, bw * 0.86, M.dark, 0, bh * 0.45 + bh * 0.275, 0, g);
      for (const r of [0, 1, 2, 3]) {
        const side = new THREE.Group(); side.rotation.y = r * Math.PI / 2; g.add(side);
        for (let i = 0; i < 4; i++) { const s = box(bw * 0.8, 0.05, 0.12, M.trim, 0, bh * 0.5 + i * bh * 0.13, bw * 0.43, side); s.rotation.x = 0.6; }
      }
      box(bw * 1.05, 0.12, bw * 1.05, M.trim, 0, bh + 0.06, 0, g);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(bw * 0.78, h * 0.42, 4), M.roofPlain);
      cap.rotation.y = Math.PI / 4; cap.position.y = bh + 0.12 + h * 0.21; cap.castShadow = true; g.add(cap);
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.9, 6), M.metal); rod.position.y = bh + h * 0.42 + 0.5; g.add(rod);
      const vane = box(0.7, 0.18, 0.02, M.metal, 0.15, bh + h * 0.42 + 0.75, 0, g);
      break;
    }
    case 'none': break;
    default: box(w, h, Math.max(d, 0.1), M.trim, 0, h / 2, d / 2, g);
  }
  return g;
}

// ---------------------------------------------------------------------------
// Custom GLB models
// ---------------------------------------------------------------------------
const gltfCache = {};
const loader = new GLTFLoader();
function loadGLB(url) {
  if (!gltfCache[url]) gltfCache[url] = new Promise((res, rej) => loader.load(url, g => res(g.scene), undefined, rej));
  return gltfCache[url];
}
function fitModel(src, w, h, d, opening) {
  const obj = src.clone(true);
  const bb = new THREE.Box3().setFromObject(obj), sz = bb.getSize(new THREE.Vector3());
  const sx = w / (sz.x || 1), sy = h / (sz.y || 1), sz2 = (opening ? Math.max(d, T + 0.1) : (d || sz.z)) / (sz.z || 1);
  obj.scale.set(sx, sy, d ? sz2 : Math.min(sx, sy));
  const bb2 = new THREE.Box3().setFromObject(obj), c = bb2.getCenter(new THREE.Vector3());
  obj.position.sub(new THREE.Vector3(c.x, bb2.min.y, opening ? c.z : bb2.min.z));
  obj.traverse(m => { if (m.isMesh) { m.castShadow = m.receiveShadow = true; } });
  const g = new THREE.Group(); g.add(obj); return g;
}

// ---------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------
export class ShedScene {
  constructor(container, { onSelect, onDrag, onDragEnd, background = true, compact = false } = {}) {
    this.container = container;
    this.onSelect = onSelect || (() => {});
    this.onDrag = onDrag || null; this.onDragEnd = onDragEnd || (() => {});
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: !background });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(this.renderer.domElement);
    // Soft studio reflections for painted steel (applied to metal materials only)
    try { const pm = new THREE.PMREMGenerator(this.renderer); this.envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose(); } catch { this.envTex = null; }

    this.scene = new THREE.Scene();
    if (background) {
      const c = document.createElement('canvas'); c.width = 2; c.height = 256;
      const g = c.getContext('2d'); const grd = g.createLinearGradient(0, 0, 0, 256);
      grd.addColorStop(0, '#9fc3e0'); grd.addColorStop(0.55, '#dfeaf2'); grd.addColorStop(1, '#eef2f0');
      g.fillStyle = grd; g.fillRect(0, 0, 2, 256);
      const bg = new THREE.CanvasTexture(c); bg.colorSpace = THREE.SRGBColorSpace; this.scene.background = bg;
      this.scene.fog = new THREE.Fog(0xe6eef1, 70, 160);
    }
    this.camera = new THREE.PerspectiveCamera(compact ? 35 : 38, 1, 0.1, 500);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.04; this.controls.minDistance = 6; this.controls.maxDistance = 90;
    this.controls.enablePan = false;

    this.scene.add(new THREE.HemisphereLight(0xe8f1fb, 0x6f7d5c, 1.25));
    const sun = new THREE.DirectionalLight(0xfff4e2, 2.4);
    sun.position.set(18, 30, 22); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
    Object.assign(sun.shadow.camera, { left: -28, right: 28, top: 28, bottom: -28, near: 1, far: 90 });
    this.scene.add(sun); this.sun = sun;
    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.6); fill.position.set(-20, 12, -14); this.scene.add(fill);
    this.interiorLight = new THREE.PointLight(0xfff3dd, 0, 30, 1.5); this.scene.add(this.interiorLight);

    if (background) {
      const ground = new THREE.Mesh(new THREE.CircleGeometry(120, 64), new THREE.MeshStandardMaterial({ map: tiled(grassTex(), 240, 240), roughness: 1 }));
      ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; this.scene.add(ground); this.ground = ground;
    }
    this.root = new THREE.Group(); this.scene.add(this.root);
    this.items = new Map(); this.selected = null; this.interior = false;
    this.selBox = new THREE.Box3Helper(new THREE.Box3(), 0x16a34a); this.selBox.visible = false; this.scene.add(this.selBox);
    this.selFill = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.22, depthWrite: false }));
    this.selFill.visible = false; this.selFill.renderOrder = 10; this.scene.add(this.selFill);

    this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
    let down = null;
    const el = this.renderer.domElement;
    this.drag = null;
    // Capture phase on the container runs before OrbitControls' own listener on the canvas,
    // so grabbing an item disables orbiting for that gesture.
    container.addEventListener('pointerdown', e => {
      if (e.target !== el) return;
      down = [e.clientX, e.clientY];
      const uid = this.onDrag ? this.pick(e) : null;
      if (uid) {
        this.controls.enabled = false;
        this.drag = { uid, moved: false, pointerId: e.pointerId };
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        el.style.cursor = 'grabbing';
      }
    }, true);
    el.addEventListener('pointermove', e => {
      if (this.drag) {
        if (!this.drag.moved && down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 5) return;
        if (!this.drag.moved) { this.drag.moved = true; this.select(this.drag.uid); this.onSelect(this.drag.uid, { dragging: true }); }
        const hit = this.dragTarget(e, this.drag.uid);
        if (hit) this.onDrag(this.drag.uid, hit);
        return;
      }
      if (e.buttons) return;
      el.style.cursor = this.pick(e) ? (this.onDrag ? 'grab' : 'pointer') : 'default';
    });
    const end = e => {
      const d = this.drag; this.drag = null; this.controls.enabled = true;
      if (d) { try { el.releasePointerCapture(d.pointerId); } catch { /* ignore */ } el.style.cursor = 'grab'; }
      if (d && d.moved) { this.onDragEnd(d.uid); return; }
      if (e.type === 'pointercancel' || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return;
      const uid = this.pick(e); this.select(uid); this.onSelect(uid);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    this.resize = this.resize.bind(this);
    new ResizeObserver(this.resize).observe(container);
    this.resize();
    const loop = () => { this.controls.update(); this.renderer.render(this.scene, this.camera); this.raf = requestAnimationFrame(loop); };
    loop();
  }

  resize() {
    const w = this.container.clientWidth || 300, h = this.container.clientHeight || 300;
    this.renderer.setSize(w, h, false); this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = '100%';
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.camera.updateMatrixWorld(); this.root.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.root.children, true);
    for (const h of hits) {
      if (!h.object.visible) continue;
      let o = h.object;
      while (o) { if (o.userData.uid) return o.userData.uid; if (o.userData.solid) return null; o = o.parent; }
    }
    return null;
  }

  /** Where the pointer would put an item: {wall, offset} (walls), {wall:'ceiling'|'roof', offset}. */
  dragTarget(e, uid) {
    const obj = this.items.get(uid); if (!obj || !this.geo) return null;
    const kind = obj.userData.placement;
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.camera.updateMatrixWorld(); this.root.updateMatrixWorld(true);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const g = this.geo, y0 = FLOOR_Y;
    const planeHit = y => { const p = new THREE.Vector3(); return this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), p) ? p : null; };
    if (kind === 'ceiling' || kind === 'roof') {
      const p = planeHit(kind === 'ceiling' ? y0 + g.H - 0.45 : y0 + g.H + g.peak); if (!p) return null;
      return { wall: kind, offset: g.ridgeAlongZ ? p.z : p.x };
    }
    if (kind !== 'ground') {
      const hits = this.raycaster.intersectObjects(this.wallMeshes || [], false);
      if (hits.length) {
        const w = hits[0].object.userData.wall;
        const local = this.wallGroups[w].worldToLocal(hits[0].point.clone());
        return { wall: w, offset: local.x };
      }
    }
    // Ground (ramps) or pointer off the walls: nearest wall to the point on the ground
    const p = planeHit(0); if (!p) return null;
    const cand = ['front', 'back', 'left', 'right'].map(w => {
      const l = this.wallGroups[w].worldToLocal(p.clone());
      return { wall: w, offset: l.x, dist: Math.abs(l.z) + Math.max(0, Math.abs(l.x) - g.wallLen(w) / 2) };
    }).sort((a, b) => a.dist - b.dist)[0];
    return { wall: cand.wall, offset: cand.offset };
  }

  select(uid) {
    this.selected = uid;
    const obj = uid && this.items.get(uid);
    if (obj) {
      this.root.updateMatrixWorld(true);
      const b = this.selBox.box.setFromObject(obj).expandByScalar(0.1);
      this.selBox.visible = this.selFill.visible = true;
      b.getCenter(this.selFill.position); b.getSize(this.selFill.scale);
    } else this.selBox.visible = this.selFill.visible = false;
  }

  setInterior(on) {
    this.interior = on;
    if (this.roofGroup) this.roofGroup.visible = !on;
    if (this.cupolas) this.cupolas.forEach(c => (c.visible = !on));
    this.interiorLight.intensity = on ? 18 : 0;
    if (this.selected) this.select(this.selected);
  }

  frame(view = 'front34', animate = true) {
    const g = this.geo; if (!g) return;
    const top = FLOOR_Y + g.H + g.peak;
    const target = new THREE.Vector3(0, this.interior ? FLOOR_Y + 1.5 : top * 0.45, 0);
    const R = Math.max(g.W, g.D, top) * 1.8 + 11;
    const dirs = {
      front34: [0.75, 0.45, 1], front: [0, 0.3, 1], back: [0, 0.3, -1], left: [-1, 0.3, 0], right: [1, 0.3, 0],
      top: [0.001, 1, 0.25], back34: [-0.75, 0.45, -1], inside: [0.3, 1.25, 0.95],
      in_front: [0.15, 1.5, -0.8], in_back: [-0.15, 1.5, 0.8], in_left: [0.8, 1.5, 0.15], in_right: [-0.8, 1.5, -0.15],
    };
    const d = new THREE.Vector3(...(dirs[view] || dirs.front34)).normalize().multiplyScalar(view === 'inside' || view.startsWith('in_') ? R * 0.72 : R);
    const to = target.clone().add(d);
    if (!animate) { this.camera.position.copy(to); this.controls.target.copy(target); this.controls.update(); return; }
    const from = this.camera.position.clone(), ft = this.controls.target.clone(); const t0 = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / 650), e = 1 - Math.pow(1 - t, 3);
      this.camera.position.lerpVectors(from, to, e); this.controls.target.lerpVectors(ft, target, e);
      if (t < 1) requestAnimationFrame(step);
    };
    step();
  }

  /** Rebuild the whole shed. */
  build(catalog, config) {
    const style = catalog.styles.find(s => s.id === config.style_id);
    const size = style?.sizes.find(s => s.id === config.size_id);
    if (!style || !size) return;
    const colorById = Object.fromEntries(catalog.colors.map(c => [c.id, /match\s*trim/i.test(c.name) ? null : c.hex]));
    const colors = {}; for (const k of ['siding', 'trim', 'roof', 'door', 'window']) colors[k] = colorById[config.colors?.[k]];
    if (!colors.door) colors.door = colors.trim;
    if (!colors.window) colors.window = colors.trim;
    const optById = Object.fromEntries(catalog.options.map(o => [o.id, o]));
    const firstBuild = !this.geo;
    const prevDims = this.geo && [this.geo.W, this.geo.D, this.geo.H, this.geo.peak].join();

    // dispose old
    const cached = new Set(Object.values(texCache));
    this.root.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      for (const m of [].concat(o.material || [])) { if (m.map && !cached.has(m.map)) m.map.dispose(); m.dispose(); }
    });
    this.root.clear(); this.items.clear(); this.cupolas = []; this.wallMeshes = [];

    const geo = this.geo = shedGeometry(style, size);
    const M = this.M = makeMaterials({ ...style, roof_material: config.roof_material || style.roof_material }, colors);
    if ((config.roof_material || style.roof_material) === 'metal') {
      // painted steel: ridge cap & trims match the panels, all with soft reflections
      M.roofPlain.roughness = 0.42; M.roofPlain.metalness = 0.45; M.roofPlain.color.copy(M.agPanel.color);
      // light colors (Galvalume, Polar White) read as bare/bright steel: more metal, slightly darker base so they don't wash out
      const hsl = {}; M.agPanel.color.getHSL(hsl);
      const bare = hsl.l > 0.55 && hsl.s < 0.12;
      for (const m of [M.agPanel, M.screw, M.roofTrim, M.roofPlain]) {
        m.envMap = this.envTex; m.envMapIntensity = bare ? 0.7 : 0.5;
        if (bare) { m.metalness = 0.8; m.roughness = 0.32; m.color.multiplyScalar(0.78); }
      }
    }
    if (M.steel) M.steel.envMap = this.envTex;
    M.cw = (style.casing_trim === null || style.casing_trim === undefined || style.casing_trim === '' ? 4 : Number(style.casing_trim)) / 12;
    const { W, D, H } = geo;
    const y0 = FLOOR_Y;
    const shed = new THREE.Group(); this.root.add(shed);

    // --- Gravel pad, skids, floor
    if (this.ground) {
      const pad = new THREE.Mesh(new THREE.PlaneGeometry(W + 4, D + 4), new THREE.MeshStandardMaterial({ map: tiled(gravelTex(), W + 4, D + 4), roughness: 1 }));
      pad.rotation.x = -Math.PI / 2; pad.position.y = 0.02; pad.receiveShadow = true; pad.userData.solid = true; shed.add(pad);
    }
    const skids = Math.max(2, Math.round(W / 4) + 1);
    for (let i = 0; i < skids; i++) box(0.33, 0.35, D, M.wood, -W / 2 + 0.3 + (W - 0.6) * i / (skids - 1), 0.2, 0, shed).userData.solid = true;
    box(W, 0.4, D, M.trim, 0, y0 - 0.2, 0, shed).userData.solid = true;
    const fl = new THREE.Mesh(new THREE.PlaneGeometry(W - 2 * T, D - 2 * T), new THREE.MeshStandardMaterial({ map: tiled(plyTex(), W, D), roughness: 0.85 }));
    fl.rotation.x = -Math.PI / 2; fl.position.y = y0 + 0.005; fl.receiveShadow = true; fl.userData.solid = true; shed.add(fl);

    // --- Walls (with openings cut out)
    const wallXf = {
      front: [0, D / 2, 0], back: [0, -D / 2, Math.PI], right: [W / 2, 0, Math.PI / 2], left: [-W / 2, 0, -Math.PI / 2],
    };
    this.wallGroups = {};
    const placed = (config.items || []).map(it => ({ it, o: optById[it.option_id] })).filter(r => r.o);
    for (const wall of ['front', 'back', 'left', 'right']) {
      const [x, z, ry] = wallXf[wall];
      const wg = new THREE.Group(); wg.position.set(x, y0, z); wg.rotation.y = ry; shed.add(wg); this.wallGroups[wall] = wg;
      const L = geo.wallLen(wall);
      // Outline starts slightly below the floor line so door holes (which start at 0) never touch it.
      const shape = new THREE.Shape();
      shape.moveTo(-L / 2, -0.05); shape.lineTo(L / 2, -0.05);
      if (geo.isGable(wall)) {
        const pts = geo.profileUs(wall).sort((a, b) => b[0] - a[0]); // right → left
        for (const [u, h] of pts) shape.lineTo(Math.max(-L / 2, Math.min(L / 2, u)), h);
      } else {
        shape.lineTo(L / 2, geo.topAt(wall, L / 2)); shape.lineTo(-L / 2, geo.topAt(wall, -L / 2));
      }
      shape.lineTo(-L / 2, -0.05);
      for (const { it, o } of placed) {
        if (it.wall !== wall || o.placement !== 'opening') continue;
        const p = resolvePlacement(geo, o, it);
        const hole = new THREE.Path();
        hole.moveTo(p.offset - p.w / 2, p.elev); hole.lineTo(p.offset - p.w / 2, p.elev + p.h);
        hole.lineTo(p.offset + p.w / 2, p.elev + p.h); hole.lineTo(p.offset + p.w / 2, p.elev);
        hole.lineTo(p.offset - p.w / 2, p.elev);
        shape.holes.push(hole);
      }
      const eg = new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false, curveSegments: 1 });
      const wm = new THREE.Mesh(eg, [M.siding, M.trim]); wm.position.z = -T; wm.castShadow = wm.receiveShadow = true; wm.userData.solid = true; wg.add(wm);
      // Invisible full-wall proxy (no holes) used only for drag targeting
      const proxy = new THREE.Mesh(new THREE.PlaneGeometry(L, g_top(geo, wall)), new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
      proxy.position.set(0, g_top(geo, wall) / 2, -T / 2); proxy.userData.wall = wall; wg.add(proxy); this.wallMeshes.push(proxy);
      const inner = new THREE.Mesh(new THREE.ShapeGeometry(shape), M.osb); inner.position.z = -T - 0.004; inner.receiveShadow = true; inner.userData.solid = true; wg.add(inner);
      inner.material = M.osb.clone(); inner.material.map = tiled(osbTex(), 1, 1); inner.material.map.repeat.set(0.25, 0.25);
    }

    // --- Trim sizes (inches, set per style in the admin)
    const inch = (v, d) => (v === null || v === undefined || v === '' ? d : Number(v)) / 12;
    const fasciaH = inch(style.fascia_size, 5.5), cornerW = inch(style.corner_trim, 5);
    const metalRoofSel = (config.roof_material || style.roof_material) === 'metal';
    // Shingle roofs: rake board (trim color). Metal roofs: metal rake trim (roof color) with its own sizes.
    // Roof edge style:
    //  metal_rake  – wide metal rake trim in the roof color (metal roofs) / rake board (shingles), fascia below
    //  board_drip  – rake board + fascia in the trim color, capped by a thin metal rake edge and a drip edge
    const boardDrip = style.roof_edge === 'board_drip';
    const rakeH = boardDrip ? inch(style.rake_size, 5.5) : metalRoofSel ? inch(style.metal_rake_size, 5.5) : inch(style.rake_size, 5.5);
    const rakeLeg = inch(style.metal_rake_leg, boardDrip ? 2 : 3.5);
    const capH = inch(style.rake_cap_size, 1.5), dripH = inch(style.drip_edge_size, 1.5);

    // --- Corner boards
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const h = geo.H + geo.prof(geo.ridgeAlongZ ? sx * geo.s : sz * geo.s);
      box(cornerW, h, cornerW, M.trim, sx * (W / 2 + 0.06 - cornerW / 2), y0 + h / 2, sz * (D / 2 + 0.06 - cornerW / 2), shed).userData.solid = true;
    }

    // --- Roof
    const roofG = new THREE.Group(); roofG.position.y = y0 + H; shed.add(roofG); this.roofGroup = roofG;
    if (!geo.ridgeAlongZ) roofG.rotation.y = -Math.PI / 2;
    const ov = geo.eaveOv, th = 0.22;
    const ridgeLen = geo.L + 2 * geo.gableOv, RL = ridgeLen / 2;
    const metalRoof = M.roofTex.userData.tileFt === 3;
    const rt = 0.07;                                   // rake / fascia board thickness
    const capW = metalRoof ? 0.6 : 0.45, ct = metalRoof ? 0.05 : 0.09;
    // Bottom (underside) profile, with the eave overhang added to the first/last segment
    const prof = geo.profile.map(p => p.slice());
    const nSeg = prof.length - 1;
    const dirOf = (a, b) => { const du = b[0] - a[0], dh = b[1] - a[1], l = Math.hypot(du, dh); return [du / l, dh / l]; };
    { const [ux, uy] = dirOf(prof[0], prof[1]), k = ov / Math.max(ux, 0.3); prof[0] = [prof[0][0] - ux * k, prof[0][1] - uy * k]; }
    { const [ux, uy] = dirOf(prof[nSeg - 1], prof[nSeg]), k = ov / Math.max(ux, 0.3); prof[nSeg] = [prof[nSeg][0] + ux * k, prof[nSeg][1] + uy * k]; }
    const normal = i => { const [ux, uy] = dirOf(prof[i], prof[i + 1]); return [-uy, ux]; };
    // The profile offset outward by d, mitred where two slopes meet
    const offLine = d => prof.map((p, i) => {
      if (i === 0 || i === nSeg) { const n = normal(i === 0 ? 0 : nSeg - 1); return [p[0] + n[0] * d, p[1] + n[1] * d]; }
      const n1 = normal(i - 1), n2 = normal(i), bis = [n1[0] + n2[0], n1[1] + n2[1]];
      const cos = (n1[0] * bis[0] + n1[1] * bis[1]) / Math.hypot(...bis);
      const k = d / cos / Math.hypot(...bis);
      return [p[0] + bis[0] * k, p[1] + bis[1] * k];
    });
    const top = offLine(th);
    let peakIdx = 0; prof.forEach((p, i) => { if (p[1] > prof[peakIdx][1]) peakIdx = i; });
    const V2 = p => new THREE.Vector2(p[0], p[1]);
    const strip = (outer, inner) => new THREE.Shape([...outer.map(V2), ...inner.slice().reverse().map(V2)]);

    // Gambrel transitions: the upper roof laps OVER the transition trim (like real installs)
    const lapAt = {}; // segment index → which end (0|1) is lapped
    for (let i = 1; i < nSeg; i++) if (i !== peakIdx) { const upper = i < peakIdx ? i : i - 1; lapAt[upper] = i < peakIdx ? 0 : 1; }

    // ---- Ag Panel: real corrugated steel. 36" sheets, 3/4" trapezoid major ribs every 9" with two
    // small stiffening ribs between them; ribs run down the slope; screws in rows every 2 ft.
    const RIB_H = 0.0625;
    const agProfile = (() => {
      const pts = [], hw = RL, sp = 0.75, bh = 0.11, th2 = 0.04, mh = 0.012, mw = 0.035;
      pts.push([-hw, 0]);
      for (let c = -hw + sp / 2; c < hw - 0.01; c += sp) {
        // two stiffening ribs in the flat before this major rib
        for (const f of [-sp * 2 / 3 + 0.04, -sp / 3 + 0.02]) { const m = c + f; if (m - mw > -hw && m + mw < hw) pts.push([m - mw, 0], [m, mh], [m + mw, 0]); }
        if (c - bh > -hw && c + bh < hw) pts.push([c - bh, 0], [c - th2, RIB_H], [c + th2, RIB_H], [c + bh, 0]);
      }
      pts.push([hw, 0], [hw, -0.008], [-hw, -0.008]);
      return pts;
    })();
    const agShape = new THREE.Shape(agProfile.map(([x, y]) => new THREE.Vector2(x, y)));
    const screwGeo = new THREE.CylinderGeometry(0.028, 0.028, 0.03, 8);
    const agPanel = (A, Bp, segIdx) => {
      const len = Math.hypot(Bp[0] - A[0], Bp[1] - A[1]); if (len < 0.05) return;
      const u = [(Bp[0] - A[0]) / len, (Bp[1] - A[1]) / len], n = normal(segIdx);
      const geo = new THREE.ExtrudeGeometry(agShape, { depth: len, bevelEnabled: false, curveSegments: 1 });
      const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, -1), new THREE.Vector3(n[0], n[1], 0), new THREE.Vector3(u[0], u[1], 0));
      m.setPosition(A[0], A[1], 0); geo.applyMatrix4(m); geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, M.agPanel); mesh.castShadow = mesh.receiveShadow = true; mesh.userData.solid = true; roofG.add(mesh);
      // screws: beside each major rib, rows every 2 ft down the slope
      const rows = []; for (let d = 0.6; d < len - 0.3; d += 2) rows.push(d); rows.push(len - 0.25);
      const ribs = []; for (let c = -RL + 0.375; c < RL - 0.01; c += 0.75) ribs.push(c + 0.2);
      const inst = new THREE.InstancedMesh(screwGeo, M.screw, rows.length * ribs.length);
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(n[0], n[1], 0));
      const mm = new THREE.Matrix4(); let k = 0;
      for (const d of rows) for (const z of ribs) {
        mm.compose(new THREE.Vector3(A[0] + u[0] * d + n[0] * 0.012, A[1] + u[1] * d + n[1] * 0.012, -z), q, new THREE.Vector3(1, 1, 1));
        inst.setMatrixAt(k++, mm);
      }
      inst.userData.solid = true; roofG.add(inst);
    };
    for (let i = 0; i < nSeg; i++) {
      const B0 = prof[i], B1 = prof[i + 1];
      let T0 = top[i], T1 = top[i + 1];
      if (boardDrip) { // roofing runs ~1" past the drip edge
        const [ux, uy] = dirOf(T0, T1), kx = Math.max(Math.abs(ux), 0.3);
        if (i === 0) { const e = (T0[0] - (Math.min(top[0][0], prof[0][0]) - rt - 0.03 - 0.08)) / kx; T0 = [T0[0] - ux * e, T0[1] - uy * e]; }
        if (i === nSeg - 1) { const e = ((Math.max(top[nSeg][0], prof[nSeg][0]) + rt + 0.03 + 0.08) - T1[0]) / kx; T1 = [T1[0] + ux * e, T1[1] + uy * e]; }
      }
      // solid slab (trim colour on edges/underside) – top sunk a hair below the textured skin
      const n = normal(i), e = 0.006;
      const shape = new THREE.Shape([V2(B0), V2(B1), V2([T1[0] - n[0] * e, T1[1] - n[1] * e]), V2([T0[0] - n[0] * e, T0[1] - n[1] * e])]);
      const slab = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: ridgeLen, bevelEnabled: false }), M.trim);
      slab.position.z = -RL; slab.castShadow = slab.receiveShadow = true; slab.userData.solid = true; roofG.add(slab);
      if (lapAt[i] !== undefined) {
        // metal: the upper panels lift over the transition trim and run a couple of inches past the bend.
        // shingles: lie flat and bend over the break — the two surfaces just overlap a sliver so no seam shows.
        const lift = metalRoof ? RIB_H + ct + 0.012 : 0.003, lap = metalRoof ? 0.18 : 0.03;
        const [ux, uy] = dirOf(T0, T1);
        if (lapAt[i] === 0) T0 = [T0[0] - ux * lap + n[0] * lift, T0[1] - uy * lap + n[1] * lift];
        else T1 = [T1[0] + ux * lap + n[0] * lift, T1[1] + uy * lap + n[1] * lift];
      }
      // textured roof skin (u runs down/up the slope, v along the ridge)
      const len = Math.hypot(T1[0] - T0[0], T1[1] - T0[1]);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([T0[0], T0[1], -RL, T1[0], T1[1], -RL, T1[0], T1[1], RL, T0[0], T0[1], RL], 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
      g.setIndex([0, 2, 1, 0, 3, 2]); g.computeVertexNormals();
      if (metalRoof) { agPanel(T0, T1, i); continue; }
      const rm = M.roof(len, ridgeLen); rm.side = THREE.DoubleSide;
      const skin = new THREE.Mesh(g, rm); skin.castShadow = skin.receiveShadow = true; skin.userData.solid = true; roofG.add(skin);
    }
    const leafOn = (P, towards, segIdx, len) => {
      const d = [towards[0] - P[0], towards[1] - P[1]], l = Math.hypot(...d), ux = d[0] / l, uy = d[1] / l, n = normal(segIdx);
      const leaf = box(len, ct, ridgeLen - 0.01, M.roofPlain, P[0] + ux * len / 2 + n[0] * ct / 2, P[1] + uy * len / 2 + n[1] * ct / 2, 0, roofG);
      leaf.rotation.z = Math.atan2(uy, ux); leaf.userData.solid = true;
    };
    // Shingle ridge cap: individual cap shingles (5" exposure) bent over the ridge — no metal trim at all
    const capShingles = (P, towards, segIdx, len) => {
      const d = [towards[0] - P[0], towards[1] - P[1]], l = Math.hypot(...d), ux = d[0] / l, uy = d[1] / l, n = normal(segIdx);
      const dark = M.roofPlain.clone(); dark.color = dark.color.clone().multiplyScalar(0.82);
      const exp = 5 / 12, cnt = Math.ceil(ridgeLen / exp);
      for (let k = 0; k < cnt; k++) {
        // each cap shingle stays within the roof length (none sticks out past the rake)
        const z0 = -RL + exp * k, z1 = Math.min(RL - 0.005, z0 + exp + 0.03), lenZ = z1 - z0; if (lenZ <= 0.01) continue;
        const b = box(len, ct, lenZ, k % 2 ? M.roofPlain : dark, P[0] + ux * len / 2 + n[0] * ct / 2, P[1] + uy * len / 2 + n[1] * ct / 2, (z0 + z1) / 2, roofG);
        b.rotation.z = Math.atan2(uy, ux); b.userData.solid = true;
      }
    };
    for (let i = 1; i < nSeg; i++) {
      const P = top[i];
      if (!metalRoof) {
        if (i === peakIdx) {
          capShingles(P, top[i - 1], i - 1, capW); capShingles(P, top[i + 1], i, capW);
          const n1 = normal(i - 1), n2 = normal(i);
          const wedge = new THREE.Shape([V2(P), V2([P[0] + n2[0] * ct, P[1] + n2[1] * ct]), V2([P[0] + n1[0] * ct, P[1] + n1[1] * ct])]);
          const wm2 = new THREE.Mesh(new THREE.ExtrudeGeometry(wedge, { depth: ridgeLen - 0.01, bevelEnabled: false }), M.roofPlain);
          wm2.position.z = -RL + 0.005; wm2.userData.solid = true; roofG.add(wm2);
        }
        continue; // gambrel break on shingles: courses lap over the bend, no trim
      }
      if (i === peakIdx) {
        // Metal ridge cap: installed LAST — it sits on top of the rake trim and runs out over its ends.
        // Lifted above the rake trim's top, with hems down to the panels (like the cap's closure).
        const lift = ct + 0.045, ext = rt + 0.06;
        const Q = offLine(th + lift)[i], T0 = offLine(th + lift + ct)[i];
        const dir = j => { const t = top[j], l = Math.hypot(t[0] - P[0], t[1] - P[1]); return [(t[0] - P[0]) / l, (t[1] - P[1]) / l]; };
        const u1 = dir(i - 1), u2 = dir(i + 1), n1 = normal(i - 1), n2 = normal(i);
        const D1 = [P[0] + u1[0] * capW, P[1] + u1[1] * capW], D2 = [P[0] + u2[0] * capW, P[1] + u2[1] * capW];
        const T1 = [Q[0] + u1[0] * capW + n1[0] * ct, Q[1] + u1[1] * capW + n1[1] * ct], T2 = [Q[0] + u2[0] * capW + n2[0] * ct, Q[1] + u2[1] * capW + n2[1] * ct];
        const capShape = new THREE.Shape([V2(P), V2(D1), V2(T1), V2(T0), V2(T2), V2(D2)]);
        const cap = new THREE.Mesh(new THREE.ExtrudeGeometry(capShape, { depth: ridgeLen + 2 * ext, bevelEnabled: false }), M.roofPlain);
        cap.position.z = -RL - ext; cap.castShadow = true; cap.userData.solid = true; roofG.add(cap);
      } else {
        // Transition trim: lies on the LOWER slope; the upper roofing laps over it
        const lower = i < peakIdx ? i - 1 : i, nl = normal(lower);
        leafOn([P[0] + nl[0] * RIB_H, P[1] + nl[1] * RIB_H], i < peakIdx ? top[i - 1] : top[i + 1], lower, capW);
      }
    }

    // Eave corners: the outer face of the fascia on each side. Rake trim is cut PLUMB (vertical) at
    // this plane so rake and fascia meet in a clean corner at any pitch.
    const XL = Math.min(top[0][0], prof[0][0]) - rt, XR = Math.max(top[nSeg][0], prof[nSeg][0]) + rt;
    const atX = (p, q, x) => { const t = (x - p[0]) / ((q[0] - p[0]) || 1e-6); return [x, p[1] + (q[1] - p[1]) * t]; };
    const plumb = line => { const l = line.map(p => p.slice()); l[0] = atX(l[0], l[1], XL); l[nSeg] = atX(l[nSeg - 1], l[nSeg], XR); return l; };
    // Rake/fly-rafter tails: after the plumb cut, cut LEVEL (flat) at the bottom of the fascia so no point
    // hangs below it — matters most on the steep lower slope of a gambrel.
    const cutStrip = (outer, inner, yL, yR) => {
      const n = inner.map(p => p.slice());
      const cut = (end, prev, y) => {
        const b = n[end], a = n[prev];
        if (y == null || b[1] >= y - 1e-4 || a[1] <= y) return null;
        const t = (y - b[1]) / (a[1] - b[1]);
        return { corner: [b[0], y], hit: [b[0] + (a[0] - b[0]) * t, y] };
      };
      const R = cut(nSeg, nSeg - 1, yR), Lc = cut(0, 1, yL);
      const back = n.slice().reverse().map(V2);
      if (R) back.splice(0, 1, V2(R.corner), V2(R.hit));
      if (Lc) back.splice(back.length - 1, 1, V2(Lc.hit), V2(Lc.corner));
      return new THREE.Shape([...outer.map(V2), ...back]);
    };

    const edgeMat = style.drip_edge_color === 'trim' ? M.trim : M.roofTrim;
    if (boardDrip) {
      const dT = 0.03; // metal thickness
      const XL2 = XL - dT, XR2 = XR + dT;
      const plumb2 = line => { const l = line.map(p => p.slice()); l[0] = atX(l[0], l[1], XL2); l[nSeg] = atX(l[nSeg - 1], l[nSeg], XR2); return l; };
      // Rake board (trim color, LP texture): top flush with the roof deck
      const boardTop = plumb(offLine(th - 0.004)), boardBot = plumb(offLine(th - rakeH));
      const capTop = plumb2(offLine(th + ct + 0.03)), capBot = plumb2(offLine(th - capH));
      const deck0 = plumb(offLine(th));
      const lvl = rakeTailLevel(style), fbL = lvl ? deck0[0][1] - 0.004 - fasciaH : null, fbR = lvl ? deck0[nSeg][1] - 0.004 - fasciaH : null; // fascia bottoms (flat cut)
      for (const zs of [1, -1]) {
        const board = new THREE.Mesh(new THREE.ExtrudeGeometry(cutStrip(boardTop, boardBot, fbL, fbR), { depth: rt, bevelEnabled: false }), M.trim);
        board.position.z = zs > 0 ? RL : -RL - rt; board.castShadow = true; board.userData.solid = true; roofG.add(board);
        if (!metalRoof) continue; // shingle roofs get no metal rake edge
        // thin metal rake edge over the top of the board, with a leg onto the roofing
        const cap = new THREE.Mesh(new THREE.ExtrudeGeometry(strip(capTop, capBot), { depth: dT, bevelEnabled: false }), edgeMat);
        cap.position.z = zs > 0 ? RL + rt : -RL - rt - dT; cap.castShadow = true; cap.userData.solid = true; roofG.add(cap);
        const legW = Math.max(0.04, rakeLeg);
        const leg = new THREE.Mesh(new THREE.ExtrudeGeometry(strip(capTop, plumb2(offLine(th + 0.004))), { depth: legW, bevelEnabled: false }), edgeMat);
        leg.position.z = zs > 0 ? RL + rt + dT - legW : -RL - rt - dT; leg.castShadow = true; leg.userData.solid = true; roofG.add(leg);
      }
      // Fascia (trim color) + drip edge (metal) along the eaves
      const deck = plumb(offLine(th));
      for (const end of [0, nSeg]) {
        const left = end === 0, X = left ? XL : XR, yt = deck[end][1] - 0.004;
        const f = box(rt, fasciaH, ridgeLen + 2 * rt, M.trim, X + (left ? rt / 2 : -rt / 2), yt - fasciaH / 2, 0, roofG); f.userData.solid = true;
        if (!metalRoof) continue; // no metal drip edge on shingle roofs
        const d = box(dT, dripH, ridgeLen + 2 * rt + 2 * dT, edgeMat, X + (left ? -dT / 2 : dT / 2), yt + 0.03 - dripH / 2, 0, roofG); d.userData.solid = true;
        // small kick at the bottom of the drip edge
        const kick = box(dT * 2.5, dT, ridgeLen + 2 * rt + 2 * dT, edgeMat, X + (left ? -dT * 1.25 : dT * 1.25), yt + 0.03 - dripH + dT / 2, 0, roofG); kick.userData.solid = true;
      }
    } else {
      // Rake trim along both gable ends (L-shaped metal trim on metal roofs, rake board on shingles)
      const rakeTop = plumb(offLine(th + (metalRoof ? ct + 0.04 : ct + 0.02))), rakeBot = plumb(offLine(th - rakeH));
      const lvl = rakeTailLevel(style), fbL = lvl ? rakeTop[0][1] - fasciaH : null, fbR = lvl ? rakeTop[nSeg][1] - fasciaH : null; // fascia bottoms (flat cut)
      for (const zs of [1, -1]) {
        const rakeMat = metalRoof ? M.roofTrim : M.trim;
        const face = new THREE.Mesh(new THREE.ExtrudeGeometry(cutStrip(rakeTop, rakeBot, fbL, fbR), { depth: rt, bevelEnabled: false }), rakeMat);
        face.position.z = zs > 0 ? RL : -RL - rt; face.castShadow = true; face.userData.solid = true; roofG.add(face);
        if (metalRoof) {
          const legW = Math.max(0.05, rakeLeg); // leg that laps onto the roof panels
          const leg = new THREE.Mesh(new THREE.ExtrudeGeometry(strip(rakeTop, plumb(offLine(th + 0.004))), { depth: legW, bevelEnabled: false }), rakeMat);
          leg.position.z = zs > 0 ? RL - legW : -RL; leg.castShadow = true; leg.userData.solid = true; roofG.add(leg);
        }
      }
      // Fascia boards along the eaves: top meets the plumb-cut rake exactly
      for (const end of [0, nSeg]) {
        const left = end === 0, X = left ? XL : XR;
        const yt = rakeTop[end][1];
        // metal: rake trim (roof color) wraps over the fascia ends; shingles: fascia runs through the rake board
        const f = box(rt, fasciaH, metalRoof ? ridgeLen : ridgeLen + 2 * rt, M.trim, X + (left ? rt / 2 : -rt / 2), yt - fasciaH / 2, 0, roofG);
        f.userData.solid = true;
      }
    }

    // --- Items
    for (const { it, o } of placed) {
      const holder = new THREE.Group(); holder.userData.uid = it.uid; holder.userData.placement = o.placement;
      const p = resolvePlacement(geo, o, it);
      const wg = this.wallGroups[it.wall];
      let parent = null, kindW = p.w, kindH = p.h, kindD = Number(o.depth) || 0.3;
      switch (o.placement) {
        case 'opening': if (!wg) continue; holder.position.set(p.offset, p.elev, -T / 2); parent = wg; break;
        case 'wall_exterior': if (!wg) continue; holder.position.set(p.offset, p.elev, 0); parent = wg; break;
        case 'wall_interior': case 'floor': if (!wg) continue; holder.position.set(p.offset, p.elev, -T - 0.01); holder.rotation.y = Math.PI; parent = wg; break;
        case 'ground': if (!wg) continue; holder.position.set(p.offset, -y0, 0.02); parent = wg; break;
        case 'loft': {
          if (!wg) continue;
          const L = geo.wallLen(it.wall) - 2 * T - 0.05, dd = Number(o.depth) || 4;
          holder.position.set(0, H - 0.25, -T - dd / 2); parent = wg;
          box(L, 0.22, dd, M.wood, 0, 0, 0, holder);
          box(L, 0.4, 0.15, M.wood, 0, -0.25, dd / 2 - 0.08, holder);
          wg.add(holder); this.items.set(it.uid, holder); tagDeep(holder, it.uid);
          continue;
        }
        case 'ceiling': {
          holder.position.set(0, y0 + H - 0.45, Math.max(-D / 2 + 1, Math.min(D / 2 - 1, it.offset || 0)));
          if (!geo.ridgeAlongZ) holder.position.set(Math.max(-W / 2 + 1, Math.min(W / 2 - 1, it.offset || 0)), y0 + H - 0.45, 0);
          parent = shed; break;
        }
        case 'roof': {
          const peakU = geo.profile.reduce((a, b) => (b[1] > a[1] ? b : a));
          const off = Math.max(-geo.L / 2 + 1.5, Math.min(geo.L / 2 - 1.5, it.offset || 0));
          const y = y0 + H + peakU[1] - (geo.prof(peakU[0] + 0.5) < peakU[1] ? 0.25 : 0);
          holder.position.copy(geo.ridgeAlongZ ? new THREE.Vector3(peakU[0], y, off) : new THREE.Vector3(off, y, -peakU[0]));
          parent = shed; this.cupolas.push(holder); break;
        }
        default: continue;
      }
      const opening = o.placement === 'opening';
      const model = buildKind(o.kind || 'box', kindW, kindH, kindD, M, { floorY: y0, opt: o });
      holder.add(model);
      if (o.model_url) {
        loadGLB(o.model_url).then(src => {
          holder.remove(model);
          const fitted = fitModel(src, kindW, kindH, opening ? T + 0.15 : kindD, opening);
          if (opening) casing(fitted, kindW, kindH, M, T / 2, (o.kind || '').startsWith('window'));
          holder.add(fitted); tagDeep(holder, it.uid);
          if (this.selected === it.uid) this.select(it.uid);
        }).catch(e => console.warn('Model failed to load', o.model_url, e));
      }
      parent.add(holder); this.items.set(it.uid, holder); tagDeep(holder, it.uid);
    }

    this.interiorLight.position.set(0, y0 + H - 0.5, 0);
    this.setInterior(this.interior);
    const dims = [geo.W, geo.D, geo.H, geo.peak].join();
    if (firstBuild) this.frame('front34', false); else if (dims !== prevDims) this.frame(this.lastView || 'front34');
    if (this.selected && !this.items.has(this.selected)) this.selected = null;
    this.select(this.selected);
  }

  view(name) { this.lastView = name; this.frame(name); }

  /** Export the shed (without ground/sky) as a binary glTF Blob. */
  async exportGLB() {
    const wasInterior = this.interior; this.setInterior(false); this.selBox.visible = this.selFill.visible = false;
    const exporter = new GLTFExporter();
    const data = await exporter.parseAsync(this.root, { binary: true, onlyVisible: true, maxTextureSize: 1024 });
    this.setInterior(wasInterior); this.select(this.selected);
    return new Blob([data], { type: 'model/gltf-binary' });
  }

  snapshot(w = 640, h = 420) {
    const prev = [this.renderer.domElement.width, this.renderer.domElement.height];
    this.selBox.visible = this.selFill.visible = false;
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL('image/jpeg', 0.85);
    this.select(this.selected);
    return url;
  }

  /** Admin preview of a single option on a small wall section. */
  /** Export one option's built-in 3D model as a .glb (a starting file to edit in Blender/SketchUp). */
  async exportOptionGLB(opt, colors = {}) {
    const M = makeMaterials({ siding_type: 'lap', roof_material: 'shingle' }, { siding: '#c2b49a', trim: '#f4f4ef', roof: '#3a3c3e', door: '#f4f4ef', ...colors });
    M.cw = 4 / 12; M.noCasing = opt.placement === 'opening';
    const w = Math.max(Number(opt.width) || 1, 0.3), h = Math.max(Number(opt.height) || 1, 0.1), d = Number(opt.depth) || 0.3;
    const g = new THREE.Group(); g.name = opt.name || 'option';
    g.add(buildKind(opt.kind || 'box', w, h, d, M, { floorY: 0.75, opt }));
    g.scale.setScalar(0.3048); // feet → metres (glTF units)
    const data = await new Promise((res, rej) => new GLTFExporter().parse(g, res, rej, { binary: true }));
    return new Blob([data], { type: 'model/gltf-binary' });
  }
  previewOption(opt, colors = {}) {
    this.root.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    this.root.clear();
    const M = makeMaterials({ siding_type: 'lap', roof_material: 'shingle' }, { siding: '#c2b49a', trim: '#f4f4ef', roof: '#3a3c3e', door: '#f4f4ef', ...colors });
    const w = Math.max(Number(opt.width) || 1, 0.3), h = Math.max(Number(opt.height) || 1, 0.1), d = Number(opt.depth) || 0.3;
    const pl = opt.placement;
    const L = w + (opt.kind === 'window_shutters' ? w * 1.4 : 0) + 3, Hh = Math.max(h + (Number(opt.elevation) > 0 ? opt.elevation : 0) + 1.5, 4);
    const g = new THREE.Group(); this.root.add(g);
    if (['opening', 'wall_exterior', 'wall_interior', 'floor', 'ground'].includes(pl)) {
      const shape = new THREE.Shape(); shape.moveTo(-L / 2, -0.05); shape.lineTo(L / 2, -0.05); shape.lineTo(L / 2, Hh); shape.lineTo(-L / 2, Hh); shape.lineTo(-L / 2, -0.05);
      const elev = pl === 'ground' ? 0 : Math.max(0, Number(opt.elevation) || 0);
      if (pl === 'opening') { const hole = new THREE.Path(); hole.moveTo(-w / 2, elev); hole.lineTo(-w / 2, elev + h); hole.lineTo(w / 2, elev + h); hole.lineTo(w / 2, elev); hole.lineTo(-w / 2, elev); shape.holes.push(hole); }
      const wm = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: T, bevelEnabled: false }), [M.siding, M.trim]);
      const flip = pl === 'wall_interior' || pl === 'floor';
      wm.position.z = flip ? 0 : -T; if (flip) wm.material = [M.osb.clone(), M.trim];
      g.add(wm);
      if (flip) wm.material[0].side = THREE.FrontSide;
      const holder = new THREE.Group();
      holder.position.set(0, pl === 'ground' ? 0 : elev, pl === 'opening' ? -T / 2 : (flip ? T + 0.01 : 0));
      if (pl === 'ground') holder.position.y = 0;
      g.add(holder);
      const model = buildKind(opt.kind || 'box', w, h, d, M, { floorY: 0.75, opt });
      holder.add(model);
      if (opt.model_url) loadGLB(opt.model_url).then(src => { holder.remove(model); holder.add(fitModel(src, w, h, pl === 'opening' ? T + 0.15 : d, pl === 'opening')); }).catch(() => {});
      this.geo = { W: L, D: 4, H: Hh, peak: 0 };
    } else {
      const holder = new THREE.Group(); g.add(holder);
      const model = buildKind(opt.kind === 'loft' ? 'box' : (opt.kind || 'box'), w || 4, h, d || 2, M, { floorY: 0.75 });
      if (pl === 'ceiling') model.position.y = 2;
      holder.add(model);
      if (opt.model_url) loadGLB(opt.model_url).then(src => { holder.remove(model); holder.add(fitModel(src, w, h, d, false)); }).catch(() => {});
      this.geo = { W: Math.max(w, 3), D: Math.max(d, 3), H: Math.max(h, 2), peak: 0 };
    }
    this.frame('front34', false);
    this.controls.minDistance = 2;
  }

  dispose() { cancelAnimationFrame(this.raf); this.renderer.dispose(); this.container.innerHTML = ''; }
}

function g_top(geo, wall) { return geo.isGable(wall) ? geo.H + geo.peak : Math.max(geo.topAt(wall, -geo.wallLen(wall) / 2), geo.topAt(wall, geo.wallLen(wall) / 2)); }
function tagDeep(holder, uid) { holder.userData.uid = uid; }
