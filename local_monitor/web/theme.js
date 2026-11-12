'use strict';
(() => {
  const choices = new Set(['light', 'dark', 'system', 'rpg', 'night', 'cloud', 'real', 'orbit']);
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'light';
  try {
    const saved = localStorage.getItem('lm-theme');
    if (choices.has(saved)) preference = saved;
  } catch {}
  function apply() {
    document.documentElement.dataset.theme = preference === 'system'
      ? (system.matches ? 'dark' : 'light') : preference;
    const select = document.getElementById('theme');
    if (select) select.value = preference;
    document.dispatchEvent(new Event('themechange'));
  }
  // Run before the stylesheet to avoid a light flash when dark is saved.
  apply();
  system.addEventListener('change', apply);
  window.addEventListener('storage', event => {
    if (event.key === 'lm-theme' || event.key === null) {
      preference = choices.has(event.newValue) ? event.newValue : 'light';
      apply();
    }
  });
  document.addEventListener('DOMContentLoaded', () => {
    const select = document.getElementById('theme');
    apply();
    select.addEventListener('change', () => {
      preference = choices.has(select.value) ? select.value : 'light';
      try { localStorage.setItem('lm-theme', preference); } catch {}
      apply();
    });
  });
})();
