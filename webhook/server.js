const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const EVOLUTION_URL = 'https://evolution-api-latest-lrlv.onrender.com';
const EVOLUTION_KEY = 'dicasalaranjinha2024';
const INSTANCE = 'dicasalaranjinha';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

function httpsPost(url, data, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const body = JSON.stringify(data);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }
    };
    const req = https.request(options, (res) => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function enviarWpp(numero, texto) {
  try {
    console.log('Enviando para:', numero);
    const r = await httpsPost(`${EVOLUTION_URL}/message/sendText/${INSTANCE}`,
      { number: numero, text: texto },
      { apikey: EVOLUTION_KEY }
    );
    console.log('Resposta envio:', JSON.stringify(r).substring(0, 100));
  } catch(e) { console.error('Erro enviar:', e.message); }
}

async function analisarImagem(base64, mime) {
  try {
    const result = await httpsPost('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data: base64 } },
          { type: 'text', text: 'Você é o assistente financeiro do Di Casa Laranjinha em Patos de Minas MG. Analise este documento e extraia: Tipo, Fornecedor, Data, Valor total, Forma de pagamento, Itens. Responda direto em português.' }
        ]
      }]
    }, { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' });
    return result.content?.[0]?.text || 'Não consegui analisar.';
  } catch(e) { console.error('Erro Claude:', e.message); return 'Erro ao analisar.'; }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Webhook WhatsApp ativo ✅', versao: '2.0', instancia: INSTANCE }));
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      console.log('=== REQUISIÇÃO RECEBIDA ===');
      console.log('Body bruto:', body.substring(0, 500));

      const data = JSON.parse(body);
      console.log('Evento:', data.event);
      console.log('Data keys:', Object.keys(data.data || {}));

      // Responde imediatamente
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));

      // Processar de forma assíncrona
      const evento = data.event || '';

      // Aceitar variações do evento de mensagem
      if (!evento.includes('message') && !evento.includes('MESSAGE')) {
        console.log('Evento ignorado:', evento);
        return;
      }

      // Tentar pegar a mensagem de diferentes estruturas
      const msg = data.data || data;
      const fromMe = msg.key?.fromMe || msg.fromMe;
      if (fromMe) { console.log('Mensagem própria, ignorando'); return; }

      const numero = msg.key?.remoteJid || msg.remoteJid;
      const tipo = msg.messageType || msg.type || '';

      console.log('Número:', numero, '| Tipo:', tipo);

      if (!numero) { console.log('Sem número, ignorando'); return; }

      // Texto
      if (tipo.includes('conversation') || tipo.includes('text') || tipo.includes('extendedText')) {
        const txt = (
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.body || ''
        ).toLowerCase();

        console.log('Texto recebido:', txt);
        const isGrupo = numero.endsWith('@g.us');
        if (isGrupo && !txt.includes('ajuda') && !txt.includes('bot')) return;

        await enviarWpp(numero, '👋 Olá! Sou o assistente do *Di Casa Laranjinha* 🍕🍖\n\n📸 Mande uma *foto de recibo ou comprovante* que analiso na hora!');
      }
      // Imagem
      else if (tipo.includes('image') || tipo.includes('Image')) {
        await enviarWpp(numero, '🔍 Analisando documento... um momento.');
        const base64 = msg.message?.imageMessage?.base64 || msg.message?.base64 || msg.base64;
        if (!base64) {
          await enviarWpp(numero, '❌ Não consegui acessar a imagem. Tente reenviar.');
          return;
        }
        const analise = await analisarImagem(base64, 'image/jpeg');
        await enviarWpp(numero, `📋 *Análise do Documento*\n\n${analise}\n\n_Di Casa Laranjinha - GestaoERP_ ✅`);
      } else {
        console.log('Tipo não tratado:', tipo);
      }

    } catch(e) {
      console.error('Erro geral:', e.message);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(JSON.stringify({ erro: e.message }));
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Webhook WhatsApp v2 rodando na porta ${PORT}`);
  console.log(`📱 Instância: ${INSTANCE}`);
  console.log(`🔑 API Key: ${ANTHROPIC_KEY ? 'configurada ✅' : 'NÃO CONFIGURADA ❌'}`);
});
