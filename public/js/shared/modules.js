// Add-on modules. The 3D configurator is always on; the others bolt on per install.
// Shared by the server, the admin, the configurator and the demo so they always agree.
// Turning a module off removes its menus, buttons, settings pages and API routes for that install.
// Records underneath (customers, orders) keep being kept, so switching a module on later picks up history.

export const MODULES = [
  { id: 'configurator', name: '3D configurator', always: true,
    desc: 'The 3D shed builder, quotes, catalog, pricing, dealer lots, webhooks, GoHighLevel and the Open API.' },
  { id: 'crm', name: 'CRM',
    desc: 'Contacts, conversations (texts and email), sales pipeline, tasks, saved replies and instant auto-replies to new leads.' },
  { id: 'pos', name: 'Point of sale',
    desc: 'Cash and rent-to-own contracts from any 3D design, contract templates, e-signatures by text, email or in person.' },
  { id: 'orders', name: 'Production & delivery',
    desc: 'Order board for the shop and the delivery schedule, with Production and Delivery logins. Orders come in from signed contracts.' },
];
export const ADDONS = MODULES.filter(m => !m.always).map(m => m.id);
export const ALL_ON = Object.freeze(Object.fromEntries(ADDONS.map(id => [id, true])));

/** Turn anything stored or typed (object, "crm,pos", "all", "none") into { crm, pos, orders } booleans. */
export function normalizeModules(v, fallback = ALL_ON) {
  if (v == null || v === '') return { ...fallback };
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'all') return { ...ALL_ON };
    if (s === 'none' || s === 'configurator') return Object.fromEntries(ADDONS.map(id => [id, false]));
    const want = new Set(s.split(/[\s,;+]+/).filter(Boolean));
    return Object.fromEntries(ADDONS.map(id => [id, want.has(id)]));
  }
  if (typeof v === 'object') return Object.fromEntries(ADDONS.map(id => [id, v[id] === undefined ? !!fallback[id] : !!v[id]]));
  return { ...fallback };
}

/** Which module each permission belongs to (permissions of a switched-off module are never granted). */
export function moduleOfPerm(perm) {
  const p = String(perm || '');
  if (p.startsWith('crm.')) return 'crm';
  if (p.startsWith('pos.') || p.startsWith('contracts.')) return 'pos';
  if (p.startsWith('orders.')) return 'orders';
  return null; // configurator: always on
}

/** Admin pages that belong to a module ('any' = needs at least one add-on). */
export const PAGE_MODULE = {
  crm: 'crm', conversations: 'crm', pipeline: 'crm', tasks: 'crm',
  pos: 'pos', templates: 'pos', 'pos-settings': 'pos',
  orders: 'orders',
  messaging: 'any',
};
export function pageOn(page, mods) {
  const m = PAGE_MODULE[page];
  if (!m) return true;
  if (m === 'any') return ADDONS.some(id => mods[id]);
  return !!mods[m];
}
/** Logins that only make sense with a module: production + delivery need the order board.
 *  Sales logins always work: lot staff use them for the dealer-facing configurator. */
export const ROLE_MODULE = { production: 'orders', delivery: 'orders' };
export function roleUsable(role, mods) {
  const m = ROLE_MODULE[role];
  return !m || !!mods[m];
}
