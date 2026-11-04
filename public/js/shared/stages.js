// Default pipeline stages (shared by the server and the demo).
export const DEFAULT_SALES_STAGES = [
  { id: 'new', name: 'New lead' }, { id: 'contacted', name: 'Contacted' }, { id: 'quoted', name: 'Quote sent' },
  { id: 'contract', name: 'Contract sent' }, { id: 'sold', name: 'Sold' },
];
export const DEFAULT_ORDER_STAGES = [
  { id: 'sold', name: 'Sold – waiting to build', group: 'production' },
  { id: 'in_production', name: 'In production', group: 'production' },
  { id: 'built', name: 'Built – ready to deliver', group: 'production', handoff: true },
  { id: 'scheduled', name: 'Delivery scheduled', group: 'delivery' },
  { id: 'out', name: 'Out for delivery', group: 'delivery' },
  { id: 'delivered', name: 'Delivered', group: 'delivery' },
];
