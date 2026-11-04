// Demo mode for the 3D builder: in-browser backend (shared with the admin demo) + artifact downloads.
import './backend.js';
import './downloads.js';
window.__adminUrl = 'admin.html'; // "Save design & return" goes back to the demo admin

addEventListener('DOMContentLoaded', () => {
  const b = document.createElement('div');
  b.className = 'demo-banner';
  b.innerHTML = '<b>Demo</b> — quotes stay in this browser and are not sent anywhere. <a href="admin.html">Open the admin →</a>';
  document.body.prepend(b);
  // Print isn't available inside the artifact viewer
  const p = document.getElementById('planPrint'); if (p && window.parent !== window) p.hidden = true;
});
