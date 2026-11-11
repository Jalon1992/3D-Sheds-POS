// First-run seed: sample styles, sizes, colors and options so the configurator works out of the box.
// Everything here is editable (or deletable) from the admin dashboard.
import { db, get, run, setSettings, getSettings } from './db.js';
import { DEFAULT_ROOFING } from '../public/js/shared/pricing.js';
import { hashPassword } from './auth.js';

export function seed() {
  // Admin user
  if (!get('SELECT id FROM users LIMIT 1')) {
    const email = process.env.ADMIN_EMAIL || 'admin@example.com';
    const pw = process.env.ADMIN_PASSWORD || 'changeme123';
    run('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)', email.toLowerCase(), 'Admin', hashPassword(pw));
    console.log(`\n  Admin login created → ${email} / ${process.env.ADMIN_PASSWORD ? '(from ADMIN_PASSWORD)' : pw}`);
    if (!process.env.ADMIN_PASSWORD) console.log('  ⚠  Change this password in Admin → Account right away.\n');
  }

  if (getSettings().company_name === undefined) {
    setSettings({
      company_name: 'Your Shed Co.', headline: 'Design your shed in 3D', logo_url: '', brand_color: '#2f6b4f',
      currency_symbol: '$', tax_rate: 0, tax_delivery: false, delivery_fee: 0, show_prices: true, customer_window_height: true, require_phone: true,
      phone: '', website: '', privacy_url: '',
      success_message: 'Thanks! Your quote is on its way. A member of our team will reach out shortly.',
      consent_text: 'I agree to receive calls and text messages about my quote. Msg & data rates may apply. Reply STOP to opt out.',
      ghl_enabled: false, ghl_token: '', ghl_location_id: '', ghl_pipeline_id: '', ghl_stage_id: '',
      ghl_tags: 'shed-quote, 3d-builder', ghl_source: '3D Shed Builder', ghl_inbound_webhook_url: '',
      ghl_add_note: true, ghl_send_updates: false, ghl_custom_fields: {}, public_url: '',
    });
  }
  if (getSettings().roofing === undefined) setSettings({ roofing: DEFAULT_ROOFING });
  if (getSettings().price_tiers === undefined) setSettings({
    pricing_mode: 'none', default_tier: 1,
    price_tiers: [
      { id: 1, name: 'Standard', adjust_pct: 0, overrides: {} },
      { id: 2, name: 'Tier 2', adjust_pct: 5, overrides: {} },
      { id: 3, name: 'Tier 3', adjust_pct: 10, overrides: {} },
      { id: 4, name: 'Tier 4', adjust_pct: 15, overrides: {} },
    ],
    dealers: [
      { id: 'lot1', name: 'Sample Lot – Main Street', address: '100 Main St', city: 'Example City', state: 'TN', zip: '38301', phone: '', email: '', tier: 1 },
      { id: 'lot2', name: 'Sample Lot – Highway 45', address: '2000 Hwy 45', city: 'Sample Town', state: 'TN', zip: '38330', phone: '', email: '', tier: 2 },
    ],
    zip_tiers: [],
  });
  if (getSettings().customer_window_height === undefined) setSettings({ customer_window_height: true });
  if (getSettings().quote_terms === undefined) setSettings({ customer_pdf: true, quote_terms: 'Prices valid for 30 days. Delivery subject to level site and clear access. Final price confirmed at order.' });
  if (getSettings().color_groups === undefined) setSettings({ color_groups: { siding: true, trim: true, roof: true, door: true, window: true } });
  if (getSettings().downgrade_credit === undefined) setSettings({ downgrade_credit: true, remove_credit: true });

  if (get('SELECT id FROM styles LIMIT 1')) { upgradeCatalog(); return; }

  const ins = (table, obj) => {
    const keys = Object.keys(obj);
    const vals = keys.map(k => (obj[k] !== null && typeof obj[k] === 'object') ? JSON.stringify(obj[k]) : obj[k]);
    return Number(run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...vals).lastInsertRowid);
  };

  // ---- Colors
  const C = {};
  const colors = [
    ['siding', 'Barn Red', '#8c2d22'], ['siding', 'Clay', '#c2b49a'], ['siding', 'Charcoal', '#3d4043'],
    ['siding', 'Arctic White', '#eeeee8'], ['siding', 'Sage', '#8a9a7b'], ['siding', 'Navy', '#2b3a55'],
    ['siding', 'Pewter', '#8d9290'], ['siding', 'Natural Cedar', '#b07a4f', 150],
    ['trim', 'White', '#f4f4ef'], ['trim', 'Black', '#1e1f20'], ['trim', 'Clay', '#c2b49a'], ['trim', 'Charcoal', '#3d4043'],
    ['roof', 'Charcoal', '#3a3c3e', 0, 'shingle'], ['roof', 'Weathered Wood', '#6b5f53', 0, 'shingle'], ['roof', 'Onyx Black', '#202122', 0, 'shingle'],
    ['roof', 'Driftwood', '#7d7466', 0, 'shingle'], ['roof', 'Hunter Green', '#33463a', 0, 'shingle'],
    ['roof', 'Galvalume', '#b9bec0', 0, 'metal'], ['roof', 'Black', '#1f2022', 0, 'metal'], ['roof', 'Charcoal Gray', '#45484b', 0, 'metal'],
    ['roof', 'Burnished Slate', '#4a3f35', 0, 'metal'], ['roof', 'Barn Red', '#7a2620', 0, 'metal'], ['roof', 'Forest Green', '#2f4a36', 0, 'metal'],
    ['roof', 'Ocean Blue', '#2c4a63', 0, 'metal'], ['roof', 'Polar White', '#eceeea', 0, 'metal'],
    ['window', 'White', '#f6f6f2'], ['window', 'Match Trim', '#f4f4ef'], ['window', 'Black', '#1e1f20'],
    ['window', 'Bronze', '#4a3b2c'], ['window', 'Almond', '#d9cdb4'],
    ['door', 'Match Trim', '#f4f4ef'], ['door', 'Black', '#1e1f20'], ['door', 'Barn Red', '#8c2d22'], ['door', 'Natural Wood', '#9a6a40', 95],
  ];
  colors.forEach(([category, name, hex, price, material], i) => { C[name + ':' + category] = ins('colors', { category, name, hex, price: price || 0, material: material || null, sort: i }); });

  // ---- Options
  const O = {};
  const opt = (key, o) => { O[key] = ins('options', o); };
  let s = 0;
  opt('door36', { name: '36" Standard Door', category: 'doors', kind: 'door_panel', placement: 'opening', swap_group: 'door', width: 3, height: 6.33, price: 275, sort: s++, description: 'Matches one side of the 6\' Double Doors. Hinged on the right.' });
  opt('door9lite', { name: '9-Lite Glass Door', category: 'doors', kind: 'door_glass', placement: 'opening', swap_group: 'door', width: 3, height: 6.67, price: 595, sort: s++, description: 'Residential steel door with 9-lite glass.' });
  opt('dbl4', { name: "4' Double Doors", category: 'doors', kind: 'door_double', placement: 'opening', swap_group: 'door', width: 4, height: 6.33, price: 425, sort: s++ });
  opt('dbl6', { name: "6' Double Doors", category: 'doors', kind: 'door_panel_double', placement: 'opening', swap_group: 'door', width: 6, height: 6.33, price: 625, sort: s++ });
  opt('french', { name: 'French Doors (5\')', category: 'doors', kind: 'door_french', placement: 'opening', swap_group: 'door', width: 5, height: 6.67, price: 1150, sort: s++ });
  opt('roll6', { name: "6' x 6' Roll-Up Door", category: 'doors', kind: 'door_rollup', placement: 'opening', swap_group: 'door', width: 6, height: 6, price: 895, sort: s++ });
  opt('roll8', { name: "8' x 7' Roll-Up Door", category: 'doors', kind: 'door_rollup', placement: 'opening', swap_group: 'door', width: 8, height: 7, price: 1295, sort: s++ });
  s = 0;
  opt('win23', { name: '2\' x 3\' Window', category: 'windows', kind: 'window', placement: 'opening', swap_group: 'window', gable_mode: 'allow', width: 2, height: 3, elevation: 3.5, price: 155, sort: s++ });
  opt('win33', { name: '3\' x 3\' Window', category: 'windows', kind: 'window', placement: 'opening', swap_group: 'window', width: 3, height: 3, elevation: 3.5, price: 195, sort: s++ });
  opt('winsh', { name: 'Window w/ Shutters', category: 'windows', kind: 'window_shutters', placement: 'opening', swap_group: 'window', width: 2, height: 3, elevation: 3.5, price: 235, sort: s++ });
  opt('transom', { name: 'Transom Window', category: 'windows', kind: 'window_transom', placement: 'opening', swap_group: 'window', gable_mode: 'allow', width: 3, height: 1.25, elevation: 5.5, price: 175, sort: s++ });
  opt('vent', { name: 'Gable Vent', category: 'exterior', kind: 'vent', placement: 'opening', swap_group: 'vent', width: 1.5, height: 1, elevation: -1, price: 45, sort: 0, description: 'Auto-placed high in the gable.' });
  opt('flower', { name: 'Flower Box', category: 'exterior', kind: 'flowerbox', placement: 'wall_exterior', width: 2.5, height: 0.7, depth: 0.75, elevation: 2.4, price: 95, sort: 1 });
  opt('ramp', { name: 'Wood Ramp', category: 'exterior', kind: 'ramp', placement: 'ground', width: 4, height: 0.7, depth: 3.5, price: 295, sort: 2 });
  opt('cupola', { name: 'Cupola', category: 'exterior', kind: 'cupola', placement: 'roof', width: 2, height: 2.5, depth: 2, price: 349, sort: 3 });
  opt('extlight', { name: 'Exterior Barn Light', category: 'electrical', kind: 'ext_light', placement: 'wall_exterior', width: 0.8, height: 1, depth: 1, elevation: 6.9, price: 125, sort: 4 });
  s = 0;
  opt('shelf', { name: "6' Shelf (16\" deep)", category: 'interior', kind: 'shelf', placement: 'wall_interior', width: 6, height: 0.1, depth: 1.33, elevation: 4.5, price: 110, sort: s++ });
  opt('bench', { name: "6' Workbench", category: 'interior', kind: 'workbench', placement: 'wall_interior', width: 6, height: 3, depth: 2, elevation: 0, price: 295, sort: s++ });
  opt('loft', { name: "Storage Loft (4' deep)", category: 'interior', kind: 'loft', placement: 'loft', width: 0, height: 0.3, depth: 4, price: 32, price_unit: 'per_ft_wall', max_qty: 2, sort: s++, description: 'Runs the full length of the wall it sits on. Priced per linear foot.' });
  s = 0;
  opt('elec', { name: 'Electrical Package', category: 'electrical', kind: 'none', placement: 'none', price: 1150, sort: s++, max_qty: 1, description: '60A sub-panel, 2 outlets, 1 switch, 2 LED lights. Hook-up to house not included.' });
  opt('led', { name: 'LED Shop Light', category: 'electrical', kind: 'light', placement: 'ceiling', width: 4, height: 0.2, depth: 0.5, price: 85, sort: s++ });
  opt('outlet', { name: 'Duplex Outlet', category: 'electrical', kind: 'outlet', placement: 'wall_interior', width: 0.3, height: 0.45, depth: 0.1, elevation: 1.5, price: 65, sort: s++ });
  s = 0;
  opt('insul', { name: 'Insulation Package', category: 'upgrades', kind: 'none', placement: 'none', price: 3.5, price_unit: 'per_sqft', max_qty: 1, sort: s++, description: 'R-13 walls, R-19 roof.' });
  opt('radiant', { name: 'Radiant Barrier Roof', category: 'upgrades', kind: 'none', placement: 'none', price: 1.25, price_unit: 'per_sqft', max_qty: 1, sort: s++ });
  opt('floor', { name: '3/4" Floor Upgrade', category: 'upgrades', kind: 'none', placement: 'none', price: 0.85, price_unit: 'per_sqft', max_qty: 1, sort: s++ });
  opt('anchor', { name: 'Anchor Kit', category: 'upgrades', kind: 'none', placement: 'none', price: 175, max_qty: 1, sort: s++ });
  // Electrical parts that come in packages (breaker box is only sold as part of a package)
  opt('breaker', { name: 'Breaker Box (60A sub-panel)', category: 'electrical', kind: 'breaker', placement: 'wall_interior', width: 1.2, height: 1.75, depth: 0.33, elevation: 3.75, price: 450, max_qty: 1, package_only: 1, sort: 10 });
  opt('switch', { name: 'Light Switch', category: 'electrical', kind: 'switch', placement: 'wall_interior', width: 0.25, height: 0.4, depth: 0.08, elevation: 3.8, price: 45, sort: 11 });
  opt('gablewin', { name: 'Gable Window (24" x 16")', description: 'Small fixed window up in the gable end.', category: 'windows', kind: 'window', placement: 'opening', swap_group: 'window', gable_mode: 'only', width: 2, height: 1.33, elevation: 0, price: 145, sort: 99 });

  // Carriage-house doors (built-in models: body takes the door color, window grids take the trim color)
  opt('carriage72', { name: '72" Carriage House Double Doors', category: 'doors', kind: 'door_carriage_double', placement: 'opening', swap_group: 'door', width: 6, height: 71.5 / 12, price: 895, sort: 7, description: 'Double doors with 5-lite transom windows, raised panels and black strap hinges.' });
  opt('carriage36', { name: '36" Carriage House Door', category: 'doors', kind: 'door_carriage_right', placement: 'opening', swap_group: 'door', width: 3, height: 71.5 / 12, price: 450, sort: 8, description: 'Matches one side of the 72" Carriage House Double Doors: 5-lite window, raised panels, black hinges. Hinged on the right.' });
  opt('shelf2', { name: 'Double Shelves (20" deep)', description: 'Built-in double shelves: 2x4 frame with front legs, OSB tops, 20" deep. Lower shelf about 15" off the floor, top at 36". Pick the length, then drag it along the wall.', category: 'interior', kind: 'shelf_double', placement: 'wall_interior', width: 6, height: 3, depth: 20 / 12, elevation: 0, price: 24, price_unit: 'per_ft_item', length_choices: '4, 6, 8, 10, 12', sort: 3 });
  // A window with separate top & bottom grids (single-hung look)
  opt('win23sh', { name: "2' x 3' Window (top & bottom grids)", category: 'windows', kind: 'window', placement: 'opening', swap_group: 'window', gable_mode: '', width: 2, height: 3, elevation: 3.5, grid_top: '2x2', grid_bottom: '2x2', price: 175, sort: 5 });
  // What comes in the Electrical Package, and where each part goes (wall + feet from the wall centre, seen from outside)
  run('UPDATE options SET package_items = ? WHERE id = ?', JSON.stringify([
    { option_id: O.breaker, qty: 1, wall: 'back', offset: -2 },
    { option_id: O.outlet, qty: 2, wall: 'auto', offset: null },
    { option_id: O.switch, qty: 1, wall: 'front', offset: 2.25 },
    { option_id: O.led, qty: 2, wall: 'ceiling', offset: null },
  ]), O.elec);

  // ---- Styles + sizes
  const style = (st, sizes, perSqft, baseAdd) => {
    const id = ins('styles', st);
    sizes.forEach(([w, d], i) => ins('sizes', { style_id: id, width: w, depth: d, price: Math.round((w * d * perSqft + baseAdd) / 5) * 5, sort: i }));
  };
  style({
    name: 'Classic Gable', description: 'Timeless A-frame in LP SmartSide. Door on the gable end.', roof_type: 'gable', ridge_axis: 'depth',
    wall_height: 7, roof_pitch: 6, overhang: 0.75, gable_overhang: 0.5, siding_type: 'lp_smartside', roof_material: 'shingle', sort: 0,
    default_colors: { siding: C['Clay:siding'], trim: C['White:trim'], roof: C['Charcoal:roof'], door: C['Match Trim:door'] },
    standard_options: [{ option_id: O.door36, wall: 'front', offset: 0 }, { option_id: O.win23, wall: 'left', offset: 0 }, { option_id: O.win23, wall: 'right', offset: 0 }, { option_id: O.vent, wall: 'back', offset: 0 }],
  }, [[8, 8], [8, 10], [8, 12], [10, 12], [10, 14], [10, 16], [12, 16], [12, 20]], 34, 1400);
  style({
    name: 'Lofted Barn', description: 'Gambrel roof with extra headroom and a built-in loft.', roof_type: 'barn', ridge_axis: 'width',
    wall_height: 7, roof_pitch: 5, roof_pitch_lower: 18, gambrel_lower_len: 3.25, rake_tail: 'level', overhang: 0.6, siding_type: 'lp_smartside', roof_material: 'shingle', sort: 1,
    default_colors: { siding: C['Barn Red:siding'], trim: C['White:trim'], roof: C['Weathered Wood:roof'], door: C['Match Trim:door'] },
    standard_options: [{ option_id: O.dbl4, wall: 'front', offset: 0 }, { option_id: O.win23, wall: 'front', offset: -3.95 }, { option_id: O.win23, wall: 'front', offset: 3.95 }, { option_id: O.loft, wall: 'left', offset: 0 }],
  }, [[12, 10], [14, 10], [16, 10], [12, 12], [16, 12], [20, 12], [24, 12]], 40, 1600);
  style({
    name: 'Modern Lean-To', description: 'Single-slope studio look with a metal roof.', roof_type: 'lean_to', ridge_axis: 'width',
    wall_height: 7.5, roof_pitch: 2.5, overhang: 1, siding_type: 'lp_smartside', roof_material: 'metal', gable_overhang: 0.5, sort: 2,
    default_colors: { siding: C['Charcoal:siding'], trim: C['Black:trim'], roof: C['Black:roof'], door: C['Natural Wood:door'] },
    standard_options: [{ option_id: O.door9lite, wall: 'front', offset: -2 }, { option_id: O.transom, wall: 'front', offset: 2 }],
  }, [[10, 8], [12, 8], [10, 10], [12, 10], [14, 10], [16, 12]], 48, 1800);
  style({
    name: 'Garage', description: 'Tall walls and a roll-up door for mowers, ATVs and workshops.', roof_type: 'gable', ridge_axis: 'depth',
    wall_height: 8, roof_pitch: 5, overhang: 0.75, roof_edge: 'board_drip', siding_type: 'lp_smartside', roof_material: 'metal', sort: 3,
    default_colors: { siding: C['Pewter:siding'], trim: C['White:trim'], roof: C['Galvalume:roof'], door: C['Match Trim:door'] },
    standard_options: [{ option_id: O.roll8, wall: 'front', offset: 0 }, { option_id: O.door36, wall: 'right', offset: 2 }, { option_id: O.win23, wall: 'left', offset: 0 }],
  }, [[10, 12], [10, 16], [12, 16], [12, 20], [12, 24], [14, 24]], 42, 2400);

  addChickenCoop();
  addGarageDoors();
  setSettings({ migr_catalog_v3: true, migr_shelf_floor: true, migr_coop: true, migr_coop2: true, migr_garage: true });
  console.log('  Seeded sample catalog (styles, sizes, colors, options).');
}

