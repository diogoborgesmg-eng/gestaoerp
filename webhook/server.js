const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 10000;
const EVOLUTION_URL = 'https://evolution-api-latest-lrlv.onrender.com';
const EVOLUTION_KEY = 'dicasalaranjinha2024';
const INSTANCE = 'dicasalaranjinha';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ✅ SÓ responde em grupos — número do grupo vai aqui após criar
// Deixe vazio para responder em QUALQUER grupo, ou coloque o ID do grupo específico
// Ex: '120363XXXXXXXXXX@g.us'
const GRUPO_AUTORIZADO = process.env.GRUPO_ID || '';

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

async function responderTexto(numero, txt) {
  const t = txt.toLowerCase().trim();
  if (t.includes('oi') || t.includes('olá') || t.includes('ola') || t.includes('bom dia') || t.includes('boa tarde') || t.includes('boa noite')) {
    await enviarWpp(numero, '👋 Olá! Sou o assistente do *Di Casa Laranjinha* 🍕🍖\n\n📸 Mande uma *foto de nota fiscal, recibo ou comprovante* que analiso na hora!\n\n💡 Comandos:\n• *nota* — lançar NF\n• *ajuda* — ver comandos');
  } else if (t.includes('nota') || t.includes('nf') || t.includes('fiscal')) {
    await enviarWpp(numero, '📄 Mande a foto da *Nota Fiscal* que extraio os dados automaticamente!');
  } else if (t.includes('ajuda') || t.includes('help') || t.includes('comando')) {
    await enviarWpp(numero, '🤖 *Comandos do Bot Di Casa Laranjinha*\n\n📸 *Foto de NF/Recibo* — análise automática\n📊 *nota* — lançar nota fiscal\n❓ *ajuda* — este menu\n\n_Powered by GestaoERP_ ✅');
  } else {
    await enviarWpp(numero, `✅ Recebi: "${txt}"\n\n📸 Para analisar documentos, mande uma foto de NF ou comprovante!`);
  }
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  console.log(`>>> ${req.method} ${req.url}`);

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'Webhook v5 ativo ✅', versao: '5.0' }));
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

      if (evento !== 'messages.upsert') {
        console.log('Ignorado:', evento);
        return;
      }

      let msgs = [];
      if (Array.isArray(data.data)) msgs = data.data;
      else if (data.data?.messages) msgs = data.data.messages;
      else if (data.data) msgs = [data.data];

      for (const msg of msgs) {
        if (msg.key?.fromMe) continue;

        const numero = msg.key?.remoteJid;
        if (!numero) continue;

        const isGrupo = numero.endsWith('@g.us');

        // ✅ SÓ processa mensagens de GRUPO
        if (!isGrupo) {
          console.log('Mensagem individual ignorada de:', numero);
          continue;
        }

        // Se GRUPO_AUTORIZADO definido, só responde nesse grupo específico
        if (GRUPO_AUTORIZADO && numero !== GRUPO_AUTORIZADO) {
          console.log('Grupo não autorizado:', numero);
          continue;
        }

        const tipo = msg.messageType || '';
        console.log('Grupo:', numero, '| Tipo:', tipo);

        if (tipo === 'conversation' || tipo === 'extendedTextMessage') {
          const txt = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
          console.log('Texto no grupo:', txt);
          // No grupo responde qualquer mensagem
          await responderTexto(numero, txt);
        }
        else if (tipo === 'imageMessage') {
          await enviarWpp(numero, '🔍 Analisando documento...');
          const base64 = msg.message?.imageMessage?.base64 || msg.message?.base64;
          if (!base64) { await enviarWpp(numero, '❌ Imagem não acessível. Tente reenviar.'); continue; }
          const analise = await analisarImagem(base64, 'image/jpeg');
          await enviarWpp(numero, `📋 *Análise do Documento*\n\n${analise}\n\n_Di Casa Laranjinha_ ✅`);
        } else {
          console.log('Tipo não tratado:', tipo);
        }
      }
    } catch(e) {
      console.error('Erro webhook:', e.message);
    }
  });
});

server.listen(PORT, () => {
  console.log(`✅ Webhook v5 rodando na porta ${PORT}`);
  console.log(`🔑 API Key: ${ANTHROPIC_KEY ? '✅' : '❌ NÃO CONFIGURADA'}`);
  console.log(`👥 Modo: ${GRUPO_AUTORIZADO ? 'Grupo específico: ' + GRUPO_AUTORIZADO : 'Qualquer grupo'}`);
});
