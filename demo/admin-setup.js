// Admin demo setup: point "Open configurator" at the builder page and show a banner.
window.__configuratorUrl = 'index.html#staff'; // opens the dealer-facing configurator (prices always shown)
addEventListener('DOMContentLoaded', () => {
  const b = document.createElement('div');
  b.className = 'demo-banner';
  b.innerHTML = '<b>Admin demo</b> — changes are saved in this browser only and show up in the <a href="index.html">3D builder</a>. Dashboard charts include made-up sample history so you can see the reports. <label>View as <select id="demoAs"></select></label> <button type="button" id="demoReset">Reset demo data</button>';
  document.body.prepend(b);
  const sel = b.querySelector('#demoAs');
  let as = 1; try { as = Number(sessionStorage.getItem('shedbuilder-demo-v1-as')) || 1; } catch { /* */ }
  sel.innerHTML = (window.__shedDemoUsers?.() || []).map(u => `<option value="${u.id}" ${u.id === as ? 'selected' : ''}>${u.name} (${u.role})</option>`).join('');
  sel.onchange = () => window.__shedDemoViewAs(sel.value);
  b.querySelector('#demoReset').onclick = () => {
    if (b.dataset.confirm) return window.__shedDemoReset();
    b.dataset.confirm = '1'; b.querySelector('#demoReset').textContent = 'Click again to reset everything';
  };
});
