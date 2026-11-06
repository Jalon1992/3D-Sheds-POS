// Public, integration-friendly representation of a quote. Shared by the server and the demo.
/** Public, integration-friendly representation of a quote (also used as the API response). */
export function formatQuote(q, baseUrl, linkFor) {
  const p = q.pricing || {};
  const lines = p.lines || [];
  const colors = lines.filter(l => l.type === 'color').reduce((a, l) => (a[l.category] = l.label.split(': ')[1], a), {});
  const options = lines.filter(l => l.type === 'option').map(l => ({
    name: l.label, category: l.category, wall: l.wall, price: l.amount, note: l.note || undefined, detail: l.detail || undefined,
  }));
  const roofLine = lines.find(l => l.type === 'roof');
  const roofing = roofLine ? roofLine.label.replace(/^Roofing:\s*/, '') : undefined;
  const base = (baseUrl || '').replace(/\/$/, '');
  const L = linkFor || {};
  const summary = [
    `${q.style_name} ${q.size_label}`,
    roofing ? `Roof: ${roofing}` : '',
    Object.entries(colors).map(([k, v]) => `${k}: ${v}`).join(', '),
    options.length ? 'Options: ' + options.map(o => o.name).join(', ') : '',
    `Total: $${Number(q.total || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  ].filter(Boolean).join(' | ');
  return {
    id: q.id,
    number: q.number,
    status: q.status,
    created_at: q.created_at,
    updated_at: q.updated_at,
    customer: {
      first_name: q.first_name, last_name: q.last_name, full_name: [q.first_name, q.last_name].filter(Boolean).join(' '),
      email: q.email, phone: q.phone, address: q.address, city: q.city, state: q.state, zip: q.zip,
      notes: q.notes, sms_consent: !!q.sms_consent,
    },
    shed: {
      style: q.style_name, size: q.size_label,
      width_ft: p.size?.width, depth_ft: p.size?.depth, sq_ft: p.size ? p.size.width * p.size.depth : undefined,
      roofing, colors,
    },
    options,
    pricing: { subtotal: p.subtotal, delivery: p.delivery, tax: p.tax, tax_rate: p.tax_rate, total: p.total, tier: q.price_tier || p.tier_name || null, pricing_zip: q.pricing_zip || p.zip || null },
    dealer: q.dealer_name ? { id: q.dealer_id, name: q.dealer_name, ...(p.dealer || {}) } : null,
    summary,
    links: {
      view_3d: L.view3d ? L.view3d(q) : `${base}/?q=${q.token}`,
      download_3d_model: L.glb ? L.glb(q) : `${base}/?q=${q.token}&download=glb`,
      floor_plan_svg: L.plan ? L.plan(q) : `${base}/q/${q.token}/floorplan.svg`,
      admin: L.admin ? L.admin(q) : `${base}/admin/#/quotes/${q.id}`,
    },
    source: q.source, utm: q.utm || undefined,
    integrations: { ghl_contact_id: q.ghl_contact_id, ghl_opportunity_id: q.ghl_opportunity_id },
    config: q.config,
  };
}

