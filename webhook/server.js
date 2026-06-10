const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 10000;
const EVOLUTION_URL = 'https://evolution-api-latest-lrlv.onrender.com';
const EVOLUTION_KEY = 'dicasalaranjinha2024';
const INSTANCE = 'dicasalaranjinha';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GRUPO_AUTORIZADO = process.env.GRUPO_ID || '';

function httpsRequest(method, url, data, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const body = data ? JSON.stringify(data) : null;
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers
      }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function enviarWpp(numero, texto) {
  try {
    await httpsRequest('POST',
      `${EVOLUTION_URL}/message/sendText/${INSTANCE}`,
      { number: numero, text: texto },
      { apikey: EVOLUTION_KEY }
    );
  } catch(e) { console.error('Erro enviar:', e.message); }
}

async function buscarMidia(msg) {
  try {
    // Tenta os 3 endpoints da Evolution API v2
    const endpoints = [
      `/chat/getBase64FromMediaMessage/${INSTANCE}`,
      `/message/getMedia/${INSTANCE}`,
    ];
    
    for (const ep of endpoints) {
      console.log('Tentando endpoint:', ep);
      const r = await httpsRequest('POST',
        `${EVOLUTION_URL}${ep}`,
        { message: { key: msg.key, messageType: msg.messageType, message: msg.message } },
        { apikey: EVOLUTION_KEY }
      );
      console.log('Resposta:', JSON.stringify(r).substring(0, 200));
      const b64 = r.base64 || r.data?.base64 || r.mediaData?.base64;
      if (b64) { console.log('✅ Base64 encontrado!'); return b64; }
    }
    return null;
  } catch(e) {
    console.error('Erro buscar mídia:', e.message);
    return null;
  }
}

async function analisarImagem(base64Data, mime) {
  try {
    console.log('Chamando Claude com base64 tamanho:', base64Data.length);
    
    const payload = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data: base64Data } },
          { type: 'text', text: 'Analise este comprovante/recibo financeiro. Extraia APENAS o que está escrito: valor, destinatário/estabelecimento, data, tipo (pix/boleto/cartão/dinheiro), observação. Responda em português de forma concisa.' }
        ]
      }]
    });

    const result = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            console.log('Status HTTP:', res.statusCode);
            console.log('Resposta Claude raw:', JSON.stringify(parsed).substring(0, 400));
            resolve(parsed);
          } catch(e) {
            console.error('Erro parse Claude:', e.message, data.substring(0,200));
            reject(e);
          }
        });
      });

      req.on('error', (e) => {
        console.error('Erro HTTP Claude:', e.message);
        reject(e);
      });

      // Escreve o payload em chunks para evitar problemas com payloads grandes
      req.write(payload);
      req.end();
    });

    if (result.error) {
      console.error('Erro API Claude:', JSON.stringify(result.error));
      return 'Erro na análise: ' + (result.error.message || 'desconhecido');
    }

    const texto = result.content?.[0]?.text;
    console.log('✅ Claude respondeu:', texto?.substring(0, 150));
    return texto || 'Não consegui extrair os dados do comprovante.';

  } catch(e) {
    console.error('Erro analisarImagem:', e.message);
    return 'Erro ao processar imagem: ' + e.message;
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Webhook v7 ativo ✅' }));
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

    // Debug: mostra o que chegou
    console.log('📨 Body recebido:', body.length, 'chars');
    console.log('📋 Headers:', JSON.stringify(req.headers).substring(0,300));
    if(body.length > 0) console.log('📄 Body preview:', body.substring(0,500));
    
    try {
      if (!body || body.trim() === '') {
        // Verifica se tem dados na query string (alguns webhooks usam GET)
        const qs = new URL('http://x'+req.url).searchParams;
        console.log('⚠️ Body vazio — URL params:', req.url.substring(0,200));
        return;
      }
      const data = JSON.parse(body);
      const evento = data.event || data.type || '';
      console.log('📬 Evento:', evento, 'Keys:', Object.keys(data).join(','));
      if (evento && evento !== 'messages.upsert' && evento !== 'message' && !evento.includes('message')) { 
        console.log('Ignorado:', evento); return; 
      }

      let msgs = [];
      if (Array.isArray(data.data)) msgs = data.data;
      else if (data.data?.messages) msgs = data.data.messages;
      else if (data.data) msgs = [data.data];

      for (const msg of msgs) {
        if (msg.key?.fromMe) continue;
        const numero = msg.key?.remoteJid;
        if (!numero || !numero.endsWith('@g.us')) { console.log('Ignorado (não grupo):', numero); continue; }
        if (GRUPO_AUTORIZADO && numero !== GRUPO_AUTORIZADO) continue;

        const tipo = msg.messageType || '';
        console.log('--- MSG ---');
        console.log('Grupo:', numero);
        console.log('Tipo:', tipo);
        console.log('Key:', JSON.stringify(msg.key));
        // Log completo da mensagem para debug
        console.log('MSG completa:', JSON.stringify(msg).substring(0, 500));

        if (tipo === 'conversation' || tipo === 'extendedTextMessage') {
          const txt = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
          await enviarWpp(numero, `✅ Recebi: "${txt}"\n\n📸 Mande uma foto de NF ou comprovante para analisar!`);
        }
        else if (tipo === 'imageMessage' || tipo === 'documentMessage' || tipo === 'documentWithCaptionMessage') {
          await enviarWpp(numero, '🔍 Recebi! Buscando imagem...');
          
          const base64 = await buscarMidia(msg);
          
          if (!base64) {
            console.log('❌ Base64 não encontrado em nenhum endpoint');
            await enviarWpp(numero, '❌ Não consegui acessar a imagem.\n\nTente:\n1. Enviar a foto diretamente (não encaminhada)\n2. Tirar foto da câmera');
            continue;
          }
          
          await enviarWpp(numero, '✅ Imagem obtida! Analisando com IA...');
          const analise = await analisarImagem(base64, 'image/jpeg');
          await enviarWpp(numero, `📋 *Análise*\n\n${analise}\n\n_Di Casa Laranjinha_ ✅`);
        }
      }
    } catch(e) {
      console.error('Erro geral:', e.message);
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Webhook v7 rodando na porta ${PORT}`);
  console.log(`🔑 API Key: ${ANTHROPIC_KEY ? '✅' : '❌'}`);
});
