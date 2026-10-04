// Load in <head> without defer so the saved theme applies before first paint.
// Pages style themselves from :root[data-theme]; any [data-theme-toggle] button flips it.
(() => {
  const KEY = 'dsa-theme';
  const root = document.documentElement;
  const system = () => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const apply = (t) => root.setAttribute('data-theme', t);

  apply(localStorage.getItem(KEY) || system());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!localStorage.getItem(KEY)) apply(system());
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-theme-toggle]')) return;
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem(KEY, next);
    apply(next);
  });
})();
