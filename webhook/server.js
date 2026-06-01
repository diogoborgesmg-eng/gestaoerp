// ============================================
// GestaoERP - Webhook WhatsApp Server
// Di Casa Laranjinha - Render Node.js
// ============================================

const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const EVOLUTION_URL = 'https://evolution-api-latest-lrlv.onrender.com';
const EVOLUTION_KEY = 'dicasalaranjinha2024';
const INSTANCE = 'dicasalaranjinha';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Função para fazer requisições HTTPS
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
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function enviarWpp(numero, texto) {
  try {
    await httpsPost(`${EVOLUTION_URL}/message/sendText/${INSTANCE}`, 
      { number: numero, text: texto },
      { apikey: EVOLUTION_KEY }
    );
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
          { type: 'text', text: `Você é o assistente financeiro do Di Casa Laranjinha em Patos de Minas MG.
Analise este documento e extraia:
- Tipo (recibo, NF, PIX, cupom, cartão, etc)
- Fornecedor/Estabelecimento  
- Data
- Valor total
- Forma de pagamento
- Itens principais se visível

Responda de forma clara e direta em português. Se não for documento financeiro, informe educadamente.` }
        ]
      }]
    }, {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    });
    return result.content?.[0]?.text || 'Não consegui analisar.';
  } catch(e) {
    console.error('Erro Claude:', e.message);
    return 'Erro ao analisar. Tente novamente.';
  }
}

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Health check
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Webhook WhatsApp ativo ✅', versao: '1.0', instancia: INSTANCE }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405); res.end('Método não permitido');
    return;
  }

  // Ler body
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);
      console.log('Evento:', data.event, '| JID:', data.data?.key?.remoteJid);

      if (data.event !== 'messages.upsert') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ignorado: data.event }));
        return;
      }

      const msg = data.data;
      if (!msg || msg.key?.fromMe) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      const numero = msg.key?.remoteJid;
      const tipo = msg.messageType;
      const isGrupo = numero?.endsWith('@g.us');

      // Texto
      if (tipo === 'conversation' || tipo === 'extendedTextMessage') {
        const txt = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').toLowerCase();
        if (isGrupo && !txt.includes('ajuda') && !txt.includes('bot')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        await enviarWpp(numero, '👋 Olá! Sou o assistente do *Di Casa Laranjinha* 🍕🍖\n\n📸 Mande uma *foto de recibo ou comprovante* que analiso na hora!\n\nIdentifico: recibos, notas fiscais, PIX, cupons e cartões.');
      }
      // Imagem
      else if (tipo === 'imageMessage') {
        await enviarWpp(numero, '🔍 Analisando documento... um momento.');
        const base64 = msg.message?.imageMessage?.base64 || msg.message?.base64;
        if (!base64) {
          await enviarWpp(numero, '❌ Não consegui acessar a imagem. Tente reenviar.');
        } else {
          const analise = await analisarImagem(base64, 'image/jpeg');
          await enviarWpp(numero, `📋 *Análise do Documento*\n\n${analise}\n\n_Di Casa Laranjinha - GestaoERP_ ✅`);
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, tipo }));

    } catch(e) {
      console.error('Erro:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ erro: e.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Webhook WhatsApp rodando na porta ${PORT}`);
  console.log(`📱 Instância: ${INSTANCE}`);
  console.log(`🔑 API Key: ${ANTHROPIC_KEY ? 'configurada' : 'NÃO CONFIGURADA!'}`);
});
