(() => {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js').catch(error => console.warn('PWA registration failed', error)));
})();
