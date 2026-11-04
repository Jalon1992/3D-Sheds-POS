// Demo signing page (sign.html#<token>) running on the in-browser backend.
import './backend.js';
import './crm-backend.js';
import './downloads.js';
import './demo-common.js';
addEventListener('DOMContentLoaded', () => {
  const b = document.createElement('div'); b.className = 'demo-banner';
  b.innerHTML = '<b>Demo signing page</b> — this is what your customer sees from the text/email link. <a href="admin.html">← Back to the admin</a>';
  document.body.prepend(b);
});
import '../public/js/sign.js';
