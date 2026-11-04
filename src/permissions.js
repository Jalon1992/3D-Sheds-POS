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
};
export const can = (user, perm) => !!user && (PERMS[perm] || []).includes(user.role || 'admin');

/** Express middleware: requireSession must run first. */
export const need = perm => (req, res, next) => (can(req.user, perm) ? next() : res.status(403).json({ error: 'Your account does not have access to this.' }));

/** Lot-limited users only see records of their own dealer lot (same rule as quotes). Returns [sqlFragment, params]. */
export function lotFilter(user, col = 'dealer_id') {
  if (!user?.dealer_id || user.role === 'admin') return ['', []];
  return [` AND ${col} = ?`, [String(user.dealer_id)]];
}
export const inLot = (user, row) => !user?.dealer_id || user.role === 'admin' || String(row?.dealer_id ?? '') === String(user.dealer_id);
export function permissionsFor(user) { return Object.keys(PERMS).filter(p => can(user, p)); }
