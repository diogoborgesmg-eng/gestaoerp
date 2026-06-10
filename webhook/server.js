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
    const r = await httpsRequest('POST',
      `${EVOLUTION_URL}/message/sendText/${INSTANCE}`,
      { number: numero, text: texto },
      { apikey: EVOLUTION_KEY }
    );
    console.log('Enviado para:', numero, '|', JSON.stringify(r).substring(0, 80));
  } catch(e) { console.error('Erro enviar:', e.message); }
}

// Busca o base64 da mídia diretamente na Evolution API
async function buscarMidiaBase64(messageId, remoteJid) {
  try {
    console.log('Buscando mídia para messageId:', messageId);
    const r = await httpsRequest('POST',
      `${EVOLUTION_URL}/chat/getBase64FromMediaMessage/${INSTANCE}`,
      { message: { key: { id: messageId, remoteJid } } },
      { apikey: EVOLUTION_KEY }
    );
    console.log('Resposta mídia:', JSON.stringify(r).substring(0, 100));
    return r.base64 || r.data?.base64 || null;
  } catch(e) {
    console.error('Erro buscar mídia:', e.message);
    return null;
  }
}

async function analisarImagem(base64, mime) {
  try {
    const result = await httpsRequest('POST',
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data: base64 } },
            { type: 'text', text: 'Você é o assistente financeiro do Di Casa Laranjinha em Patos de Minas MG. Analise este documento e extraia: Tipo (NF/Recibo/Comprovante), Fornecedor/Estabelecimento, Data, Valor total, Forma de pagamento, lista de Itens com valores. Responda de forma organizada em português.' }
          ]
        }]
      },
      { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }
    );
    return result.content?.[0]?.text || 'Não consegui analisar.';
  } catch(e) {
    console.error('Erro Claude:', e.message);
    return `Erro ao analisar: ${e.message}`;
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Webhook v6 ativo ✅', versao: '6.0' }));
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

    try {
      const data = JSON.parse(body);
      const evento = data.event || data.type || '';
      if (evento !== 'messages.upsert') { console.log('Ignorado:', evento); return; }

      let msgs = [];
      if (Array.isArray(data.data)) msgs = data.data;
      else if (data.data?.messages) msgs = data.data.messages;
      else if (data.data) msgs = [data.data];

      for (const msg of msgs) {
        if (msg.key?.fromMe) continue;
        const numero = msg.key?.remoteJid;
        if (!numero) continue;

        const isGrupo = numero.endsWith('@g.us');
        if (!isGrupo) { console.log('Individual ignorado:', numero); continue; }
        if (GRUPO_AUTORIZADO && numero !== GRUPO_AUTORIZADO) { console.log('Grupo não autorizado:', numero); continue; }

        const tipo = msg.messageType || '';
        const messageId = msg.key?.id;
        console.log('Grupo:', numero, '| Tipo:', tipo, '| ID:', messageId);

        if (tipo === 'conversation' || tipo === 'extendedTextMessage') {
          const txt = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
          console.log('Texto:', txt);
          const t = txt.toLowerCase().trim();
          if (t.includes('oi') || t.includes('olá') || t.includes('ola') || t.includes('bom dia') || t.includes('boa')) {
            await enviarWpp(numero, '👋 Olá! Sou o assistente do *Di Casa Laranjinha* 🍕🍖\n\n📸 Mande uma *foto de NF, recibo ou comprovante* que analiso na hora!');
          } else if (t.includes('ajuda') || t.includes('help')) {
            await enviarWpp(numero, '🤖 *Comandos disponíveis:*\n\n📸 *Foto de NF/Recibo* → análise automática\n❓ *ajuda* → este menu\n\n_GestaoERP Di Casa Laranjinha_ ✅');
          } else {
            await enviarWpp(numero, `✅ Recebi sua mensagem!\n\n📸 Para analisar documentos, mande uma *foto de NF ou comprovante*.`);
          }
        }
        else if (tipo === 'imageMessage') {
          await enviarWpp(numero, '🔍 Recebi a imagem! Analisando...');
          
          // Tenta base64 direto na mensagem primeiro
          let base64 = msg.message?.imageMessage?.base64 || msg.message?.base64;
          
          // Se não veio, busca na Evolution API
          if (!base64 && messageId) {
            base64 = await buscarMidiaBase64(messageId, numero);
          }
          
          if (!base64) {
            await enviarWpp(numero, '❌ Não consegui acessar a imagem. Tente reenviar a foto diretamente.');
            continue;
          }
          
          const analise = await analisarImagem(base64, 'image/jpeg');
          await enviarWpp(numero, `📋 *Análise do Documento*\n\n${analise}\n\n_Di Casa Laranjinha_ ✅`);
        }
        else if (tipo === 'documentMessage' || tipo === 'documentWithCaptionMessage') {
          await enviarWpp(numero, '📄 Recebi o documento! Analisando...');
          let base64 = null;
          if (messageId) base64 = await buscarMidiaBase64(messageId, numero);
          if (!base64) { await enviarWpp(numero, '❌ Não consegui acessar o documento. Tente enviar como imagem.'); continue; }
          const analise = await analisarImagem(base64, 'image/jpeg');
          await enviarWpp(numero, `📋 *Análise do Documento*\n\n${analise}\n\n_Di Casa Laranjinha_ ✅`);
        }
        else {
          console.log('Tipo não tratado:', tipo);
        }
      }
    } catch(e) {
      console.error('Erro webhook:', e.message);
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Webhook v6 rodando na porta ${PORT}`);
  console.log(`🔑 API Key: ${ANTHROPIC_KEY ? '✅' : '❌ NÃO CONFIGURADA'}`);
  console.log(`👥 Modo: ${GRUPO_AUTORIZADO ? 'Grupo: ' + GRUPO_AUTORIZADO : 'Qualquer grupo'}`);
});