// ---- Chicken coop: its own style plus coop-only parts (walk-in door, small windows, outside nest box,
// chicken door with ramp, roost bars). Added to new installs and, once, to existing ones. Prices are starting
// points to edit in the admin. The coop parts are offered only on coop styles (options.only_styles).
export const COOP_OPTIONS = [
  { key: 'door', name: '30" Coop Door', description: 'Walk-in coop door: siding-coloured boards with a trim-coloured frame and black hinges.', category: 'doors', kind: 'door_coop', placement: 'opening', swap_group: 'door', width: 2.5, height: 5.5, price: 225, sort: 20 },
  { key: 'window', name: 'Coop Window (14" x 21")', description: 'Small single-hung window with 2x2 grids top and bottom.', category: 'windows', kind: 'window', placement: 'opening', swap_group: 'window', width: 14 / 12, height: 21 / 12, elevation: 3.6, grid_top: '2x2', grid_bottom: '2x2', price: 125, sort: 20 },
  { key: 'nest', name: 'Outside Nest Box', description: 'Nest box on the outside wall with a hinged lid, so you can collect eggs without going in. About one nest per foot. White corner boards are optional.', category: 'exterior', kind: 'nest_box', placement: 'opening', width: 6, height: 1, depth: 16 / 12, elevation: 1.4, price: 55, price_unit: 'per_ft_item', length_choices: '3, 4, 5, 6, 8', max_qty: 2, sort: 20 },
  { key: 'pop', name: 'Chicken Door with Ramp', description: 'Small chicken door near the floor with a cleated ramp down to the ground.', category: 'exterior', kind: 'pop_door', placement: 'opening', width: 13 / 12, height: 1.5, depth: 2.5, elevation: 0.08, price: 95, max_qty: 2, sort: 21 },
  { key: 'roost', name: 'Roost Bars', description: 'Two 2x4 roost bars at different heights on braced arms along an inside wall. Pick the length.', category: 'interior', kind: 'roost', placement: 'wall_interior', width: 6, height: 4, depth: 2, elevation: 0, price: 14, price_unit: 'per_ft_item', length_choices: '4, 6, 8, 10', max_qty: 2, sort: 20 },
];
// Overhead sectional garage doors: standard (raised short panels) and carriage house, insulated or not.
// Size comes from width/height - edit them in the admin, or duplicate an option for other sizes.
export const GARAGE_DOORS = [
  { name: "9' x 7' Garage Door", description: 'Steel sectional overhead door with raised short panels and an aluminium threshold. Uninsulated.', garage_panel: 'standard', garage_windows: 0, insulated: 0, slanted_corners: 0, price: 1150 },
  { name: "9' x 7' Insulated Garage Door", description: 'Steel sectional overhead door with raised short panels and a foam-insulated core.', garage_panel: 'standard', garage_windows: 0, insulated: 1, slanted_corners: 0, price: 1450 },
  { name: "9' x 7' Carriage House Garage Door", description: 'Overhead door styled like carriage doors: grooved panels, a row of windows across the top, black strap hinges and handles. Uninsulated.', garage_panel: 'carriage', garage_windows: 1, insulated: 0, slanted_corners: 1, price: 1495 },
  { name: "9' x 7' Insulated Carriage House Garage Door", description: 'Carriage house overhead door with a foam-insulated core, windows across the top, black strap hinges and handles.', garage_panel: 'carriage', garage_windows: 1, insulated: 1, slanted_corners: 1, price: 1795 },
];
export function addGarageDoors() {
  const base = Number(get("SELECT MAX(sort) AS m FROM options WHERE category = 'doors'")?.m) || 0;
  GARAGE_DOORS.forEach((o, i) => {
    if (get('SELECT id FROM options WHERE name = ?', o.name)) return;
    const row = { ...o, category: 'doors', kind: 'door_garage', placement: 'opening', swap_group: 'door', width: 9, height: 7, elevation: 0, sort: base + 1 + i, active: 1 };
    const keys = Object.keys(row);
    run(`INSERT INTO options (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(k => row[k]));
  });
}
export function addChickenCoop() {
  const ins = (table, obj) => {
    const keys = Object.keys(obj);
    return Number(run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(k => (obj[k] !== null && typeof obj[k] === 'object' ? JSON.stringify(obj[k]) : obj[k]))).lastInsertRowid);
  };
  const O = {};
  for (const { key, ...o } of COOP_OPTIONS) O[key] = get('SELECT id FROM options WHERE name = ?', o.name)?.id || (key === 'window' && get(`SELECT id FROM options WHERE name = 'Coop Window (16" x 27")'`)?.id) || ins('options', o);
  let styleId = get("SELECT id FROM styles WHERE name = 'Chicken Coop'")?.id;
  if (!styleId) {
    const color = (cat, ...names) => { for (const n of names) { const r = get('SELECT id FROM colors WHERE category = ? AND name = ?', cat, n); if (r) return r.id; } return get('SELECT id FROM colors WHERE category = ? ORDER BY sort, id LIMIT 1', cat)?.id; };
    const opt = (where, ...p) => get(`SELECT id FROM options WHERE ${where} ORDER BY sort, id LIMIT 1`, ...p)?.id;
    // what else a coop can have: other doors/windows that fit, a gable vent, a cupola, shelves and the usual upgrades
    const extras = [opt("kind = 'door_panel'"), opt("kind = 'window' AND width <= 2.1 AND COALESCE(gable_mode, '') <> 'only'"), opt("kind = 'window' AND gable_mode = 'only'"), opt("kind = 'vent'"),
      opt("kind = 'cupola'"), opt("kind = 'shelf'"), opt("kind = 'flowerbox'"), opt("name = 'Anchor Kit'"), opt("name = '3/4\" Floor Upgrade'")].filter(Boolean);
    styleId = ins('styles', {
      name: 'Chicken Coop', description: 'Walk-in coop with an outside nest box, chicken door and ramp, and roost bars. Deep roof overhang over the windows.',
      roof_type: 'gable', ridge_axis: 'depth', wall_height: 6, roof_pitch: 6, overhang: 0.5, overhang_right: 1.5, gable_overhang: 0.33,
      siding_type: 'lp_smartside', roof_material: 'metal', corner_trim: 5.5, sort: 10,
      default_colors: { siding: color('siding', 'Pewter', 'Charcoal'), trim: color('trim', 'White'), roof: color('roof', 'Galvalume'), door: color('door', 'Match Trim') },
      standard_options: [
        { option_id: O.door, wall: 'front', offset: -0.6 },
        { option_id: O.window, wall: 'right', offset: -2.15 }, { option_id: O.window, wall: 'right', offset: 0 }, { option_id: O.window, wall: 'right', offset: 2.15 },
        { option_id: O.nest, wall: 'right', offset: 0 },
        { option_id: O.pop, wall: 'back', offset: 1.2 },
        { option_id: O.roost, wall: 'left', offset: 0 },
      ],
      available_options: [...Object.values(O), ...extras],
    });
    [[6, 8], [6, 10], [8, 8], [8, 10], [8, 12], [10, 12]].forEach(([w, d], i) => ins('sizes', { style_id: styleId, width: w, depth: d, price: Math.round((w * d * 40 + 1000) / 5) * 5, sort: i }));
  }
  // coop parts show up only on coop styles
  for (const id of Object.values(O)) {
    const cur = get('SELECT only_styles FROM options WHERE id = ?', id)?.only_styles;
    if (!cur) run('UPDATE options SET only_styles = ? WHERE id = ?', JSON.stringify([styleId]), id);
  }
  return { styleId, options: O };
}

// Door / shelf models added after the first release. A database made by an older version only gets its
// catalog seeded once, so bring it up to date one time: switch the stock doors to the new models and add
// the new options if they're missing. Options the shop renamed or rebuilt are left alone.
export const NEW_OPTIONS = [
  { kind: 'door_panel', name: '36" Standard Door', description: 'Matches one side of the 6\' Double Doors. Hinged on the right.', category: 'doors', placement: 'opening', swap_group: 'door', width: 3, height: 6.33, price: 275, sort: 0 },
  { kind: 'door_carriage_double', name: '72" Carriage House Double Doors', description: 'Double doors with 5-lite transom windows, raised panels and black strap hinges.', category: 'doors', placement: 'opening', swap_group: 'door', width: 6, height: 71.5 / 12, price: 895, sort: 7 },
  { kind: 'door_carriage_right', name: '36" Carriage House Door', description: 'Matches one side of the 72" Carriage House Double Doors: 5-lite window, raised panels, black hinges. Hinged on the right.', category: 'doors', placement: 'opening', swap_group: 'door', width: 3, height: 71.5 / 12, price: 450, sort: 8 },
  { kind: 'shelf_double', name: 'Double Shelves (20" deep)', description: 'Built-in double shelves: 2x4 frame with front legs, OSB tops, 20" deep. Lower shelf about 15" off the floor, top at 36". Pick the length, then drag it along the wall.', category: 'interior', placement: 'wall_interior', width: 6, height: 3, depth: 20 / 12, elevation: 0, price: 24, price_unit: 'per_ft_item', length_choices: '4, 6, 8, 10, 12', sort: 3 },
];
export function upgradeCatalog() {
  if (!getSettings().migr_coop) { addChickenCoop(); setSettings({ migr_coop: true, migr_coop2: true }); console.log('  Catalog updated: added the Chicken Coop style and coop parts.'); }
  if (!getSettings().migr_garage) { addGarageDoors(); setSettings({ migr_garage: true }); console.log('  Catalog updated: added garage doors (standard and carriage house, insulated and uninsulated).'); }
  if (!getSettings().migr_coop2) {
    // coop windows are 14" x 21" and the nest box is 6' long, as built; only where the first version is still unchanged
    run(`UPDATE options SET name = 'Coop Window (14" x 21")', width = ?, height = ?, elevation = 3.6 WHERE name = 'Coop Window (16" x 27")' AND ABS(width - ?) < 0.001 AND ABS(height - 2.25) < 0.001`, 14 / 12, 21 / 12, 16 / 12);
    run("UPDATE options SET width = 6, description = ? WHERE kind = 'nest_box' AND name = 'Outside Nest Box' AND width = 5", COOP_OPTIONS.find(o => o.key === 'nest').description);
    setSettings({ migr_coop2: true }); console.log('  Catalog updated: coop windows 14" x 21", nest box 6\'.');
  }
  if (!getSettings().migr_shelf_floor) {
    // double shelves became floor-standing (legs, top at 36") - move the stock option down to the floor
    run(`UPDATE options SET elevation = 0, height = 3, description = 'Built-in double shelves: 2x4 frame with front legs, OSB tops, 20" deep. Lower shelf about 15" off the floor, top at 36". Pick the length, then drag it along the wall.' WHERE kind = 'shelf_double' AND elevation = 2.5 AND height = 2.5`);
    setSettings({ migr_shelf_floor: true });
  }
  if (getSettings().migr_catalog_v3) return;
  // stock doors -> new models (X-braced barn doors become the plain panel doors)
  run(`UPDATE options SET kind = 'door_panel_double' WHERE kind = 'door_double' AND name = '6'' Double Doors'`);
  run(`UPDATE options SET kind = 'door_panel', description = 'Matches one side of the 6'' Double Doors. Hinged on the right.' WHERE kind = 'door_single' AND name = '36" Standard Door'`);
  run(`UPDATE options SET name = '36" Standard Door', height = 6.33, description = 'Matches one side of the 6'' Double Doors. Hinged on the right.' WHERE kind = 'door_panel' AND name = '36" Single Door'`);
  run(`UPDATE options SET kind = 'door_carriage_right', name = '36" Carriage House Door' WHERE kind = 'door_carriage' AND (name = '36" Single Carriage House Door' OR name = '36" Carriage House Door')`);
  run(`UPDATE options SET length_choices = '4, 6, 8, 10, 12', price_unit = 'per_ft_item' WHERE kind = 'shelf_double' AND (length_choices IS NULL OR length_choices = '')`);
  const added = [];
  for (const o of NEW_OPTIONS) {
    if (get('SELECT id FROM options WHERE kind = ?', o.kind)) continue;
    const keys = Object.keys(o);
    added.push(Number(run(`INSERT INTO options (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map(k => o[k])).lastInsertRowid));
  }
  // styles limited to a list of options also get the new ones
  if (added.length) for (const st of db.prepare('SELECT id, available_options FROM styles WHERE available_options IS NOT NULL').all()) {
    let list; try { list = JSON.parse(st.available_options); } catch { continue; }
    if (Array.isArray(list)) run('UPDATE styles SET available_options = ? WHERE id = ?', JSON.stringify([...new Set([...list, ...added])]), st.id);
  }
  setSettings({ migr_catalog_v3: true });
  if (added.length) console.log(`  Catalog updated: added ${added.length} new option(s) (doors / double shelves).`);
}
