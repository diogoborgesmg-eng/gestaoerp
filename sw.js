// GestaoERP Service Worker — sempre atualiza
const CACHE_VERSION = 'gestaoerp-1780517909';
const STATIC_CACHE = CACHE_VERSION;

// Instala e ativa imediatamente
self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Remove caches antigos
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== STATIC_CACHE).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // index.html — SEMPRE busca do servidor (nunca cache)
  if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(e.request, {cache: 'no-store'})
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // API e webhooks — sempre rede
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // Rota de compartilhamento de arquivos
  if (url.pathname === '/share' && e.request.method === 'POST') {
    e.respondWith((async () => {
      const data = await e.request.formData();
      const file = data.get('file');
      const client = await clients.get(e.resultingClientId || e.clientId);
      if (client && file) {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => client.postMessage({type:'shared-file',data:reader.result,name:file.name});
      }
      return Response.redirect('/?shared=1', 303);
    })());
    return;
  }

  // Outros recursos — cache primeiro, rede como fallback
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(STATIC_CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      });
    })
  );
});

// Escuta mensagem para forçar atualização
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});
