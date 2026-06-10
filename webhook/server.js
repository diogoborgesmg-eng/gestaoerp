const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 10000;
const EVOLUTION_URL = 'https://evolution-api-latest-lrlv.onrender.com';
const EVOLUTION_KEY = 'dicasalaranjinha2024';
const INSTANCE = 'dicasalaranjinha';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'diogoborgesmg-eng/gestaoerp';

function httpsRequest(method, url, data, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const body = data ? JSON.stringify(data) : null;
    const opts = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers
      }
    };
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function enviarWpp(numero, texto) {
  try {
    await httpsRequest('POST', EVOLUTION_URL+'/message/sendText/'+INSTANCE,
      { number: numero, text: texto }, { apikey: EVOLUTION_KEY });
  } catch(e) { console.error('Erro enviar:', e.message); }
}

async function buscarMidia(msg) {
  try {
    const r = await httpsRequest('POST',
      EVOLUTION_URL+'/chat/getBase64FromMediaMessage/'+INSTANCE,
      { message: { key: msg.key, messageType: msg.messageType, message: msg.message } },
      { apikey: EVOLUTION_KEY });
    const b64 = r.base64 || r.data;
    if (b64 && b64.length > 100) return b64;
    return null;
  } catch(e) { console.error('Erro midia:', e.message); return null; }
}

async function chamarClaude(messages, maxTokens) {
  const payload = JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens || 800, messages });
  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
        'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }
    };
    const req = https.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
    });
    req.on('error', () => resolve({}));
    req.write(payload);
    req.end();
  });
}

async function salvarNoGitHub(lancamento) {
  if (!GITHUB_TOKEN) { console.error('GITHUB_TOKEN nao configurado'); return; }
  try {
    const fi = await httpsRequest('GET',
      'https://api.github.com/repos/'+GITHUB_REPO+'/contents/bot_lancamentos.json',
      null, {'Authorization': 'token '+GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json'});
    const fd = JSON.parse(Buffer.from(fi.content, 'base64').toString());
    if (!fd.lancamentos) fd.lancamentos = [];
    fd.lancamentos.push({ ...lancamento, id: Date.now().toString(36), criadoEm: new Date().toISOString(), sincronizado: false });
    if (fd.lancamentos.length > 50) fd.lancamentos = fd.lancamentos.slice(-50);
    await httpsRequest('PUT',
      'https://api.github.com/repos/'+GITHUB_REPO+'/contents/bot_lancamentos.json',
      { message: 'bot:'+lancamento.valor, content: Buffer.from(JSON.stringify(fd)).toString('base64'), sha: fi.sha },
      {'Authorization': 'token '+GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json'});
    console.log('GitHub OK:', lancamento.valor, lancamento.categoria);
  } catch(eg) { console.error('GitHub err:', eg.message); }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    res.writeHead(200); res.end(JSON.stringify({ status: 'Webhook v8' })); return;
  }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    res.writeHead(200); res.end('ok');
    if (!body) return;
    try {
      const ev = JSON.parse(body);
      if (!['messages.upsert','message.upsert'].includes(ev.event)) return;
      const msg = ev.data;
      if (!msg?.key?.remoteJid?.includes('@g.us')) return;
      const numero = msg.key.remoteJid;
      const tipo = msg.messageType || Object.keys(msg.message||{})[0] || '';
      console.log('MSG:', tipo);
      if (['imageMessage','documentMessage'].includes(tipo)) {
        await enviarWpp(numero, 'Recebi! Buscando imagem...');
        const b64 = await buscarMidia(msg);
        if (!b64) { await enviarWpp(numero, 'Nao consegui baixar a imagem.'); return; }
        await enviarWpp(numero, 'Analisando...');
        const r1 = await chamarClaude([{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: 'Analise este comprovante. Extraia: valor, destinatario, data, tipo (pix/boleto/cartao/dinheiro), observacao. Responda em portugues.' }
        ]}], 800);
        const analise = r1.content?.[0]?.text || 'Nao consegui extrair.';
        console.log('Analise:', analise.substring(0,100));
        const r2 = await chamarClaude([{ role: 'user', content:
          'Extraia do texto APENAS JSON valido:
"'+analise+'"

{"valor":0.00,"categoria":"Entregador|Folha CLT|Freelancer|Vale|Fornecedor|Aluguel|Energia|Telecom|Outros","tipo":"pix|boleto|dinheiro|cartao","data":"DD/MM/AAAA","descricao":""}
Se sem valor: {"valor":0}'
        }], 200);
        const texto = r2.content?.[0]?.text || '{}';
        const match = texto.match(/\{[\s\S]*\}/);
        let lancamento = null;
        if (match) {
          try {
            const d = JSON.parse(match[0]);
            if (d.valor > 0) {
              lancamento = { valor: d.valor, categoria: d.categoria||'Outros', descricao: d.descricao||'WhatsApp', tipo: d.tipo||'pix', data: d.data||new Date().toLocaleDateString('pt-BR'), origem: 'whatsapp' };
              await salvarNoGitHub(lancamento);
            }
          } catch(ep) { console.error('Parse err:', ep.message); }
        }
        let resp = 'Analise:
'+analise+'

_Di Casa Laranjinha_';
        if (lancamento) resp += '

Lancado! R$ '+lancamento.valor.toFixed(2)+' - '+lancamento.categoria;
        await enviarWpp(numero, resp);
      }
    } catch(e) { console.error('Erro:', e.message); }
  });
});

server.listen(PORT, () => {
  console.log('Webhook v8 porta', PORT);
  console.log('API Key:', ANTHROPIC_KEY ? 'OK' : 'FALTA');
  console.log('GitHub Token:', GITHUB_TOKEN ? 'OK' : 'FALTA');
});
