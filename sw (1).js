const CACHE = 'gestaoerp-v3';

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname === '/share' && e.request.method === 'POST') {
    e.respondWith((async () => {
      try {
        const data = await e.request.formData();
        const file = data.get('file');
        const allClients = await self.clients.matchAll({ type: 'window' });
        if (file && allClients.length > 0) {
          const arrayBuffer = await file.arrayBuffer();
          const base64 = btoa(new Uint8Array(arrayBuffer).reduce((d,b)=>d+String.fromCharCode(b),''));
          allClients[0].postMessage({type:'SHARE_FILE',base64,mimeType:file.type,name:file.name});
          allClients[0].focus();
        } else {
          await self.clients.openWindow('/?share=1');
        }
      } catch(e) { await self.clients.openWindow('/?share=1'); }
      return Response.redirect('/?share=1', 303);
    })());
    return;
  }
  e.respondWith(fetch(e.request).catch(()=>new Response('Offline')));
});

// Instala o service worker
self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});

// Intercepta requisições
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Rota de compartilhamento — recebe arquivos do banco/apps
  if (url.pathname === '/share' && e.request.method === 'POST') {
    e.respondWith((async () => {
      const data = await e.request.formData();
      const file = data.get('file');
      const text = data.get('text') || '';
      const title = data.get('title') || '';

      // Abre o app e passa os dados via URL
      const client = await self.clients.get(
        (await self.clients.matchAll({ type: 'window' }))[0]?.id
      );

      if (client) {
        // App já aberto — envia mensagem
        client.postMessage({
          type: 'SHARE_RECEIVED',
          file: file ? { name: file.name, type: file.type, size: file.size } : null,
          text,
          title
        });

        // Se é arquivo de imagem, converte e envia
        if (file && file.type.startsWith('image/')) {
          const reader = new FileReaderSync();
          const buffer = await file.arrayBuffer();
          const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
          client.postMessage({
            type: 'SHARE_FILE',
            base64,
            mimeType: file.type,
            name: file.name
          });
        }

        client.focus();
      } else {
        // App fechado — abre com parâmetro
        await self.clients.openWindow('/?share=1');
      }

      return Response.redirect('/?share=1', 303);
    })());
    return;
  }

  // Cache primeiro para assets estáticos
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});

// Recebe arquivo grande via postMessage
self.addEventListener('message', async e => {
  if (e.data?.type === 'SHARE_FILE_LARGE') {
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.postMessage(e.data));
  }
});
