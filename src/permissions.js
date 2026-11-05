import { moduleOfPerm, ALL_ON } from '../public/js/shared/modules.js';

// Which add-on modules this install has (server: settings; demo: its own store). Set once at startup.
let moduleSource = () => ALL_ON;
export function setModuleSource(fn) { moduleSource = fn; }
export function modulesOn() { try { return moduleSource() || ALL_ON; } catch { return ALL_ON; } }
export const moduleOn = id => id === 'configurator' || !!modulesOn()[id];

// Who can do what in the CRM, point of sale and order boards.
// admin: everything · sales: CRM + contracts · production: build board · delivery: delivery schedule.
const PERMS = {
  'crm.view': ['admin', 'sales'],
  'crm.edit': ['admin', 'sales'],
  'crm.message': ['admin', 'sales'],
  'crm.delete': ['admin'],
  'crm.settings': ['admin'],                 // pipelines, snippets
  'pos.view': ['admin', 'sales'],
  'pos.create': ['admin', 'sales'],
  'pos.void': ['admin', 'sales'],
  'pos.templates': ['admin'],
  'orders.view': ['admin', 'sales', 'production', 'delivery'],
  'orders.production': ['admin', 'production'],   // move cards through build stages
  'orders.delivery': ['admin', 'delivery'],       // schedule + mark delivered
  'orders.message': ['admin', 'sales', 'delivery'], // text the customer about their order / delivery
  'contracts.download': ['admin', 'sales'],
  'quotes.view': ['admin', 'sales'],          // 3D quotes list (part of the configurator, always on)
};
// a permission is granted only when the user's role has it AND its module is switched on for this install
export const can = (user, perm) => !!user && (PERMS[perm] || []).includes(user.role || 'admin') && (!moduleOfPerm(perm) || moduleOn(moduleOfPerm(perm)));

/** Express middleware: requireSession must run first. */
export const need = (...perms) => (req, res, next) => {
  if (perms.some(p => can(req.user, p))) return next();
  // a switched-off module answers "not found", as if it isn't installed
  if (perms.every(p => moduleOfPerm(p) && !moduleOn(moduleOfPerm(p)))) return res.status(404).json({ error: 'This feature is not part of your plan.', module_off: true });
  res.status(403).json({ error: 'Your account does not have access to this.' });
};

/** Lot-limited users only see records of their own dealer lot (same rule as quotes). Returns [sqlFragment, params]. */
export function lotFilter(user, col = 'dealer_id') {
  if (!user?.dealer_id || user.role === 'admin') return ['', []];
  return [` AND ${col} = ?`, [String(user.dealer_id)]];
}
export const inLot = (user, row) => !user?.dealer_id || user.role === 'admin' || String(row?.dealer_id ?? '') === String(user.dealer_id);
export function permissionsFor(user) { return Object.keys(PERMS).filter(p => can(user, p)); }
