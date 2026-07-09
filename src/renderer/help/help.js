'use strict';

document.getElementById('close').addEventListener('click', () => window.help.close());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.help.close();
});
