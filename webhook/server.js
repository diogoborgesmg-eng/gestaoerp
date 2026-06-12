const http = require('http');
const https = require('https');
const PORT = process.env.PORT || 10000;
const EVO = 'https://evolution-api-latest-lrlv.onrender.com';
const EVO_KEY = 'dicasalaranjinha2024';
const INST = 'dicasalaranjinha';
const AKEY = process.env.ANTHROPIC_API_KEY;
const GHTOKEN = process.env.GITHUB_TOKEN;
const REPO = 'diogoborgesmg-eng/gestaoerp';

function req2(method, url, data, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = data ? JSON.stringify(data) : null;
    const opts = { hostname: u.hostname, path: u.pathname + u.search, method,
      headers: { 'Content-Type': 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}), ...headers } };
    const r = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function wpp(numero, texto) {
  try { await req2('POST', EVO+'/message/sendText/'+INST, { number: numero, text: texto }, { apikey: EVO_KEY }); }
  catch(e) { console.error('wpp err:', e.message); }
}

async function getMidia(msg) {
  try {
    const r = await req2('POST', EVO+'/chat/getBase64FromMediaMessage/'+INST,
      { message: { key: msg.key, messageType: msg.messageType, message: msg.message } },
      { apikey: EVO_KEY });
    const b64 = r.base64 || r.data;
    return (b64 && b64.length > 100) ? b64 : null;
  } catch(e) { console.error('midia err:', e.message); return null; }
}

async function claude(messages, maxTok) {
  const payload = JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTok || 800, messages });
  return new Promise((resolve) => {
    const opts = { hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
        'x-api-key': AKEY, 'anthropic-version': '2023-06-01' } };
    const r = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
    });
    r.on('error', () => resolve({}));
    r.write(payload);
    r.end();
  });
}

async function salvarGitHub(lanc) {
  console.log('GHTOKEN presente:', !!GHTOKEN);
  if (!GHTOKEN) { console.error('GITHUB_TOKEN faltando no Render'); return; }
  try {
    const fi = await req2('GET',
      'https://api.github.com/repos/'+REPO+'/contents/bot_lancamentos.json',
      null, { 'Authorization': 'token '+GHTOKEN, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'GestaoERP-Bot/1.0' });
    console.log('GitHub resposta:', JSON.stringify(fi).substring(0,200));
    if (!fi.content) { console.error('fi.content undefined! Resposta:', JSON.stringify(fi).substring(0,200)); return; }
    const fd = JSON.parse(Buffer.from(fi.content, 'base64').toString());
    if (!fd.lancamentos) fd.lancamentos = [];
    fd.lancamentos.push({ id: Date.now().toString(36), ...lanc, setor: lanc.setor||'Geral',
      criadoEm: new Date().toISOString(), sincronizado: false });
    if (fd.lancamentos.length > 50) fd.lancamentos = fd.lancamentos.slice(-50);
    await req2('PUT',
      'https://api.github.com/repos/'+REPO+'/contents/bot_lancamentos.json',
      { message: 'bot:'+lanc.valor, content: Buffer.from(JSON.stringify(fd)).toString('base64'), sha: fi.sha },
      { 'Authorization': 'token '+GHTOKEN, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'GestaoERP-Bot/1.0' });
    console.log('GitHub OK:', lanc.valor, lanc.categoria);
  } catch(eg) {
    console.error('GitHub err:', eg.message);
    if (eg.message && eg.message.includes('401')) console.error('Token invalido! Verifique GITHUB_TOKEN no Render');
    if (eg.message && eg.message.includes('404')) console.error('Arquivo bot_lancamentos.json nao encontrado!');
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(200); res.end(JSON.stringify({status:'ok v8'})); return; }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    res.writeHead(200); res.end('ok');
    if (!body) return;
    try {
      const ev = JSON.parse(body);
      if (!['messages.upsert','message.upsert'].includes(ev.event)) return;
      const msg = ev.data;
      if (!msg || !msg.key || !msg.key.remoteJid || !msg.key.remoteJid.includes('@g.us')) return;
      const num = msg.key.remoteJid;
      const tipo = msg.messageType || Object.keys(msg.message||{})[0] || '';
      console.log('MSG:', tipo);
      if (['imageMessage','documentMessage'].includes(tipo)) {
        await wpp(num, 'Recebi! Buscando imagem...');
        const b64 = await getMidia(msg);
        if (!b64) { await wpp(num, 'Nao consegui baixar.'); return; }
        await wpp(num, 'Analisando...');
        const r1 = await claude([{ role:'user', content:[
          { type:'image', source:{ type:'base64', media_type:'image/jpeg', data:b64 } },
          { type:'text', text:'Leia este comprovante de pagamento. Retorne APENAS JSON valido sem texto adicional.\n\nTAREFA: Este recibo e de um pagamento feito pela empresa Di Casa Gastronomia. Liste TODOS os nomes de pessoas ou empresas que aparecem neste comprovante. O nome de Di Casa Gastronomia ou Di Casa Laranjinha e o PAGADOR — ignore esse. O OUTRO nome que aparecer e quem recebeu o pagamento.\n\nSe so aparecer Di Casa Gastronomia no recibo, procure: nome do destinatario, favorecido, beneficiario, para, recebedor, nome da conta destino — qualquer campo que nao seja o pagador.\n\nRetorne APENAS:\n{"valor":0.00,"descricao":"nome de quem RECEBEU (nao Di Casa)","categoria":"👥 RH / Mão de Obra (diaria/salario/freelancer) | 🥩 Matéria Prima | 🔧 Manutenção | 💡 Energia/Utilidades | 🚚 Frete/Entregador | 🏢 Aluguel/Fixos | 📦 Embalagem | 🍺 Bebidas/Bar | 🧹 Limpeza | 💳 Taxas/Impostos | 📱 Telecom | 🎤 Shows/Eventos | 📣 Marketing | ⚠️ Extravio | 🔄 Outros","tipo":"pix","data":"DD/MM/YYYY","setor":"Restaurante|Pizzaria|Espetaria|Hamburgueria|Geral"}' }
        ]}], 500);
        const texto1 = r1.content && r1.content[0] ? r1.content[0].text : '{}';
        const analise = texto1;
        console.log('Analise:', analise.substring(0,150));
        // Extrai JSON direto da resposta
        const jsonMatch = texto1.match(/\{[\s\S]*\}/);
        const texto2 = jsonMatch ? jsonMatch[0] : '{}';
        const texto2final = texto2;


