
// ═══════════════════════════════════════════════════════════════
// MÓDULO SEFAZ — NFeDistribuicaoDFe (consulta NFs recebidas)
// ═══════════════════════════════════════════════════════════════
let _forge = null;
function getForge(){ if(!_forge)_forge=require('node-forge'); return _forge; }

function carregarCertPFX(pfxBase64, senha){
  const forge=getForge();
  const pfxDer=forge.util.decode64(pfxBase64);
  const pfxAsn1=forge.asn1.fromDer(pfxDer);
  const pfx=forge.pkcs12.pkcs12FromAsn1(pfxAsn1,senha);
  let cert=null,key=null;
  for(const sc of pfx.safeContents)for(const sb of sc.safeBags){
    if(sb.type===forge.pki.oids.certBag)cert=sb.cert;
    else if(sb.type===forge.pki.oids.pkcs8ShroudedKeyBag||sb.type===forge.pki.oids.keyBag)key=sb.key;
  }
  if(!cert||!key)throw new Error('Certificado ou chave nao encontrados no .pfx');
  return{certPem:forge.pki.certificateToPem(cert),keyPem:forge.pki.privateKeyToPem(key)};
}


// Consulta NF-e pelo chave diretamente (retorna procNFe completo)
async function consultarNFeByChave(pfxBase64, senha, cnpj, chNFe, ambiente) {
  const forge = getForge();
  const pfxDer = forge.util.decode64(pfxBase64);
  const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(pfxDer), senha);
  let cert = null, key = null;
  p12.safeContents.forEach(sc => sc.safeBags.forEach(bag => {
    if (bag.type === forge.pki.oids.pkcs8ShroudedKeyBag || bag.type === forge.pki.oids.keyBag) key = bag.key;
    if (bag.type === forge.pki.oids.certBag) cert = bag.cert;
  }));
  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(key);
  const cUF = '31'; // MG
  const tpAmb = ambiente === 'prod' ? '1' : '2';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">
<distDFeInt versao="1.01" xmlns="http://www.portalfiscal.inf.br/nfe">
<tpAmb>${tpAmb}</tpAmb>
<cUFAutor>${cUF}</cUFAutor>
<CNPJ>${cnpj}</CNPJ>
<consChNFe>
<chNFe>${chNFe}</chNFe>
</consChNFe>
</distDFeInt>
</nfeDadosMsg>`;

  const soapEnv = `<?xml version="1.0" encoding="UTF-8"?>
<soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
<soap12:Body>${xml}</soap12:Body>
</soap12:Envelope>`;

  const url = 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx';
  const https = require('https');
  const tls = require('tls');
  const ctx = tls.createSecureContext({ cert: certPem, key: keyPem });

  return new Promise((resolve, reject) => {
    const body = Buffer.from(soapEnv, 'utf8');
    const opts = {
      hostname: 'www1.nfe.fazenda.gov.br',
      path: '/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
      method: 'POST',
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8',
        'Content-Length': body.length,
        'SOAPAction': 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse'
      },
      secureContext: ctx
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ xml: data, status: res.statusCode }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sefazDistribuicaoDFe(pfxBase64, senha, cnpj, ultNSU='000000000000000', ambiente='prod'){
  const{certPem,keyPem}=carregarCertPFX(pfxBase64,senha);
  const cnpjLimpo=cnpj.replace(/[^\d]/g,'');
  const xmlBody=`<distDFeInt versao="1.01" xmlns="http://www.portalfiscal.inf.br/nfe"><tpAmb>${ambiente==='prod'?'1':'2'}</tpAmb><cUFAutor>31</cUFAutor><CNPJ>${cnpjLimpo}</CNPJ><distNSU><ultNSU>${ultNSU}</ultNSU></distNSU></distDFeInt>`;
  const soapEnv=`<?xml version="1.0" encoding="UTF-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDadosMsg>${xmlBody}</nfeDadosMsg></nfeDistDFeInteresse></soap12:Body></soap12:Envelope>`;
  const url=ambiente==='prod'?'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx':'https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx';
  const u=new URL(url);
  const forge=getForge();
  const certDer=forge.util.decode64(forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(certPem))).getBytes()));
  return new Promise((resolve,reject)=>{
    const body=Buffer.from(soapEnv,'utf8');
    const opts={hostname:u.hostname,path:u.pathname,method:'POST',
      headers:{'Content-Type':'application/soap+xml; charset=utf-8; action="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse"','Content-Length':body.length},
      cert:certPem,key:keyPem,rejectUnauthorized:false};
    const r=https.request(opts,res=>{
      let d='';res.on('data',c=>d+=c);
      res.on('end',()=>resolve({status:res.statusCode,xml:d}));
    });
    r.on('error',reject);r.write(body);r.end();
  });
}

function parsearNFesDoXML(xmlResp){
  // Extrai os documentos fiscais (NF-e XML) da resposta da SEFAZ
  const nfes=[];
  const matches=xmlResp.matchAll(/<chNFe>(\d{44})<\/chNFe>[\s\S]*?<NSU>(\d+)<\/NSU>/g);
  for(const m of matches)nfes.push({chave:m[1],nsu:m[2]});
  return nfes;
}

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

async function wppDocumento(numero, base64Pdf, nomeArquivo, legenda) {
  try {
    await req2('POST', EVO+'/message/sendMedia/'+INST, {
      number: numero, mediatype: 'document', mimetype: 'application/pdf',
      caption: legenda||'', media: base64Pdf, fileName: nomeArquivo
    }, { apikey: EVO_KEY });
  } catch(e) { console.error('wppDocumento err:', e.message); }
}

const { gerarPdfFechamento } = require('./pdf.js');


async function salvarReciboGitHub(b64, tipo, data) {
  try {
    const ext = tipo === 'documentMessage' ? 'pdf' : 'jpg';
    const ts = new Date().toISOString().replace(/[:.]/g,'-').substring(0,19);
    const nome = `recibos/${ts}.${ext}`;
    const mediaType = ext === 'pdf' ? 'application/pdf' : 'image/jpeg';
    
    // Verifica se arquivo já existe
    let sha = null;
    try {
      const check = await req2('GET',
        'https://api.github.com/repos/'+REPO+'/contents/'+nome,
        null, {'Authorization':'token '+GHTOKEN,'Accept':'application/vnd.github.v3+json'});
      if(check && check.sha) sha = check.sha;
    } catch(e) {}

    const body = { message: 'recibo: '+ts, content: b64 };
    if(sha) body.sha = sha;

    const putResp = await req2('PUT',
      'https://api.github.com/repos/'+REPO+'/contents/'+nome,
      body,
      {'Authorization':'token '+GHTOKEN,'Accept':'application/vnd.github.v3+json','User-Agent':'GestaoERP-Bot/1.0'});

    if(!putResp || !putResp.commit) {
      console.error('Recibo PUT falhou:', JSON.stringify(putResp).substring(0,200));
      return null;
    }
    console.log('Recibo salvo OK:', nome);
    return 'https://raw.githubusercontent.com/'+REPO+'/main/'+nome;
  } catch(e) {
    console.error('Erro ao salvar recibo:', e.message);
    return null;
  }
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
  const payload = JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTok || 800, messages });
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

function _chaveDuplicado(l) {
  const dest = (l.destinatario||'').toLowerCase().trim().replace(/\s+/g,' ');
  const valor = Number(l.valor||0).toFixed(2);
  const data = (l.data||'').trim();
  const hora = (l.hora||'').trim();
  return dest+'|'+valor+'|'+data+'|'+hora;
}
async function salvarGitHubBatch(lancamentos, reciboUrl) {
  if (!GHTOKEN) { console.error('GITHUB_TOKEN faltando no Render'); return { salvos:0, ignorados:0 }; }
  if (!lancamentos || !lancamentos.length) return { salvos:0, ignorados:0 };
  try {
    const fi = await req2('GET',
      'https://api.github.com/repos/'+REPO+'/contents/bot_lancamentos.json?ref=dados',
      null, { 'Authorization': 'token '+GHTOKEN, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'GestaoERP-Bot/1.0' });
    if (!fi.content) { console.error('fi.content undefined!'); return { salvos:0, ignorados:0 }; }
    const fd = JSON.parse(Buffer.from(fi.content, 'base64').toString());
    if (!fd.lancamentos) fd.lancamentos = [];

    // Evita duplicado: mesmo destinatario + mesmo valor ja existente -> ignora
    const chavesExistentes = new Set(fd.lancamentos.map(_chaveDuplicado));
    let ignorados = 0;
    const novosUnicos = [];
    lancamentos.forEach((lanc) => {
      const chave = _chaveDuplicado(lanc);
      if (chavesExistentes.has(chave)) { ignorados++; return; }
      chavesExistentes.add(chave); // evita duplicado tambem DENTRO do mesmo lote
      novosUnicos.push(lanc);
    });

    novosUnicos.forEach((lanc, idx) => {
      fd.lancamentos.push({ id: Date.now().toString(36)+'_'+idx, ...lanc, tipo_lancamento: 'custo', setor: lanc.setor||'Geral', reciboUrl: reciboUrl||null,
        criadoEm: new Date().toISOString(), sincronizado: false });
    });
    if (fd.lancamentos.length > 200) fd.lancamentos = fd.lancamentos.slice(-200);
    if (!novosUnicos.length) return { salvos:0, ignorados };
    await req2('PUT',
      'https://api.github.com/repos/'+REPO+'/contents/bot_lancamentos.json?ref=dados',
      { message: 'bot:lote:'+novosUnicos.length, content: Buffer.from(JSON.stringify(fd)).toString('base64'), sha: fi.sha, branch: 'dados' },
      { 'Authorization': 'token '+GHTOKEN, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'GestaoERP-Bot/1.0' });
    console.log('GitHub OK -', novosUnicos.length, 'salvos,', ignorados, 'ignorados (duplicado)');
    // Também grava no Supabase lancamentos para o PDF das 6h e relatórios automáticos
    const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
    const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
    for (const lanc of novosUnicos) {
      const idLanc = lanc.id || ('bot_'+lanc.destinatario+'_'+lanc.valor+'_'+(lanc.dia||'').replace(/\//g,'')).replace(/\s/g,'_').slice(0,60);
      const tipo = Number(lanc.valor||0) > 0 ? 'custo' : 'receita';
      const dia = lanc.dia || new Date().toLocaleDateString('pt-BR');
      await req2('POST', SB_URL+'/rest/v1/lancamentos',
        { id: idLanc, tipo, dia_comercial: dia,
          descricao: lanc.destinatario || lanc.desc || 'Lançamento bot',
          categoria: lanc.categoria || '🔄 Outros',
          segmento: lanc.segmento || null,
          valor: Math.abs(Number(lanc.valor||0)),
          device_id: 'bot_whatsapp' },
        { 'apikey': SB_KEY, 'Prefer': 'return=minimal,resolution=ignore-duplicates', 'Content-Type': 'application/json' }
      ).catch(e => console.log('Bot Supabase err:', e.message));
    }
    if (novosUnicos.length) console.log('Bot: '+novosUnicos.length+' lancamentos gravados no Supabase');
    return { salvos: novosUnicos.length, ignorados };
  } catch(eg) {
    console.error('GitHub batch err:', eg.message);
    return { salvos:0, ignorados:0, erro:eg.message };
  }
}

async function salvarGitHub(lanc, reciboUrl) {
  console.log('GHTOKEN presente:', !!GHTOKEN);
  if (!GHTOKEN) { console.error('GITHUB_TOKEN faltando no Render'); return; }
  try {
    const fi = await req2('GET',
      'https://api.github.com/repos/'+REPO+'/contents/bot_lancamentos.json?ref=dados',
      null, { 'Authorization': 'token '+GHTOKEN, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'GestaoERP-Bot/1.0' });
    console.log('GitHub resposta:', JSON.stringify(fi).substring(0,200));
    if (!fi.content) { console.error('fi.content undefined! Resposta:', JSON.stringify(fi).substring(0,200)); return; }
    const fd = JSON.parse(Buffer.from(fi.content, 'base64').toString());
    if (!fd.lancamentos) fd.lancamentos = [];
    // Bot registra SEMPRE custos (pagamentos feitos pela Di Casa)
    // ID unico e consistente - mesmo ID no blob e na tabela (evita duplicata no Forcar Envio)
    const _lancId = Date.now().toString(36)+'b'+Math.random().toString(36).slice(2,5);
    fd.lancamentos.push({ id: _lancId, ...lanc, tipo_lancamento: 'custo', setor: lanc.setor||'Geral', reciboUrl: reciboUrl||null,
      criadoEm: new Date().toISOString(), sincronizado: false });
    if (fd.lancamentos.length > 200) fd.lancamentos = fd.lancamentos.slice(-200);
    // Grava na tabela lancamentos com MESMO ID do blob - Forcar Envio vai ignorar duplicata
    const SB_URL_BOT = 'https://bxppiwshjyddiieazoqx.supabase.co';
    const SB_KEY_BOT = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
    req2('POST', SB_URL_BOT+'/rest/v1/lancamentos',
      { id: _lancId, tipo: 'custo', dia_comercial: lanc.data||new Date().toLocaleDateString('pt-BR'),
        descricao: lanc.desc||lanc.destinatario||lanc.fornecedor||'Pagamento', categoria: lanc.categoria||'Outros',
        segmento: lanc.setor||null, valor: Number(lanc.valor||0), device_id: 'bot_whatsapp' },
      { 'apikey': SB_KEY_BOT, 'Prefer': 'return=minimal,resolution=ignore-duplicates', 'Content-Type': 'application/json' }
    ).catch(e => console.log('Erro gravar lancamento tabela:', e.message));
    await req2('PUT',
      'https://api.github.com/repos/'+REPO+'/contents/bot_lancamentos.json?ref=dados',
      { message: 'bot:'+lanc.valor, content: Buffer.from(JSON.stringify(fd)).toString('base64'), sha: fi.sha, branch: 'dados' },
      { 'Authorization': 'token '+GHTOKEN, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'GestaoERP-Bot/1.0' });
    console.log('GitHub OK:', lanc.valor, lanc.categoria);
  } catch(eg) {
    console.error('GitHub err:', eg.message);
    if (eg.message && eg.message.includes('401')) console.error('Token invalido! Verifique GITHUB_TOKEN no Render');
    if (eg.message && eg.message.includes('404')) console.error('Arquivo bot_lancamentos.json nao encontrado!');
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET') {
    if (req.url === '/pluggy-connect') {
      (async () => {
        try {
          // Gera connect token usando fetch nativo
          // Tenta os dois formatos do endpoint
          let ct = await pluggyAuthFetch('POST', '/connect_token', { clientUserId: 'dicasalaranjinha' });
          if (!ct.accessToken && !ct.token && !ct.connectToken) {
            ct = await pluggyAuthFetch('POST', '/connect-token', { clientUserId: 'dicasalaranjinha' });
          }
          console.log('Connect token response:', JSON.stringify(ct).substring(0,300));
          const connectToken = ct.accessToken || ct.token || ct.connectToken || ct.access_token || '';
          console.log('Connect token campos:', Object.keys(ct||{}).join(','), 'token len:', connectToken.length);
          if (!connectToken) {
            res.writeHead(200,{'Content-Type':'text/plain'});
            res.end('Erro ao gerar connect token. Resposta: '+JSON.stringify(ct));
            return;
          }
          const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conectar Bancos — Di Casa Laranjinha</title>
</head>
<body style="background:#0a0a0f;color:#fff;font-family:sans-serif;padding:20px;box-sizing:border-box;">
<div style="max-width:400px;margin:40px auto;text-align:center;">
<p style="font-size:40px;">🏦</p>
<h2>Conectar Banco</h2>
<p style="color:#888;font-size:13px;margin-bottom:24px;">Di Casa Laranjinha — Open Finance</p>
<button onclick="abrirWidget()" id="btn"
  style="padding:14px 32px;border-radius:10px;border:none;background:#0066ff;color:#fff;font-size:15px;font-weight:700;cursor:pointer;width:100%;">
  🔗 Conectar conta bancária
</button>
<p id="status" style="margin-top:16px;color:#888;font-size:13px;"></p>
</div>
<script src="https://cdn.pluggy.ai/pluggy-connect/latest/pluggy-connect.js"></script>
<script>
var TOKEN = "${connectToken}";
function abrirWidget(){
  document.getElementById("status").textContent = "Abrindo widget...";
  try {
    var p = new PluggyConnect({
      connectToken: TOKEN,
      onSuccess: function(d){
        var itemId = d && d.item && d.item.id ? d.item.id : '';
        document.getElementById("status").textContent = "✅ Conectado! Salvando item ID...";
        if (itemId) {
          fetch('/pluggy-save-item', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({itemId: itemId})
          }).then(function(r){ return r.json(); }).then(function(r){
            document.getElementById("status").textContent = r.ok
              ? "✅ Banco " + itemId.slice(0,8) + "... conectado com sucesso! Clique para conectar outro banco."
              : "⚠️ Banco conectado mas erro ao salvar: " + r.erro;
          });
        }
        document.getElementById("btn").textContent = "✅ Conectado!";
        document.getElementById("btn").style.background = "#00cc66";
        setTimeout(function(){ document.getElementById("btn").textContent = "🔗 Conectar outro banco"; document.getElementById("btn").style.background="#0066ff"; }, 3000);
      },
      onError: function(e){
        document.getElementById("status").textContent = "❌ " + (e.message || JSON.stringify(e));
      },
      onClose: function(){
        document.getElementById("status").textContent = "Fechado. Clique para conectar outro banco.";
      }
    });
    p.init();
  } catch(e) {
    document.getElementById("status").textContent = "Erro: " + e.message;
  }
}
</script>
</body></html>`;
          res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
          res.end(html);
        } catch(e) {
          res.writeHead(200, {'Content-Type':'text/plain'});
          res.end('Erro: '+e.message);
        }
      })();
      return;
    }
    if (req.url === '/limpar-pluggy-duplicados') {
      (async () => {
        try {
          const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
          const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
          const rows = await req2('GET', SB_URL+'/rest/v1/erp_sync?select=data,device_id&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY});
          const d = JSON.parse(rows[0].data);
          const deviceId = rows[0].device_id;
          const ids = d.pluggyItemIds || [];
          
          // Para cada item, busca as contas e guarda o set de account IDs
          const contasVistas = new Set();
          const idsUnicos = [];
          for (const itemId of ids) {
            const contas = await pluggyAuthFetch('GET', '/accounts?itemId='+itemId).catch(()=>({}));
            if (!contas||!contas.results||!contas.results.length) continue;
            // Verifica se alguma conta deste item já foi vista
            const contasNovas = contas.results.filter(ct=>!contasVistas.has(ct.id));
            if (contasNovas.length > 0) {
              idsUnicos.push(itemId);
              contas.results.forEach(ct=>contasVistas.add(ct.id));
            }
          }
          
          d.pluggyItemIds = idsUnicos;
          await req2('POST', SB_URL+'/rest/v1/erp_sync',
            {device_id:deviceId, data:JSON.stringify(d)},
            {'apikey':SB_KEY, 'Prefer':'resolution=merge-duplicates', 'Content-Type':'application/json'});
          
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:true, antes:ids.length, depois:idsUnicos.length, idsUnicos}));
        } catch(e) {
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false, erro:e.message}));
        }
      })();
      return;
    }
    if (req.url === '/test-ifood-auth') {
      ifoodAuth().then(tok=>{
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true, tokenPreview:tok.slice(0,30)+'...'}));
      }).catch(e=>{
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false,erro:e.message}));
      });
      return;
    }
    if (req.url === '/test-dda') {
      processarDDA().then(r=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(r));}).catch(e=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,erro:e.message}));});
      return;
    }
    if (req.url === '/debug-lancamentos') {
      (async () => {
        try {
          const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
          const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
          const rows = await req2('GET', SB_URL+'/rest/v1/lancamentos?select=tipo,dia_comercial,valor,device_id,descricao&order=dia_comercial.desc&limit=30', null, {'apikey':SB_KEY});
          const total = Array.isArray(rows) ? rows.length : 0;
          // Agrupa por dia
          const porDia = {};
          if (Array.isArray(rows)) rows.forEach(r => {
            const d = r.dia_comercial || '?';
            if (!porDia[d]) porDia[d] = {receitas:0, custos:0, total_rec:0, total_cus:0};
            if (r.tipo === 'receita') { porDia[d].receitas++; porDia[d].total_rec += Number(r.valor||0); }
            else { porDia[d].custos++; porDia[d].total_cus += Number(r.valor||0); }
          });
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({total, porDia, amostra:(rows||[]).slice(0,10)}, null, 2));
        } catch(e) {
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false, erro:e.message}));
        }
      })();
      return;
    }
    if (req.url === '/test-pluggy-info') {
      diagnosticoPluggy().then(r=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(r,null,2));}).catch(e=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,erro:e.message}));});
      return;
    }
    if (req.url === '/test-conciliacao') {
      conciliarPluggy().then(r=>{
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify(r));
      }).catch(e=>{
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false,erro:e.message}));
      });
      return;
    }
    if (req.url === '/reprocessar-nfs-sefaz') {
      (async () => {
        try {
          const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
          const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';

          // Busca todas as NFs do SEFAZ na tabela lancamentos
          const nfsTable = await req2('GET',
            SB_URL+'/rest/v1/lancamentos?device_id=eq.sefaz_auto&select=id,descricao,valor,dia_comercial&limit=500',
            null, {'apikey':SB_KEY});
          if (!Array.isArray(nfsTable)||!nfsTable.length) {
            res.writeHead(200,{'Content-Type':'application/json'});
            res.end(JSON.stringify({ok:false,erro:'Nenhuma NF encontrada na tabela'}));
            return;
          }

          // Carrega blob atual
          const blobRows = await req2('GET', SB_URL+'/rest/v1/erp_sync?select=data,device_id&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY});
          const d = Array.isArray(blobRows)&&blobRows.length ? JSON.parse(blobRows[0].data) : {};
          const deviceId = Array.isArray(blobRows)&&blobRows.length ? blobRows[0].device_id : 'sefaz_auto';
          if (!d.contasPagar) d.contasPagar = [];

          // Carrega certificado para consChNFe
          const cert = d.dadosFiscais && d.dadosFiscais.certificado ? d.dadosFiscais.certificado : null;

          let criadas=0, jaExistia=0, comXML=0;
          const resultados = [];

          for (const lanc of nfsTable) {
            // Extrai chNFe do ID (formato: nf_CHAVE44DIGITOS)
            const chNFe = lanc.id.startsWith('nf_') ? lanc.id.slice(3) : null;
            const idCP = 'sefaz_cp_' + (chNFe || lanc.id);

            // Verifica se já existe conta a pagar
            if (d.contasPagar.find(cp=>cp.id===idCP)) {
              jaExistia++;
              continue;
            }

            // Extrai emitente da descrição (formato: "NF 001234 - RIBERFOODS")
            const emitente = lanc.descricao ? lanc.descricao.replace(/^NF \d+ - /, '').trim() : 'Fornecedor';
            const valor = Number(lanc.valor||0);
            const dia = lanc.dia_comercial || new Date().toLocaleDateString('pt-BR');

            // Estima vencimento 30 dias após emissão
            const pts = dia.split('/');
            let venc = dia;
            if (pts.length===3) {
              const base = new Date(Number(pts[2]), Number(pts[1])-1, parseInt(pts[0])+30);
              venc = base.toLocaleDateString('pt-BR');
            }

            // Tenta buscar XML completo se tiver certificado
            let itensXML = [];
            if (chNFe && cert && cert.pfxBase64 && chNFe.length===44) {
              try {
                console.log('Buscando XML:', emitente, chNFe.slice(0,10));
                const proc = await consultarNFeByChave(cert.pfxBase64, cert.senha, '44686412000100', chNFe, 'prod');
                const nfesCompletas = parsearDocZips(proc.xml);
                for (const nfeC of nfesCompletas) {
                  if (nfeC.vencimento) venc = nfeC.vencimento;
                  if (nfeC.itens && nfeC.itens.length) {
                    itensXML = nfeC.itens;
                    await lancarEstoqueNFeSefaz(nfeC, nfeC, SB_URL, SB_KEY).catch(()=>{});
                    comXML++;
                  }
                }
              } catch(eXML) { console.log('XML err:', emitente, eXML.message); }
              await new Promise(r=>setTimeout(r,1000)); // 1s entre consultas
            }

            // Cria conta a pagar
            d.contasPagar.push({
              id: idCP, forn: emitente, val: valor, venc, pago: false,
              cat: '🥩 Matéria Prima', _sefaz: true, _estimado: !comXML,
              chNFe: chNFe, criadoEm: new Date().toISOString()
            });
            criadas++;
            resultados.push({emitente, valor, venc, temXML: itensXML.length>0});
          }

          // Salva blob
          if (criadas > 0) {
            await req2('POST', SB_URL+'/rest/v1/erp_sync',
              {device_id:deviceId, data:JSON.stringify(d)},
              {'apikey':SB_KEY,'Prefer':'resolution=merge-duplicates','Content-Type':'application/json'});
          }

          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:true, totalNFs:nfsTable.length, criadas, jaExistia, comXML, resultados},null,2));
        } catch(e) {
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false,erro:e.message}));
        }
      })();
      return;
    }
    if (req.url === '/pluggy-force-sync') {
      (async () => {
        try {
          const SB2='https://bxppiwshjyddiieazoqx.supabase.co';
          const SK2='sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
          const rows=await req2('GET',SB2+'/rest/v1/erp_sync?select=data&order=updated_at.desc&limit=1',null,{'apikey':SK2});
          const d=Array.isArray(rows)&&rows.length?JSON.parse(rows[0].data):{};
          const ids=d.pluggyItemIds||[];
          const resultados=[];
          // Sincroniza apenas Caixa e Santander (bancos com cheque)
          const idsCheque = ids.filter(id =>
            id.startsWith('4303859e') || id.startsWith('ab725403')
          );
          const idsParaSync = idsCheque.length ? idsCheque : ids.slice(0,2);
          for(const id of idsParaSync){
            const r=await pluggyAuthFetch('POST','/items/'+id+'/update',{}).catch(e=>({erro:e.message}));
            console.log('Pluggy force sync item:',id.slice(0,8),r.status||r.erro||'ok');
            resultados.push({id:id.slice(0,8), resultado:r.status||r.erro||'enviado'});
          }
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:true, itens:ids.length, resultados, aviso:'Aguarde 5-10min para sincronizacao completar'}));
        } catch(e){
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false,erro:e.message}));
        }
      })();
      return;
    }
    if (req.url === '/test-transacoes') {
      (async () => {
        try {
          const SB2 = 'https://bxppiwshjyddiieazoqx.supabase.co';
          const SK2 = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
          const rows2 = await req2('GET', SB2+'/rest/v1/erp_sync?select=data&order=updated_at.desc&limit=1', null, {'apikey':SK2});
          const d2 = Array.isArray(rows2)&&rows2.length ? JSON.parse(rows2[0].data) : {};
          const ids2 = d2.pluggyItemIds || [];
          const dataInicio = new Date(); dataInicio.setDate(dataInicio.getDate()-7);
          const fmtDate2 = d => d.toISOString().slice(0,10);
          const todasTx = [];
          for (const itemId of ids2) {
            const contas2 = await pluggyGet('/accounts?itemId='+itemId);
            if (!contas2||!contas2.results) continue;
            for (const conta2 of contas2.results) {
              if ((conta2.type||'').toUpperCase()==='CREDIT') continue;
              const txs = await pluggyGet('/transactions?accountId='+conta2.id+'&from='+fmtDate2(dataInicio)+'&to='+fmtDate2(new Date())+'&pageSize=50');
              if (!txs||!txs.results) continue;
              txs.results.forEach(tx => {
                todasTx.push({
                  banco: conta2.name,
                  data: tx.date?.slice(0,10),
                  tipo: tx.type,
                  valor: tx.amount,
                  descricao: tx.description,
                  paymentMethod: tx.paymentData?.paymentMethod,
                  checkNumber: tx.paymentData?.checkNumber
                });
              });
            }
          }
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({total:todasTx.length, transacoes:todasTx.slice(0,30)},null,2));
        } catch(e) {
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({erro:e.message}));
        }
      })();
      return;
    }
    if (req.url === '/test-saldos') {
      enviarSaldosBancarios().then(()=>{
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true}));
      }).catch(e=>{
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false,erro:e.message}));
      });
      return;
    }
    if (req.url === '/pluggy-save-item' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', async () => {
        try {
          const { itemId } = JSON.parse(body);
          if (!itemId) { res.writeHead(400); res.end(JSON.stringify({ok:false,erro:'itemId obrigatorio'})); return; }
          const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
          const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
          const rows = await req2('GET', SB_URL+'/rest/v1/erp_sync?select=data,device_id&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY});
          const d = Array.isArray(rows)&&rows.length ? JSON.parse(rows[0].data) : {};
          const deviceId = Array.isArray(rows)&&rows.length ? rows[0].device_id : 'pluggy_setup';
          if (!d.pluggyItemIds) d.pluggyItemIds = [];
          if (!d.pluggyItemIds.includes(itemId)) d.pluggyItemIds.push(itemId);
          await req2('POST', SB_URL+'/rest/v1/erp_sync',
            { device_id: deviceId, data: JSON.stringify(d) },
            { 'apikey': SB_KEY, 'Prefer': 'resolution=merge-duplicates', 'Content-Type': 'application/json' });
          console.log('Pluggy item salvo:', itemId, '- total items:', d.pluggyItemIds.length);
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:true, itemId, total: d.pluggyItemIds.length}));
        } catch(e) {
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false, erro:e.message}));
        }
      });
      return;
    }
    if (req.url === '/test-pluggy') {
      importarTransacoesPluggy().then(r => {
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify(r));
      }).catch(e => {
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false,erro:e.message}));
      });
      return;
    }
    if (req.url === '/relatorio-pdf') {
      (async () => {
        try {
          const result = await gerarEnviarRelatorioPDF();
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify(result));
        } catch(e) {
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false,erro:e.message}));
        }
      })();
      return;
    }
    if (req.url && req.url.startsWith('/recuperar-backup')) {
      const SB_URL2 = 'https://bxppiwshjyddiieazoqx.supabase.co';
      const SB_KEY2 = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
      (async () => {
        try {
          const backup = await req2('GET', 'https://raw.githubusercontent.com/'+REPO+'/dados/dre_sync.json?t='+Date.now(), null, {});
          if (!backup) throw new Error('Backup do GitHub nao encontrado');
          const diasBackup = Object.keys(backup).filter(k=>/^\d{2}\/\d{2}\/\d{4}$/.test(k));
          const payload = JSON.stringify({
            device_id: 'recuperacao_backup_github',
            data: JSON.stringify(backup),
            updated_at: new Date().toISOString()
          });
          await req2('POST', SB_URL2+'/rest/v1/erp_sync', JSON.parse(payload), {
            'apikey': SB_KEY2, 'Content-Type':'application/json', 'Prefer':'resolution=merge-duplicates'
          });
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:true, diasRestaurados: diasBackup.length, dias: diasBackup}));
        } catch(e) {
          res.writeHead(500, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false, erro:e.message}));
        }
      })();
      return;
    }
    if (req.url && req.url.startsWith('/ultimo-grupo')) {
      if (req.url.includes('debug')) {
        (async () => {
          try {
            const SB2='https://bxppiwshjyddiieazoqx.supabase.co';
            const SK2='sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
            // Verifica blob e pluggyItemIds
            const blobRows=await req2('GET',SB2+'/rest/v1/erp_sync?select=data,device_id,updated_at&order=updated_at.desc&limit=1',null,{'apikey':SK2});
            const blobData=Array.isArray(blobRows)&&blobRows.length?JSON.parse(blobRows[0].data):{};
            const pluggyIds=blobData.pluggyItemIds||[];
            // Verifica contas se há itemIds
            const contasInfo=[];
            for(const id of pluggyIds.slice(0,4)){
              const ct=await pluggyAuthFetch('GET','/accounts?itemId='+id).catch(e=>({erro:e.message}));
              contasInfo.push({itemId:id.slice(0,8),contas:(ct.results||[]).map(c=>({nome:c.name,saldo:c.balance,tipo:c.type}))});
            }
            const lr=await req2('GET',SB2+'/rest/v1/lancamentos?select=tipo,dia_comercial,valor,device_id&limit=2000',null,{'apikey':SK2});
            const pd={};
            if(Array.isArray(lr))lr.forEach(l=>{const d=l.dia_comercial||'?';if(!pd[d])pd[d]={r:0,c:0,tr:0,tc:0};if(l.tipo==='receita'){pd[d].r++;pd[d].tr+=Number(l.valor||0);}else{pd[d].c++;pd[d].tc+=Number(l.valor||0);}});
            res.writeHead(200,{'Content-Type':'application/json'});
            res.end(JSON.stringify({pluggyItemIds:pluggyIds,contasInfo,totalLancamentos:Array.isArray(lr)?lr.length:0,porDia:pd},null,2));
          }catch(e){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({erro:e.message}));}
        })();
      } else {
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ultimoGrupoId:global._ultimoGrupoId||null}));
      }
      return;
    }
    if (req.url && req.url.startsWith('/test-ifood-auth')) {
      obterTokenIfood().then(tok => {
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true, tokenPreview: tok.substring(0,15)+'...', mensagem:'Token obtido com sucesso!'}));
      }).catch(e => {
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false, erro: e.message}));
      });
      return;
    }
    if (req.url === '/restaurar-bot-lancamentos') { (async () => {
      try {
        const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
        const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
        // Busca bot_lancamentos.json do GitHub
        const botRaw = await req2('GET','https://raw.githubusercontent.com/'+REPO+'/main/bot_lancamentos.json?t='+Date.now(),null,{});
        const lancamentos = (botRaw.lancamentos||[]);
        // Busca blob atual
        const rows = await req2('GET', SB_URL+'/rest/v1/erp_sync?select=data,device_id&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY});
        const blobData = JSON.parse(rows[0].data);
        const deviceId = rows[0].device_id;
        let restaurados = 0;
        lancamentos.forEach(l => {
          const dia = l.data;
          if (!dia) return;
          // Ignora lançamentos onde Di Casa é o destinatário (recebeu, não pagou)
          const dest = (l.destinatario||'').toLowerCase();
          if (dest.includes('di casa') || dest.includes('gastronomia')) return;
          if (!blobData[dia]) blobData[dia] = {r:[], c:[]};
          const existentes = [...(blobData[dia].c||[]), ...(blobData[dia].r||[])];
          const ids = new Set(existentes.map(x=>x.id));
          // Chave de deduplicacao: valor + destinatario (evita duplicar mesmo lancamento com ID diferente)
          const chaves = new Set(existentes.map(x=>String(x.v||x.valor||0)+'_'+(x.d||x.desc||'').slice(0,15)));
          const chaveNova = String(Number(l.valor||0))+'_'+(l.destinatario||l.descricao||'').slice(0,15);
          if (ids.has(l.id) || chaves.has(chaveNova)) return;
          const item = {id:l.id, d:l.destinatario||l.descricao||'Pagamento', v:Number(l.valor||0), cat:l.categoria||'Outros', seg:'fixo', dt:dia};
          if (l.tipo_lancamento==='custo') {
            if (!blobData[dia].c) blobData[dia].c = [];
            blobData[dia].c.push(item);
          } else {
            if (!blobData[dia].r) blobData[dia].r = [];
            blobData[dia].r.push(item);
          }
          restaurados++;
        });
        await req2('POST', SB_URL+'/rest/v1/erp_sync',
          { device_id: deviceId, data: JSON.stringify(blobData) },
          { 'apikey': SB_KEY, 'Prefer': 'resolution=merge-duplicates', 'Content-Type': 'application/json' });
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true, restaurados, total:lancamentos.length}));
      } catch(e) {
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false,erro:e.message}));
      }
    })(); return;
    }
    if (req.url && req.url.startsWith('/limpar-teste-sefaz')) { (async () => {
      const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
      const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
      try {
        const rows = await req2('GET', SB_URL+'/rest/v1/erp_sync?select=data,device_id&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY});
        const d = JSON.parse(rows[0].data);
        const deviceId = rows[0].device_id;
        // Remove itens de teste do estoque
        const estAntes = (d.est||[]).length;
        d.est = (d.est||[]).filter(p => !p.id?.startsWith('sefaz_'));
        // Remove contas a pagar de teste
        const cpAntes = (d.contasPagar||[]).length;
        d.contasPagar = (d.contasPagar||[]).filter(cp => !cp.id?.startsWith('sefaz_cp_'));
        // Remove lancamentos de teste da tabela lancamentos
        // Apaga APENAS os de teste (sefaz_teste) - nao apaga os reais (sefaz_auto)
        await req2('DELETE', SB_URL+'/rest/v1/lancamentos?device_id=eq.sefaz_teste', null, {'apikey':SB_KEY, 'Content-Type':'application/json'}).catch(()=>{});
        await req2('DELETE', SB_URL+'/rest/v1/movimentos_estoque?device_id=eq.sefaz_teste', null, {'apikey':SB_KEY, 'Content-Type':'application/json'}).catch(()=>{});
        // Salva blob limpo
        await req2('POST', SB_URL+'/rest/v1/erp_sync', { device_id: deviceId, data: JSON.stringify(d) },
          { 'apikey': SB_KEY, 'Prefer': 'resolution=merge-duplicates', 'Content-Type': 'application/json' });
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ ok: true, estRemovidos: estAntes-(d.est||[]).length, cpRemovidos: cpAntes-(d.contasPagar||[]).length, mensagem: 'Limpo! Agora clique em Restaurar da Nuvem no sistema.' }));
      } catch(e) {
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false,erro:e.message}));
      }
    })(); return;
    }
    if (req.url && req.url.startsWith('/test-nfe-simulada')) { (async () => {
      // Simula uma NF chegando da SEFAZ com itens reais de restaurante
      const tsAgora = Date.now().toString();
      const nfeSimulada = {
        emitente: 'DISTRIBUIDORA TESTE LTDA',
        cnpjEmit: '99999999000199',
        nNF: '000001',
        chNFe: '31' + tsAgora.padStart(42,'0').slice(0,42),
        data: new Date().toLocaleDateString('pt-BR'),
        vencimento: new Date(Date.now()+7*24*60*60*1000).toLocaleDateString('pt-BR'),
        valor: 1250.80,
        itens: [
          { descricao: 'ALCATRA BOVINA KG', quantidade: 10, unidade: 'KG', valor_unitario: 45.00, valor_total: 450.00 },
          { descricao: 'FRANGO INTEIRO KG', quantidade: 8, unidade: 'KG', valor_unitario: 18.50, valor_total: 148.00 },
          { descricao: 'DETERGENTE 5L', quantidade: 4, unidade: 'UN', valor_unitario: 22.00, valor_total: 88.00 },
          { descricao: 'EMBALAGEM MARMITA 500ML CX', quantidade: 5, unidade: 'CX', valor_unitario: 45.00, valor_total: 225.00 },
          { descricao: 'TOMATE KG', quantidade: 15, unidade: 'KG', valor_unitario: 8.00, valor_total: 120.00 },
          { descricao: 'CARVAO CX 10KG', quantidade: 3, unidade: 'CX', valor_unitario: 73.27, valor_total: 219.80 }
        ]
      };
      const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
      const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
      try {
        // Sequencial — evita race condition no blob do Supabase
        const estOk = await lancarEstoqueNFeSefaz(nfeSimulada, nfeSimulada, SB_URL, SB_KEY);
        const contaOk = await lancarContaPagarNFeSefaz(nfeSimulada, nfeSimulada, SB_URL, SB_KEY);
        // Lanca custo no DRE
        await req2('POST', SB_URL+'/rest/v1/lancamentos',
          { id: 'teste_nf_'+Date.now(), tipo: 'custo', dia_comercial: nfeSimulada.data,
            descricao: 'NF TESTE - DISTRIBUIDORA TESTE LTDA',
            categoria: '🥩 Matéria Prima', segmento: null, valor: nfeSimulada.valor,
            device_id: 'sefaz_teste' },
          { 'apikey': SB_KEY, 'Prefer': 'return=minimal', 'Content-Type': 'application/json' });
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({
          ok: true,
          mensagem: 'NF simulada processada com sucesso!',
          itensEstoque: estOk,
          contaPagar: contaOk,
          nf: { emitente: nfeSimulada.emitente, valor: nfeSimulada.valor, itens: nfeSimulada.itens.length, vencimento: nfeSimulada.vencimento }
        }, null, 2));
      } catch(e) {
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false, erro:e.message}));
      }
      })();
      return;
    }
    if (req.url && req.url.startsWith('/test-ifood-financial')) {
      const u = new URL(req.url, 'http://x');
      const merchantId = u.searchParams.get('merchantId');
      const beginDate = u.searchParams.get('beginDate') || '2025-01-01';
      const endDate = u.searchParams.get('endDate') || '2025-01-31';
      if (!merchantId) {
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false, erro:'Passe ?merchantId=XXX na URL'}));
        return;
      }
      buscarFinancialEventsIfood(merchantId, beginDate, endDate).then(r => {
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true, statusIfood: r.status, resposta: r.body}, null, 2));
      }).catch(e => {
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false, erro: e.message}));
      });
      return;
    }
    if (req.url === '/configurar-certificado' && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const { pfxBase64, senha, cnpj } = JSON.parse(body);
          if (!pfxBase64 || !senha) throw new Error('pfxBase64 e senha obrigatórios');
          const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
          const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
          // Lê o blob atual e adiciona o certificado nele (sem precisar de nova tabela)
          const rows = await req2('GET', SB_URL+'/rest/v1/erp_sync?select=data,device_id&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY});
          let dados = {};
          let deviceId = 'servidor';
          if (Array.isArray(rows) && rows.length) {
            dados = JSON.parse(rows[0].data);
            deviceId = rows[0].device_id || deviceId;
          }
          if (!dados.dadosFiscais) dados.dadosFiscais = {};
          dados.dadosFiscais.certificado = { pfxBase64, senha, cnpj };
          await req2('POST', SB_URL+'/rest/v1/erp_sync',
            { device_id: deviceId, data: JSON.stringify(dados) },
            { 'apikey': SB_KEY, 'Prefer': 'resolution=merge-duplicates', 'Content-Type': 'application/json' });
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ ok: true, mensagem: 'Certificado salvo no sistema!' }));
        } catch(e) {
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ ok: false, erro: e.message }));
        }
      });
      return;
    }
    if (req.url && req.url.startsWith('/test-sefaz-dist')) {
      const u = new URL(req.url, 'http://x');
      const ultNSU = u.searchParams.get('ultNSU') || '000000000000000';
      // Busca o certificado do Supabase (onde está salvo)
      const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
      const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
      req2('GET', SB_URL+'/rest/v1/erp_sync?select=data&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY}).then(async rows => {
        try {
          if (!Array.isArray(rows) || !rows.length) throw new Error('Sem dados no sistema');
          const d = JSON.parse(rows[0].data);
          const cert = d.dadosFiscais?.certificado;
          if (!cert || !cert.pfxBase64) throw new Error('Certificado não configurado. Use o botão "🔐 Enviar Certificado pro Servidor" em Config → Fiscal');
          const r = await sefazDistribuicaoDFe(cert.pfxBase64, cert.senha, '44686412000100', ultNSU, 'prod');
          const nfes = parsearNFesDoXML(r.xml);
          res.writeHead(200, {'Content-Type':'application/json'});
          // Extrai o cStat e xMotivo pra debug
          const cStat = (r.xml.match(/<cStat>(\d+)<\/cStat>/) || [])[1] || '';
          const xMotivo = (r.xml.match(/<xMotivo>([^<]+)<\/xMotivo>/) || [])[1] || '';
          const ultNSUResp = (r.xml.match(/<ultNSU>(\d+)<\/ultNSU>/) || [])[1] || '';
          const maxNSU = (r.xml.match(/<maxNSU>(\d+)<\/maxNSU>/) || [])[1] || '';
          res.end(JSON.stringify({ok:true, status:r.status, cStat, xMotivo, ultNSU:ultNSUResp, maxNSU, nfes, xmlLen:r.xml.length}));
        } catch(e) {
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:false, erro:e.message}));
        }
      }).catch(e => {
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false, erro:'Erro ao buscar dados: '+e.message}));
      });
      return;
    }
    if (req.url && req.url.startsWith('/test-supabase')) {
      const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
      const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
      req2('GET', SB_URL+'/rest/v1/erp_sync?select=data,device_id,updated_at&order=updated_at.desc&limit=1',null,
        {'apikey':SB_KEY}
      ).then(rows=>{
        let resumo = {ok:true, encontrado: Array.isArray(rows)&&rows.length>0};
        if (resumo.encontrado) {
          const d = JSON.parse(rows[0].data);
          resumo.updated_at = rows[0].updated_at;
          resumo.dias_no_banco = Object.keys(d).filter(k=>/\d{2}\/\d{2}\/\d{4}/.test(k)).length;
          resumo.tem_19_06 = !!d['19/06/2026'];
          if (d['19/06/2026']) {
            resumo.receita_19_06 = (d['19/06/2026'].r||[]).reduce((s,x)=>s+Number(x.v||0),0);
            resumo.custo_19_06 = (d['19/06/2026'].c||[]).reduce((s,x)=>s+Number(x.v||0),0);
          }
        }
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify(resumo,null,2));
      }).catch(e=>{
        res.writeHead(500,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false,erro:e.message}));
      });
      return;
    }
    if (req.url && req.url.startsWith('/test-dispatch')) {
      const agoraMs = Date.now();
      if (global._ultimoTestDispatch && (agoraMs - global._ultimoTestDispatch) < 20000) {
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false, ignorado:true, motivo:'Disparo duplicado bloqueado (aguarde 20s entre testes)'}));
        return;
      }
      global._ultimoTestDispatch = agoraMs;
      const urlObj = new URL(req.url, 'http://x');
      const diaParam = urlObj.searchParams.get('dia');
      executarDispatch(diaParam||null).then(resultado => {
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify(resultado));
      }).catch(e => {
        res.writeHead(500, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false, erro:e.message}));
      });
      return;
    }
    res.writeHead(200); res.end(JSON.stringify({status:'ok v8'})); return;
  }
  // Handler do webhook Pluggy (item.created / item.updated)
  if (req.url === '/pluggy-webhook') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const evento = JSON.parse(body);
        console.log('Pluggy webhook:', evento.event, 'itemId:', evento.itemId || (evento.item&&evento.item.id));
        const itemId = evento.itemId || (evento.item&&evento.item.id);
        const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
        const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
        const rows = await req2('GET', SB_URL+'/rest/v1/erp_sync?select=data,device_id&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY});
        const d = Array.isArray(rows)&&rows.length ? JSON.parse(rows[0].data) : {};
        const deviceId = Array.isArray(rows)&&rows.length ? rows[0].device_id : 'pluggy_setup';
        if (!d.pluggyItemIds) d.pluggyItemIds = [];
        if (!d.contasPagar) d.contasPagar = [];
        if (!d.estravio) d.estravio = [];

        const evtName = evento.event || '';
        console.log('Pluggy webhook evento:', evtName, 'itemId:', itemId);

        // ── BOLETO/UPDATED ──────────────────────────────────────
        if (evtName === 'boleto/updated' || evtName === 'boleto.updated') {
          const bol = evento.data || evento.boleto || {};
          const valor = Math.abs(Number(bol.amount||bol.value||0));
          const venc = (bol.dueDate||bol.expirationDate||'').slice(0,10).split('-').reverse().join('/');
          const cnpjEmit = (bol.beneficiary&&(bol.beneficiary.documentNumber||bol.beneficiary.taxNumber||bol.beneficiary.document||'')||'').replace(/\D/g,'');
          const nomeEmit = (bol.beneficiary&&bol.beneficiary.name||bol.description||'Boleto DDA').slice(0,60);
          const barCode = bol.barCode||bol.digitableLine||bol.transactionCode||'';
          const status = (bol.status||'PENDING').toUpperCase();
          const idBol = 'dda_'+( bol.id||barCode.slice(0,20)||Date.now().toString(36));

          console.log('Pluggy boleto:', nomeEmit, 'R$'+valor, venc, status, cnpjEmit);

          if (valor > 0) {
            // Verifica se ja existe
            const jaExiste = d.contasPagar.find(cp=>cp.id===idBol) || d.estravio.find(e=>e.id===idBol);

            if (!jaExiste) {
              // Tenta vincular a uma NF pelo CNPJ emitente
              const nfMatch = d.contasPagar.find(cp => {
                if (!cp._sefaz || cp.pago) return false;
                const c1 = (cp.cnpjEmit||'').replace(/\D/g,'');
                const c2 = cnpjEmit;
                if (c1 && c2 && c1 === c2) return true;
                const n1 = (cp.forn||'').toLowerCase().slice(0,12);
                const n2 = nomeEmit.toLowerCase().slice(0,12);
                return n1 && n2 && n1 === n2;
              });

              if (nfMatch) {
                // ✅ VINCULADO À NF
                d.contasPagar.push({
                  id: idBol, forn: nomeEmit, val: valor, venc, pago: status==='PAID',
                  cat: nfMatch.cat||'🥩 Matéria Prima', cnpjEmit, barCode,
                  _dda: true, _nfId: nfMatch.id, _pluggy: true,
                  dtPagamento: status==='PAID' ? venc : null
                });
                console.log('Boleto DDA vinculado à NF:', nfMatch.forn);
                // Notifica chegada do boleto
                const msgBol = '📬 *Boleto DDA recebido*\n'+
                  '• '+nomeEmit+'\n'+
                  '• Valor: *'+brl(valor)+'*\n'+
                  '• Venc: '+venc+'\n'+
                  '• Vinculado à NF ✅';
                for(const num of ['5534996853258','5534997692282']) wpp(num,msgBol).catch(()=>{});
              } else {
                // ❌ SEM NF — vai para estravio
                d.estravio.push({
                  id: idBol, desc: nomeEmit, valor, dia: venc,
                  tipo: 'DDA/Boleto', cnpj: cnpjEmit, barCode, revisado: false, _dda: true
                });
                console.log('Boleto DDA sem NF correspondente → estravio:', nomeEmit);
                const msgEstr = '⚠️ *Boleto sem NF correspondente*\n'+
                  '• '+nomeEmit+'\n'+
                  '• Valor: *'+brl(valor)+'*\n'+
                  '• Venc: '+venc+'\n'+
                  '• Verifique em 🔍 Estravio';
                for(const num of ['5534996853258','5534997692282']) wpp(num,msgEstr).catch(()=>{});
              }

              // Salva
              await req2('POST', SB_URL+'/rest/v1/erp_sync',
                {device_id: deviceId, data: JSON.stringify(d)},
                {'apikey': SB_KEY, 'Prefer': 'resolution=merge-duplicates', 'Content-Type': 'application/json'});
            } else if (status === 'PAID') {
              // Boleto ja existia mas foi marcado como pago agora
              const cp = d.contasPagar.find(cp=>cp.id===idBol);
              if (cp && !cp.pago) {
                cp.pago = true;
                cp.dtPagamento = new Date().toLocaleDateString('pt-BR');
                await req2('POST', SB_URL+'/rest/v1/erp_sync',
                  {device_id: deviceId, data: JSON.stringify(d)},
                  {'apikey': SB_KEY, 'Prefer': 'resolution=merge-duplicates', 'Content-Type': 'application/json'});
                console.log('Boleto DDA marcado como pago:', nomeEmit);
                const msgPago = '✅ *Boleto baixado automaticamente*\n'+
                  '• '+nomeEmit+'\n'+
                  '• Valor: *'+brl(valor)+'*\n'+
                  '• Pago em: '+new Date().toLocaleDateString('pt-BR')+'\n'+
                  '• Conta a pagar atualizada ✅';
                for(const num of ['5534996853258','5534997692282']) wpp(num,msgPago).catch(()=>{});
              }
            }
          }
        }

        // TRANSACTIONS/CREATED - debitos em tempo real
        if (evtName === 'transactions/created' || evtName === 'transactions/updated') {
          var accountId2 = evento.accountId;
          var txLink2 = evento.createdTransactionsLink;
          if (accountId2 || txLink2) {
            (async function() {
              try {
                var txPath = txLink2 ? txLink2.replace('https://api.pluggy.ai','') : '/transactions?accountId='+accountId2+'&pageSize=50';
                var txs2 = await pluggyAuthFetch('GET', txPath).catch(function(){ return {}; });
                if (!txs2 || !txs2.results || !txs2.results.length) return;
                var fmtD = function(s){ return s ? s.slice(0,10).split('-').reverse().join('/') : ''; };
                var imp = 0;
                for (var ti=0; ti<txs2.results.length; ti++) {
                  var tx2 = txs2.results[ti];
                  if (tx2.type !== 'DEBIT') continue;
                  var val2 = Math.abs(Number(tx2.amount||0));
                  if (val2 < 0.01) continue;
                  var dia2 = fmtD(tx2.date);
                  if (!dia2) continue;
                  var dest2 = tx2.paymentData && tx2.paymentData.receiver && tx2.paymentData.receiver.name;
                  var desc2 = (dest2||tx2.description||'Transacao').slice(0,80).trim();
                  var cat2 = classificarTransacao(desc2, -val2);
                  await req2('POST', SB_URL+'/rest/v1/lancamentos',
                    {id:'pluggy_'+tx2.id, tipo:'custo', dia_comercial:dia2, descricao:desc2, categoria:cat2, segmento:null, valor:val2, device_id:'pluggy_auto'},
                    {'apikey':SB_KEY, 'Prefer':'return=minimal,resolution=ignore-duplicates', 'Content-Type':'application/json'}
                  ).catch(function(){});
                  imp++;
                }
                console.log('Pluggy tx webhook: '+imp+' debitos importados');
              } catch(e2){ console.log('Pluggy tx erro:', e2.message); }
            })();
          }
        }
        // ITEM/ERROR - avisa WhatsApp
        if (evtName === 'item/error' || evtName === 'item/waiting_user_input') {
          var errMsg = (evento.error||evento.message||'Banco desconectado');
          var alertMsg = 'Pluggy alerta: reconecte o banco.\nAcesse /pluggy-connect\nMotivo: '+errMsg;
          wpp('5534996853258', alertMsg).catch(function(){});
          wpp('5534997692282', alertMsg).catch(function(){});
        }

        // ITEM/CREATED ou ITEM/UPDATED
        if (itemId) {
          if (!d.pluggyItemIds.includes(itemId)) {
            d.pluggyItemIds.push(itemId);
            await req2('POST', SB_URL+'/rest/v1/erp_sync',
              { device_id: deviceId, data: JSON.stringify(d) },
              { 'apikey': SB_KEY, 'Prefer': 'resolution=merge-duplicates', 'Content-Type': 'application/json' });
            console.log('Pluggy webhook: novo itemId salvo:', itemId);
          }
          if (evtName === 'item/updated' || evtName === 'item.updated') {
            importarTransacoesPluggy().catch(function(e){ console.log('Pluggy import erro:', e.message); });
            // Debounce 5min: aguarda todos os bancos sincronizarem antes de enviar saldos
            if (global._saldoDebounce) clearTimeout(global._saldoDebounce);
            global._saldoDebounce = setTimeout(function() {
              console.log('Pluggy: bancos atualizados, enviando saldos...');
              enviarSaldosBancarios().catch(function(e){ console.log('Saldo erro:', e.message); });
            }, 5 * 60 * 1000);
          }
        }

        // TRANSACTIONS/CREATED ou TRANSACTIONS/UPDATED — tempo real
        if (evtName==='transactions/created'||evtName==='transactions/updated') {
          var accountId2 = evento.accountId;
          var txLink2 = evento.createdTransactionsLink;
          if (accountId2||txLink2) {
            pluggyAuth().then(function(key){
              var txUrl2 = txLink2 || ('https://api.pluggy.ai/transactions?accountId='+accountId2+'&from='+new Date(Date.now()-2*86400000).toISOString().slice(0,10)+'&pageSize=50');
              return fetch(txUrl2,{headers:{'X-API-KEY':key,'Content-Type':'application/json'}}).then(function(r){return r.json();});
            }).then(function(txs){
              if(!txs||!txs.results)return;
              var count=0;
              var processarTx = function(i){
                if(i>=txs.results.length){console.log('Pluggy tx webhook: '+count+' processadas');return;}
                var tx=txs.results[i];
                if(tx.type==='CREDIT'){processarTx(i+1);return;}
                var valor=Math.abs(Number(tx.amount||0));
                if(valor<0.01){processarTx(i+1);return;}
                var dia=(tx.date||'').slice(0,10).split('-').reverse().join('/');
                if(!dia){processarTx(i+1);return;}
                var payDest=tx.paymentData&&tx.paymentData.receiver&&tx.paymentData.receiver.name;
                var desc=(payDest||tx.description||'Transacao').slice(0,80).trim();
                var cat=classificarTransacaoPluggy(tx);
                req2('POST',SB_URL+'/rest/v1/lancamentos',
                  {id:'pluggy_'+tx.id,tipo:'custo',dia_comercial:dia,descricao:desc,categoria:cat,segmento:null,valor,device_id:'pluggy_auto'},
                  {'apikey':SB_KEY,'Prefer':'return=minimal,resolution=ignore-duplicates','Content-Type':'application/json'}
                ).catch(function(){}).then(function(){count++;processarTx(i+1);});
              };
              processarTx(0);
            }).catch(function(e){console.log('Pluggy tx webhook erro:',e.message);});
          }
        }

        // ITEM/ERROR — alerta WhatsApp
        if (evtName==='item/error'||evtName==='item/waiting_user_input') {
          var bancoErr=(evento.connector&&evento.connector.name)||'Banco';
          var msgErr='Banco '+bancoErr+' perdeu conexao. Reconecte em: gestaoerp-webhook.onrender.com/pluggy-connect';
          wpp('5534996853258','alertas Pluggy: '+msgErr).catch(function(){});
          wpp('5534997692282','alertas Pluggy: '+msgErr).catch(function(){});
        }

        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:true}));
      } catch(e) {
        console.error('Pluggy webhook erro:', e.message);
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({ok:false, erro:e.message}));
      }
    });
    return;
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
      if (!msg || !msg.key || !msg.key.remoteJid || !msg.key.remoteJid.includes('@g.us')) return;
      const num = msg.key.remoteJid;
      global._ultimoGrupoId = num; // pra descobrir o ID de grupos novos via /ultimo-grupo
      const NF_GROUP_ID = '120363429855996118@g.us';
      const tipo = msg.messageType || Object.keys(msg.message||{})[0] || '';
      console.log('MSG:', tipo);

      // ── DOCUMENTO (STi3 Excel) ──────────────────────────────
      if (['documentMessage','documentWithCaptionMessage'].includes(tipo)) {
        const docMsg = msg.message?.documentMessage || msg.message?.documentWithCaptionMessage?.message?.documentMessage;
        const caption = (docMsg?.caption || msg.message?.documentWithCaptionMessage?.message?.documentMessage?.caption || '').toLowerCase();
        const fileName = (docMsg?.fileName || '').toLowerCase();
        const isExcel = fileName.endsWith('.xlsx') || fileName.endsWith('.xls');
        const isSti3 = caption.includes('sti3') || caption.includes('sti 3') || caption.includes('vendas');
        if (isExcel && isSti3) {
          console.log('STi3 arquivo detectado:', fileName, 'caption:', caption);
          processarSTi3WhatsApp(msg, num).catch(e => console.error('STi3 erro:', e.message));
          return;
        }
      }

      if (['textMessage','extendedTextMessage','conversation'].includes(tipo)) {
        // Comprovante enviado como TEXTO (ex: Stone, copia do recibo)
        const texto = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.textMessage?.text || '';
        const palavrasChave = ['comprovante','transferência','transferencia','valor','pix','cnpj','dados de destino','dados de origem','stone','c6','itaú','itau','pagamento','recibo'];
        const ehComprovante = palavrasChave.some(p => texto.toLowerCase().includes(p));
        if (!ehComprovante) return;
        await wpp(num, 'Lendo comprovante de texto...');
        const r1 = await claude([{ role:'user', content: texto + '\n\nAnalise este comprovante de pagamento acima. Este comprovante é de um PAGAMENTO FEITO pela empresa Di Casa Gastronomia / Di Casa Laranjinha. Di Casa Gastronomia é SEMPRE o PAGADOR (quem enviou o dinheiro), NUNCA o destinatário. Identifique: (1) VALOR pago, (2) NOME DE QUEM RECEBEU o dinheiro (campo Destino/Favorecido/Beneficiario - é a OUTRA PESSOA ou empresa, NUNCA Di Casa Gastronomia, NUNCA Di Casa Laranjinha, NUNCA nome de banco/cooperativa/instituicao financeira). Se o campo destino/favorecido mostrar "Di Casa" é porque voce está lendo o campo errado - procure o outro lado da transacao. (3) DATA, (4) TIPO pix/boleto/cartao, (5) OBSERVACAO/descricao da transferencia se houver. Se nao tiver observacao informe SEM_DESCRICAO.' }], 600);
        // Log completo da resposta para debug
        console.log('tipo msg:', tipo);
        console.log('r1 response:', JSON.stringify(r1).substring(0,300));
        let analise = 'Nao consegui extrair.';
        if (r1 && r1.content && r1.content[0]) {
          analise = r1.content[0].text || r1.content[0].type || 'Sem texto';
        } else if (r1 && r1.error) {
          analise = 'Erro API: ' + JSON.stringify(r1.error);
        }
        console.log('Analise texto:', analise.substring(0,100));
        // Texto nao tem imagem original pra salvar (era so o b64 quebrado antes)
        const msgAnalise = analise==='Nao consegui extrair.' ? 
          'Nao consegui extrair. Tente: 1) salvar a imagem e reenviar, 2) tirar foto da tela do comprovante.' : 
          'Analise:\n' + analise.substring(0,300);
        await wpp(num, msgAnalise);
        const prompt2 = 'Extraia do texto abaixo APENAS JSON valido. Texto: "' + analise + '". Formato: {"valor":0.00,"valorJuros":0.00,"destinatario":"nome de quem recebeu - NUNCA Di Casa Gastronomia, NUNCA nome de banco/cooperativa/instituicao financeira (SICOOB,CCLA,Nu Pagamentos,etc), use a PESSOA/EMPRESA dona da conta","categoria":"🥩 Matéria Prima (alimentos,insumos,carnes,hortifruti,frango,peixe,legumes,verduras,feira,padaria,mercado,bebidas ingredientes,pamonha,carvao,gelo,ovos,queijo,manteiga,farinha,tempero,molho)|👥 RH / Mão de Obra (salario,diaria,freelancer,diarista,funcionario,colaborador,pagamento pessoa fisica - NAO usar para alimentos,comida,feira,mercado,padaria,carne,frango,legumes,hortifruti)|🔧 Manutenção (reparo,conserto,tecnico)|💡 Energia / Utilidades (luz,agua,gas)|🚚 Frete / Entregador (entrega,motoboy,frete,logistica)|🏢 Aluguel / Fixos (aluguel,iptu,condominio)|📦 Embalagem (embalagem,caixa,sacola)|🍺 Bebidas / Bar (bebida,drinks,cerveja,refrigerante)|🧹 Limpeza / Higiene (limpeza,higiene,produto)|💳 Taxas / Impostos (taxa,imposto,multa,cartao)|📱 Telecom / Internet (internet,telefone,celular)|🔄 Outros","tipo":"pix|boleto|dinheiro|credito|debito|stone|cielo","data":"DD/MM/AAAA","descricao":"motivo do pagamento se houver"}. IMPORTANTE: valorJuros e o valor de JUROS ou MULTA cobrado SEPARADAMENTE do valor principal (comum em boleto pago com atraso). Se o comprovante mostrar "Valor original" + "Juros/Multa" separados, valor=valor original e valorJuros=juros/multa. Se nao houver juros/multa, valorJuros=0. Se nao tiver valor retorne {"valor":0}';
        const r2 = await claude([{ role:'user', content: prompt2 }], 300);
        const texto2 = r2.content && r2.content[0] ? r2.content[0].text : '{}';
        const match = texto2.match(/\{[\s\S]*\}/);
        let lanc = null;
        let lancJuros = null;
        if (match) {
          try {
            const d = JSON.parse(match[0]);
            if (!d.valor || d.valor <= 0) { await wpp(num, 'Valor nao identificado.'); return; }
            lanc = (()=>{
              const _raw = d.destinatario||d.descricao||'';
              const _prefixos = ['Pagamento para ','Para ','Favorecido: ','Beneficiário: ','Beneficiario: ','Recebedor: ','Destino: ','Pago para ','Pago a ','Transferência para ','Transferencia para '];
              let _dest = _raw;
              for(const p of _prefixos){ if(_dest.toLowerCase().startsWith(p.toLowerCase())){ _dest=_dest.slice(p.length).trim(); break; } }
              const _desc = d.descricao&&d.descricao!==d.destinatario&&d.descricao!=='SEM_DESCRICAO' ? d.descricao : '';
              return { valor: d.valor, categoria: d.categoria||'Outros', descricao: _desc, destinatario: _dest, tipo: d.tipo||'pix', data: d.data||new Date().toLocaleDateString('pt-BR'), confianca: 'alta', setor: 'Geral', origem: 'whatsapp_texto' };
            })();
            if (d.valorJuros && d.valorJuros > 0) {
              lancJuros = { valor: d.valorJuros, categoria: '💳 Taxas / Impostos', descricao: 'Juros/multa', destinatario: lanc.destinatario + ' (juros)', tipo: lanc.tipo, data: lanc.data, confianca: 'alta', setor: 'Geral', origem: 'whatsapp_texto' };
            }
          } catch(e) { lanc = null; }
        }
        if (!lanc || !lanc.valor) { await wpp(num, 'Nao identifiquei os dados. Tente enviar como foto.'); return; }
        // Salva no GitHub (mesmo fluxo das imagens)
        try {
          const fi = await req2('GET','https://api.github.com/repos/'+REPO+'/contents/bot_lancamentos.json?ref=dados',null,{'Authorization':'token '+GHTOKEN,'Accept':'application/vnd.github.v3+json'});
          if (!fi || !fi.content) { await wpp(num, 'Erro GitHub.'); return; }
          const fd = JSON.parse(Buffer.from(fi.content, 'base64').toString());
          if (!fd.lancamentos) fd.lancamentos = [];
          fd.lancamentos.push({ id: Date.now().toString(36), ...lanc, tipo_lancamento: 'custo', setor: lanc.setor||'Geral', criadoEm: new Date().toISOString(), sincronizado: false });
          if (lancJuros) {
            fd.lancamentos.push({ id: (Date.now()+1).toString(36), ...lancJuros, tipo_lancamento: 'custo', setor: 'Geral', criadoEm: new Date().toISOString(), sincronizado: false });
          }
          if (fd.lancamentos.length > 200) fd.lancamentos = fd.lancamentos.slice(-200);
          await req2('PUT','https://api.github.com/repos/'+REPO+'/contents/bot_lancamentos.json?ref=dados',{ message: 'bot:'+lanc.valor, content: Buffer.from(JSON.stringify(fd)).toString('base64'), sha: fi.sha, branch: 'dados' },{'Authorization':'token '+GHTOKEN,'Accept':'application/vnd.github.v3+json'});
          let msgOk = 'Lancado! R$ '+lanc.valor.toFixed(2)+' - '+lanc.categoria;
          if (lancJuros) msgOk += '\n+ Juros: R$ '+lancJuros.valor.toFixed(2)+' - '+lancJuros.categoria;
          await wpp(num, msgOk);
        } catch(e) { await wpp(num, 'Erro ao salvar: '+e.message); }
        return;
      }
if (num === NF_GROUP_ID && ['imageMessage','documentMessage'].includes(tipo)) {
        const b64nf = await getMidia(msg);
        if (!b64nf) { await wpp(num, 'Nao consegui baixar a imagem.'); return; }
        try {
          const e1nf = await claude([{ role:'user', content:[
            tipo === 'documentMessage' ? { type:'document', source:{ type:'base64', media_type:'application/pdf', data:b64nf } } : { type:'image', source:{ type:'base64', media_type: b64nf.startsWith('/9j/')||b64nf.startsWith('/9J/')?'image/jpeg':b64nf.startsWith('iVBORw')?'image/png':'image/jpeg', data:b64nf } },
            { type:'text', text:'Transcreva TODO o texto desta nota fiscal brasileira.\nFOQUE EM:\n1."VALOR A COBRAR" - canto superior direito\n2."FAT" ou "FATURA" - vencimento abaixo do municipio - SE HOUVER MAIS DE UM VENCIMENTO/BOLETO/PARCELA, transcreva TODOS com data e valor\n3. Tabela de produtos - CADA LINHA COMPLETA com: descricao, qtd, unidade, V.UNIT, V.TOTAL\n4. Emitente (fornecedor) - bloco superior direito\n5. Numero da NF e serie\n6. DATA DE EMISSAO - geralmente perto do numero da NF/serie, formato DD/MM/AAAA, e DIFERENTE da data de vencimento\nTranscreva linha por linha da tabela de produtos sem omitir nada.' }
          ]}], 3000);
          const textoNf = (e1nf.content||[]).map(b=>b.text||'').join('').trim();
          if (!textoNf || textoNf.length < 20) { await wpp(num, 'Nao consegui ler essa NF. Tenta foto mais nitida.'); return; }

          const e3nf = await claude([{ role:'user', content: 'Interprete o texto de nota fiscal brasileira abaixo. REGRAS: 1. Cada produto = item separado. 2. Formato NxM na descricao = unidades por caixa (12X1->upc:12). Se o segundo numero tiver peso/volume (192X7G,24X350ML), o PRIMEIRO numero e o upc, nunca multiplique pelo peso. 3. Vencimento: campo FAT/FATURA, nao use emissao. Data (emissao): campo proximo ao numero/serie da nota, SEMPRE preencha se aparecer no texto transcrito, mesmo que vencimento tambem exista. Se houver VARIAS parcelas, liste todas em "parcelas". 4. Valor: VALOR A COBRAR. 5. Converta BR: virgula=decimal, ponto=milhar.\nJSON: {"fornecedor":"","cnpj":"","numero":"","data":"DD/MM/AAAA","vencimento":"DD/MM/AAAA","parcelas":[{"vencimento":"DD/MM/AAAA","valor":0.00}],"valor_total":0.00,"itens":[{"descricao":"","quantidade":0,"unidade":"cx","unidades_por_cx":1,"valor_unitario":0.00,"valor_total":0.00}]}\nRetorne APENAS o JSON, sem markdown.\nTEXTO:\n' + textoNf }], 3000);
          const txtJsonNf = (e3nf.content||[]).map(b=>b.text||'').join('').trim();
          const matchNf = txtJsonNf.match(/\{[\s\S]*\}/);
          if (!matchNf) { await wpp(num, 'Nao consegui estruturar essa NF.'); return; }
          const dadosNf = JSON.parse(matchNf[0]);
          if (!dadosNf.valor_total || dadosNf.valor_total <= 0) { await wpp(num, 'Valor nao identificado nessa NF.'); return; }

          const reciboUrlNf = await salvarReciboGitHub(b64nf, tipo, new Date());
          const somaItensNf = (dadosNf.itens||[]).reduce((s,it)=>s+(Number(it.valor_total)||Number(it.quantidade)*Number(it.valor_unitario)||0),0);

          await salvarGitHubBatch([{
            tipo: 'nf',
            fornecedor: dadosNf.fornecedor || 'Fornecedor',
            numero: dadosNf.numero || '',
            data: dadosNf.data || '',
            vencimento: dadosNf.vencimento || '',
            parcelas: dadosNf.parcelas || [],
            valor: dadosNf.valor_total,
            itens: dadosNf.itens || [],
            destinatario: dadosNf.fornecedor || 'Fornecedor',
            categoria: '🥩 Matéria Prima',
            origem: 'whatsapp_nf'
          }], reciboUrlNf);

          let respNf = `📄 *NF ${dadosNf.numero||''} — ${dadosNf.fornecedor||'Fornecedor'}*\n`;
          respNf += `Data: ${dadosNf.data||'?'} · Venc: ${dadosNf.vencimento||'?'}\n`;
          respNf += `${(dadosNf.itens||[]).length} item(ns) · Total: R$ ${Number(dadosNf.valor_total).toFixed(2)}\n`;
          if (Math.abs(somaItensNf - dadosNf.valor_total) > Math.max(0.5, dadosNf.valor_total*0.05)) {
            respNf += `\n⚠️ Soma dos itens (R$${somaItensNf.toFixed(2)}) difere do total — confira no site antes de lançar.`;
          }
          if ((dadosNf.parcelas||[]).length > 1) {
            respNf += `\n💳 ${dadosNf.parcelas.length} parcelas detectadas.`;
          }
          respNf += `\n\n_Fica pendente pra você confirmar no site (Fila de Digitalização)._`;
          await wpp(num, respNf);
        } catch (eNf) {
          console.error('Erro NF bot:', eNf.message);
          await wpp(num, 'Erro ao processar essa NF: ' + eNf.message);
        }
        return;
      }
      if (['imageMessage','documentMessage'].includes(tipo)) {
        const b64 = await getMidia(msg);
        if (!b64) { await wpp(num, 'Nao consegui baixar a imagem.'); return; }
        const r1 = await claude([{ role:'user', content:[
          tipo === 'documentMessage' ? { type:'document', source:{ type:'base64', media_type:'application/pdf', data:b64 } } : { type:'image', source:{ type:'base64', media_type: b64.startsWith('/9j/')||b64.startsWith('/9J/')?'image/jpeg':b64.startsWith('iVBORw')?'image/png':'image/jpeg', data:b64 } },
          { type:'text', text:'Leia este(s) comprovante(s) de pagamento. IGNORE COMPLETAMENTE quem e o pagador/remetente/origem - o pagador pode ser qualquer conta ou nome, isso NAO importa. Foque APENAS no campo de DESTINO do pagamento, que aparece estruturalmente como: "Favorecido", "Beneficiario", "Para", "Destino", "Recebedor", "Dados de destino > Nome", ou o estabelecimento/CNPJ cobrado em maquininha de cartao. ATENCAO CRITICA: o nome do destinatario NUNCA pode ser "Di Casa Gastronomia", "Di Casa Laranjinha" ou "Diogo Jose dos Santos Borges" - essa e a empresa que esta PAGANDO, nunca quem recebe. Se voce ler esse nome no campo de destino, procure de novo no documento ate achar o nome de quem REALMENTE recebeu (pode ser pessoa fisica, funcionario, fornecedor). ATENCAO 2: em PIX, o nome de uma INSTITUICAO FINANCEIRA/BANCO/COOPERATIVA DE CREDITO (qualquer nome contendo "Pagamentos S.A.", "Instituicao de Pagamento", "SICOOB", "Cooperativa de Credito", "CCLA", "S.A.", "S/A" quando aparece como o "banco/instituicao do recebedor", separado do nome real da pessoa/empresa) NUNCA e o destinatario - e so o banco/cooperativa que processa a transferencia. O destinatario real e a PESSOA FISICA ou EMPRESA dona da conta que recebeu o PIX (geralmente um nome de pessoa comum, tipo "RICARDO GAS", ou empresa comercial comum - NUNCA o nome de um banco/instituicao financeira/cooperativa). Se o documento mostrar separadamente "nome de quem recebeu" e "instituicao do recebedor", SEMPRE use o nome de quem recebeu, nunca a instituicao. Pode haver MAIS DE UM comprovante na mesma imagem/arquivo (ex: varios boletos enviados juntos pelo banco) - analise CADA UM separadamente. Para CADA comprovante encontrado, identifique: (1) VALOR: campo "Valor" ou "Total"; (2) NOME DE QUEM RECEBEU: o nome no campo de DESTINO (NAO o campo de origem/pagador/remetente, esse e irrelevante); (3) DATA E HORA (a hora exata, ex: 23:20); (4) TIPO: pix, credito, debito, boleto ou dinheiro; (5) OBSERVACAO se houver; (6) JUROS/MULTA: valor de juros ou multa SEPARADO do valor principal, se houver (comum em boleto pago com atraso - procure campos como "Juros", "Multa", "Encargos", ou "Valor pago" maior que "Valor do documento"). Liste CADA comprovante numerado (Comprovante 1, Comprovante 2...) com todos os campos em portugues.' }
        ]}], 3000);
        const analise = r1.content && r1.content[0] ? r1.content[0].text : 'Nao consegui extrair.';
        console.log('Analise:', analise.substring(0,150));
        const prompt2 = 'Extraia do texto abaixo APENAS JSON valido (sem markdown, sem comentarios). Texto: "' + analise + '". Pode haver UM ou VARIOS comprovantes - retorne SEMPRE um array, mesmo se for só 1. Formato: {"pagamentos":[{"valor":0.00,"valorJuros":0.00,"destinatario":"NOME COMPLETO no campo de DESTINO/beneficiario/favorecido - ignore completamente o campo de origem/pagador - NUNCA retorne Di Casa Gastronomia/Di Casa Laranjinha/Diogo Jose dos Santos Borges aqui, isso e sempre o pagador, nunca o destinatario - tambem NUNCA retorne nome de instituicao financeira/banco/cooperativa de credito (Nu Pagamentos, Stone, Mercado Pago, SICOOB, CCLA, qualquer S.A./S/A que seja banco/cooperativa), use o nome da PESSOA/EMPRESA dona da conta que recebeu (ex: se o documento mostra "nome de quem recebeu: RICARDO GAS" separado de "instituicao: tal SICOOB", use RICARDO GAS)","categoria":"escolha APENAS UMA, sem parenteses, exatamente uma destas strings curtas: 🥩 Matéria Prima / 👥 RH / Mão de Obra / 🔧 Manutenção / 💡 Energia / Utilidades / 🚚 Frete / Entregador / 🏢 Aluguel / Fixos / 📦 Embalagem / 🍺 Bebidas / Bar / 🧹 Limpeza / Higiene / 💳 Taxas / Impostos / 📱 Telecom / Internet / 🎤 Shows / Eventos / 🔄 Outros. REGRAS OBRIGATORIAS: (1) diaria, salario, freelancer, autonomo, vale, pagamento a pessoa fisica/funcionario = SEMPRE 👥 RH / Mão de Obra (nunca Fixos). (2) cantor, musico, banda, dj, show, evento, animacao = SEMPRE 🎤 Shows / Eventos (nunca RH, nunca Fixos, nunca Outros).","tipo":"pix|boleto|dinheiro|credito|debito|stone|cielo","data":"DD/MM/AAAA","hora":"HH:MM se houver, senao vazio","descricao":"motivo se houver"}]}. IMPORTANTE: valorJuros e o valor de JUROS/MULTA cobrado SEPARADAMENTE do valor principal. Se nao houver, valorJuros=0. Se nao identificar nenhum valor retorne {"pagamentos":[]}';
        const r2 = await claude([{ role:'user', content: prompt2 }], 4000);
        const texto2 = r2.content && r2.content[0] ? r2.content[0].text : '{}';
        const match = texto2.match(/\{[\s\S]*\}/);
        const lancamentosFeitos = [];
        let resultadoSalvo = null;
        if (match) {
          try {
            const d = JSON.parse(match[0]);
            const pagamentos = Array.isArray(d.pagamentos) ? d.pagamentos : (d.valor ? [d] : []);
            const reciboUrl2 = pagamentos.length ? await salvarReciboGitHub(b64, tipo) : null;
            for (const p of pagamentos) {
              if (!p.valor || p.valor <= 0) continue;
              const _raw = p.destinatario || p.descricao || '';
              const _prefixos = ['Pagamento para ','Para ','Favorecido: ','Beneficiário: ','Beneficiario: ','Recebedor: ','Destino: ','Pago para ','Pago a ','Transferência para ','Transferencia para '];
              let _dest = _raw;
              for (const pre of _prefixos) { if (_dest.toLowerCase().startsWith(pre.toLowerCase())) { _dest = _dest.slice(pre.length).trim(); break; } }
              const _desc = p.descricao && p.descricao !== p.destinatario && p.descricao !== 'SEM_DESCRICAO' ? p.descricao : '';
              const lanc = { valor: p.valor, categoria: p.categoria || 'Outros', descricao: _desc, destinatario: _dest, tipo: p.tipo || 'pix', data: p.data || new Date().toLocaleDateString('pt-BR'), hora: p.hora || '', confianca: 'alta', setor: 'Geral', origem: 'whatsapp' };
              // Deteccao automatica de diaria/salario/vale
              const _obsDesc = (lanc.descricao||'').toLowerCase();
              const _destDesc = (lanc.destinatario||'').toLowerCase();
              const _tipoRH = _obsDesc.includes('diaria') || _obsDesc.includes('diária') ? 'diaria'
                : _obsDesc.includes('salario') || _obsDesc.includes('salário') || _obsDesc.includes('pagamento') ? 'salario'
                : _obsDesc.includes('vale') ? 'vale'
                : _obsDesc.includes('bico') || _obsDesc.includes('ajudante') || _obsDesc.includes('diarista') ? 'diaria'
                : null;
              if (_tipoRH) {
                lanc.categoria = '👥 RH / Mão de Obra';
                lanc.setor = 'rh';
                const _nomeFunc = (lanc.destinatario||'').trim();
                const SB_RH = 'https://bxppiwshjyddiieazoqx.supabase.co';
                const SK_RH = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
                req2('GET', SB_RH+'/rest/v1/erp_sync?select=data,device_id&order=updated_at.desc&limit=1', null, {'apikey':SK_RH})
                  .then(rows => {
                    if (!Array.isArray(rows)||!rows.length) return;
                    const dd = JSON.parse(rows[0].data);
                    if (!dd.funcionarios) dd.funcionarios = [];
                    if (!dd.ponto) dd.ponto = {};
                    // Busca funcionario por nome aproximado
                    let funcEncontrado = dd.funcionarios.find(f => {
                      const fn = (f.nome||'').toLowerCase();
                      const dest = _nomeFunc.toLowerCase();
                      return fn && dest && (dest.includes(fn.split(' ')[0]) || fn.includes(dest.split(' ')[0]));
                    });
                    // Se nao encontrou e temos um nome, cadastra automaticamente
                    if (!funcEncontrado && _nomeFunc && _nomeFunc.length > 2) {
                      const novoId = 'func_bot_'+Date.now().toString(36);
                      const tipoFuncRH = _tipoRH === 'salario' ? 'mensalista' : 'diarista';
                      funcEncontrado = { id: novoId, nome: _nomeFunc, cargo: 'Funcionário', tipo: tipoFuncRH,
                        valorDia: _tipoRH === 'diaria' ? lanc.valor : 0, salario: _tipoRH === 'salario' ? lanc.valor : 0,
                        ativo: true, admissao: lanc.data || new Date().toLocaleDateString('pt-BR') };
                      dd.funcionarios.push(funcEncontrado);
                      console.log('Funcionario cadastrado automaticamente:', _nomeFunc);
                    }
                    if (funcEncontrado) {
                      const diaLanc = lanc.data || new Date().toLocaleDateString('pt-BR');
                      if (!dd.ponto[diaLanc]) dd.ponto[diaLanc] = {};
                      if (!dd.ponto[diaLanc][funcEncontrado.id]) dd.ponto[diaLanc][funcEncontrado.id] = {};
                      dd.ponto[diaLanc][funcEncontrado.id].presente = true;
                      dd.ponto[diaLanc][funcEncontrado.id].valorPago = lanc.valor;
                      dd.ponto[diaLanc][funcEncontrado.id].tipo = _tipoRH;
                      req2('POST', SB_RH+'/rest/v1/erp_sync',
                        { device_id: rows[0].device_id, data: JSON.stringify(dd) },
                        { 'apikey': SK_RH, 'Prefer': 'resolution=merge-duplicates', 'Content-Type': 'application/json' })
                        .then(()=>console.log('Ponto/funcionario atualizado:', funcEncontrado.nome, diaLanc, _tipoRH))
                        .catch(e=>console.log('Erro ponto auto:', e.message));
                    }
                  }).catch(()=>{});
              }
              lancamentosFeitos.push(lanc);
              if (p.valorJuros && p.valorJuros > 0) {
                const lancJuros = { valor: p.valorJuros, categoria: '⚠️ Juros / Multa', descricao: 'Juros/multa', destinatario: _dest + ' (juros)', tipo: lanc.tipo, data: lanc.data, confianca: 'alta', setor: 'Geral', origem: 'whatsapp' };
                lancamentosFeitos.push(lancJuros);
              }
            }
            resultadoSalvo = await salvarGitHubBatch(lancamentosFeitos, reciboUrl2);
          } catch(ep) { console.error('parse err:', ep.message); }
        }
        let resp = analise;
        if (!lancamentosFeitos.length) {
          resp += '\n\n⚠️ Nenhum valor identificado pra lancar.';
        }
        const ignorados = resultadoSalvo?.ignorados || 0;
        if (ignorados > 0) resp += '\n\n⏭️ ' + ignorados + ' ja lancado antes (ignorado).';
        await wpp(num, resp);
      }
    } catch(e) { console.error('Erro:', e.message); }
  });
});

server.listen(PORT, () => {
  console.log('Webhook v8 porta', PORT);
  console.log('API Key:', AKEY ? 'OK' : 'FALTA');
  console.log('GitHub Token:', GHTOKEN ? 'OK' : 'FALTA');
});


// ═══ DISPATCH DIÁRIO 6H — Balanço de ontem + Contas a Pagar de hoje ═══
let ultimoDispatchDia = '';
// Converte um Date para {ano,mes,dia} no fuso de Brasília, sem depender do fuso do servidor
function brDataPartes(d){
  const s = d.toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'}); // YYYY-MM-DD
  const [ano,mes,dia] = s.split('-').map(Number);
  return { ano, mes, dia };
}
function brDataStr(ano,mes,dia){
  return String(dia).padStart(2,'0')+'/'+String(mes).padStart(2,'0')+'/'+ano;
}
function brOrdinal(ano,mes,dia){
  return ano*10000+mes*100+dia;
}

async function executarDispatch(diaForcado){
  const agora = new Date();
  const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
  const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
  let r = null;
  try {
    const rows = await req2('GET', SB_URL+'/rest/v1/erp_sync?select=data,updated_at&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY});
    if (Array.isArray(rows) && rows.length && rows[0].data) r = JSON.parse(rows[0].data);
  } catch(eSb) { console.log('Erro ler Supabase, tentando GitHub:', eSb.message); }
  if (!r) {
    r = await req2('GET','https://raw.githubusercontent.com/'+REPO+'/dados/dre_sync.json?t='+Date.now(),null,{});
  }
  // Funde com a tabela lancamentos (novos lancamentos que ainda nao foram pro blob via Forcar Envio)
  try {
    // Busca lancamentos do mes atual E do mes anterior (cobre virada de mes)
    const _agora = new Date();
    const mesAtualISO = new Date(_agora.getFullYear(), _agora.getMonth(), 1).toISOString().slice(0,7);
    const mesAnteriorISO = new Date(_agora.getFullYear(), _agora.getMonth()-1, 1).toISOString().slice(0,7);
    const lancRows = await req2('GET', SB_URL+'/rest/v1/lancamentos?select=*&limit=5000', null, {'apikey':SB_KEY});
    console.log('lancamentos na tabela:', Array.isArray(lancRows) ? lancRows.length : 0);
    if (Array.isArray(lancRows) && lancRows.length) {
      if (!r) r = {};
      lancRows.forEach(l => {
        const dia = l.dia_comercial;
        if (!dia) return;
        if (!r[dia]) r[dia] = {r:[], c:[]};
        if (!r[dia].r) r[dia].r = [];
        if (!r[dia].c) r[dia].c = [];
        const jaExiste = [...r[dia].r, ...r[dia].c].some(x => x.id === l.id);
        if (!jaExiste) {
          const item = {id:l.id, d:l.descricao, v:Number(l.valor||0), cat:l.categoria, seg:l.segmento, dt:dia};
          if (l.tipo === 'receita') r[dia].r.push(item);
          else r[dia].c.push(item);
        }
      });
      console.log('Lancamentos fundidos do Supabase:', lancRows.length);
    }
  } catch(eLanc) { console.log('Erro ao fundir lancamentos:', eLanc.message); }
  if (!r || typeof r !== 'object') { console.log('Dispatch: sem dados ainda'); return {ok:false,erro:'sem dados disponiveis'}; }

  let anoOntem, mesOntem, diaOntemNum, ontemBR;
  if (diaForcado) {
    [diaOntemNum, mesOntem, anoOntem] = diaForcado.split('/').map(Number);
    ontemBR = diaForcado;
  } else {
    const ontemDate = new Date(agora.getTime() - 24*60*60*1000);
    const p = brDataPartes(ontemDate);
    anoOntem = p.ano; mesOntem = p.mes; diaOntemNum = p.dia;
    ontemBR = brDataStr(anoOntem, mesOntem, diaOntemNum);
  }
  const hojeP = brDataPartes(agora);
  const hojeOrdinal = brOrdinal(hojeP.ano, hojeP.mes, hojeP.dia);
  const destinos = ['5534996853258','5534997692282']; // Diogo, Herielly

  const diaOntem = r[ontemBR] || { r: [], c: [] };

  // Canais de venda (STi3/iFood) com ticket medio e investimento por loja, pra comparacao
  const canaisVenda = [];
  const sti3Entry = (diaOntem.r||[]).find(x=>x.fonte==='sti3');
  if (sti3Entry) canaisVenda.push({ nome: 'STi3/Balcao', vendas: sti3Entry.v||0, qtd: sti3Entry.qtdVendas||0, ticketMedio: sti3Entry.ticketMedio||0, loja: null });
  (diaOntem.r||[]).filter(x=>x.fonte==='ifood').forEach(x=>{
    canaisVenda.push({ nome: 'iFood', vendas: x.v||0, qtd: x.qtdVendas||0, ticketMedio: x.ticketMedio||0, loja: x._lojaIfood||null, investimentoIfood: (diaOntem._ifoodIncentivo&&x._lojaIfood)?(diaOntem._ifoodIncentivo[x._lojaIfood]||0):0 });
  });
  const receitaOntem = (diaOntem.r||[]).reduce((s,x)=>s+Number(x.v||0),0);
  const custoOntem = (diaOntem.c||[]).reduce((s,x)=>s+Number(x.v||0),0);
  const lucroOntem = receitaOntem - custoOntem;

  // Evolução dia a dia do mês (dia 1 até o dia do relatório) — tudo via Brasília, sem Date getters
  const diasDoMes = [];
  for (let d = 1; d <= diaOntemNum; d++) {
    const diaBRloop = brDataStr(anoOntem, mesOntem, d);
    const diaData = r[diaBRloop] || { r: [], c: [] };
    const rec = (diaData.r||[]).reduce((s,x)=>s+Number(x.v||0),0);
    const cus = (diaData.c||[]).reduce((s,x)=>s+Number(x.v||0),0);
    diasDoMes.push({ dia: d, receita: rec, custo: cus, resultado: rec - cus });
  }

  const segTotaisOntem = {};
  (diaOntem.r||[]).forEach(x=>{
    const segId = x.s || 'geral';
    if(!segTotaisOntem[segId]) segTotaisOntem[segId] = { nome: segId, icone: '', valor: 0, qtdPedidos: 0 };
    segTotaisOntem[segId].valor += Number(x.v||0);
    segTotaisOntem[segId].qtdPedidos += Number(x.qtdPedidos||0);
  });
  const catTotaisOntem = {};
  (diaOntem.c||[]).forEach(x=>{
    const cat = (x.cat||'Outros').split(' (')[0].trim();
    catTotaisOntem[cat] = (catTotaisOntem[cat]||0) + Number(x.v||0);
  });

  // Contas a pagar vencidas ou de hoje — comparacao por numero ordinal (sem Date), no fuso de Brasilia
  const contasPdf = (r.contasPagar||[]).filter(c=>{
    if(c.status!=='pendente')return false;
    const[d,m,y]=(c.vencimento||'').split('/').map(Number);
    if(!d)return false;
    return brOrdinal(y,m,d) <= hojeOrdinal;
  });

  // KPIs: CMV e RH (% sobre receita) — por palavra-chave, igual ao sistema
  function totalPorPalavras(catTotais, palavras){
    return Object.entries(catTotais).reduce((s,[cat,v])=>{
      const cl = cat.toLowerCase();
      return palavras.some(p=>cl.includes(p)) ? s+v : s;
    },0);
  }
  const custoMP = totalPorPalavras(catTotaisOntem, ['matéria','materia','embalagem']);
  const custoRH = totalPorPalavras(catTotaisOntem, ['rh','mão de obra','mao de obra','folha','diári','diaria','freelancer','autônomo','autonomo','salári','salario','funcionári','funcionario']);
  const cmvPct = receitaOntem > 0 ? (custoMP/receitaOntem*100) : 0;
  const rhPct = receitaOntem > 0 ? (custoRH/receitaOntem*100) : 0;

  // Melhor e pior dia do mes (entre os dias com movimento)
  const diasComMovimento = diasDoMes.filter(d=>d.receita>0||d.custo>0);
  const melhorDia = diasComMovimento.length ? diasComMovimento.reduce((a,b)=>b.receita>a.receita?b:a) : null;
  const piorDia = diasComMovimento.length ? diasComMovimento.reduce((a,b)=>b.receita<a.receita?b:a) : null;
  const diaMaiorCusto = diasComMovimento.length ? diasComMovimento.reduce((a,b)=>b.custo>a.custo?b:a) : null;
  const mediaResultadoMes = diasComMovimento.length ? diasComMovimento.reduce((s,d)=>s+d.resultado,0)/diasComMovimento.length : 0;

  let pdfBase64 = null, erroPdf = null;
  try {
    const pdfBuffer = await gerarPdfFechamento({
      diaBR: ontemBR, receita: receitaOntem, custo: custoOntem, resultado: lucroOntem,
      segTotais: segTotaisOntem, catTotais: catTotaisOntem,
      contasPagar: contasPdf, evolucaoMes: diasDoMes,
      cmvPct, rhPct, metaCmv: 35, metaRh: 30,
      melhorDia, piorDia, diaMaiorCusto, mediaResultadoMes, mesNome: mesOntem, anoMes: anoOntem, canaisVenda
    });
    pdfBase64 = pdfBuffer.toString('base64');
  } catch(ePdf) { erroPdf = ePdf.message; console.log('Erro gerar PDF dispatch:', ePdf.message); }

  if (pdfBase64) {
    for (const num of destinos) {
      await wppDocumento(num, pdfBase64, 'Fechamento_'+ontemBR.replace(/\//g,'-')+'.pdf', '📄 Relatório completo — '+ontemBR);
    }
  }
  console.log('✅ Dispatch (PDF) — ' + ontemBR + ' — receita:'+receitaOntem+' custo:'+custoOntem+' — hoje(BR):'+brDataStr(hojeP.ano,hojeP.mes,hojeP.dia));
  return { ok: !!pdfBase64, ontemBR, hojeBR: brDataStr(hojeP.ano,hojeP.mes,hojeP.dia), receitaOntem, custoOntem, lucroOntem, diasComDados: diasDoMes.filter(d=>d.receita>0||d.custo>0).length, erroPdf };
}


// ═══════════════════════════════════════════════════════════════
// ALERTA DE ESTOQUE BAIXO — checa diariamente e avisa via WhatsApp
// ═══════════════════════════════════════════════════════════════
async function checarEstoqueBaixo() {
  try {
    const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
    const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
    const rows = await req2('GET', SB_URL+'/rest/v1/erp_sync?select=data&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY});
    if (!Array.isArray(rows) || !rows.length) return;
    const d = JSON.parse(rows[0].data);
    const est = d.est || [];

    // Filtra produtos com estoque abaixo do mínimo definido
    const criticos = est.filter(p => {
      const min = Number(p.min || 0);
      const qtd = Number(p.q || 0);
      return min > 0 && qtd <= min;
    }).sort((a, b) => {
      // Ordena do mais crítico (zerado) para o menos critico
      const pctA = Number(a.q||0) / Number(a.min||1);
      const pctB = Number(b.q||0) / Number(b.min||1);
      return pctA - pctB;
    });

    if (criticos.length === 0) return;

    const destinos = ['5534996853258', '5534997692282'];
    const linhas = criticos.map(p => {
      const qtd = Number(p.q||0).toFixed(1);
      const min = Number(p.min||0).toFixed(1);
      const emoji = Number(p.q||0) === 0 ? '🔴' : '🟡';
      return `${emoji} ${p.n}: ${qtd} ${p.u||'un'} (mín: ${min})`;
    });

    const msg = "⚠️ *Estoque Baixo — Di Casa Laranjinha*\n\n" + linhas.join("\n") + "\n\n_Faça o pedido antes de acabar!_";
    for (const num of destinos) await wpp(num, msg);
    console.log('Alerta estoque baixo enviado:', criticos.length, 'produtos');
  } catch(e) { console.error('Erro checarEstoqueBaixo:', e.message); }
}



let _ultimoCaixaAlertado = null;
let _ultimoSaldoDia = '';
let _ifoodTokenCache = { token: null, expiresAt: 0 };
async function obterTokenIfood() {
  if (_ifoodTokenCache.token && Date.now() < _ifoodTokenCache.expiresAt) return _ifoodTokenCache.token;
  const clientId = process.env.IFOOD_CLIENT_ID;
  const clientSecret = process.env.IFOOD_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('IFOOD_CLIENT_ID/IFOOD_CLIENT_SECRET nao configurados no ambiente');
  const params = new URLSearchParams({ grantType: 'client_credentials', clientId, clientSecret }).toString();
  return new Promise((resolve, reject) => {
    const u = new URL('https://merchant-api.ifood.com.br/authentication/v1.0/oauth/token');
    const opts = { hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(params), 'accept': 'application/json' } };
    const r = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.accessToken) {
            _ifoodTokenCache.token = j.accessToken;
            _ifoodTokenCache.expiresAt = Date.now() + ((j.expiresIn || 10800) - 60) * 1000;
            resolve(j.accessToken);
          } else { reject(new Error('Resposta sem accessToken: ' + d)); }
        } catch (e) { reject(new Error('Erro ao parsear resposta do token: ' + d)); }
      });
    });
    r.on('error', reject);
    r.write(params);
    r.end();
  });
}

async function buscarFinancialEventsIfood(merchantId, beginDate, endDate, page) {
  const token = await obterTokenIfood();
  page = page || 1;
  const url = `https://merchant-api.ifood.com.br/financial/v3.0/merchants/${merchantId}/financial-events?beginDate=${beginDate}&endDate=${endDate}&page=${page}&size=100`;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = { hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token, 'x-request-homologation': 'true' } };
    const r = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({status: res.statusCode, body: JSON.parse(d)}); }
        catch(e) { resolve({status: res.statusCode, body: d}); }
      });
    });
    r.on('error', reject);
    r.end();
  });
}



// ═══════════════════════════════════════════════════════════════
// PARSER DE NF-e — descompacta docZip (GZIP+base64) e extrai dados
// ═══════════════════════════════════════════════════════════════
const zlib = require('zlib');

function descompactarDocZip(docZipBase64) {
  const buf = Buffer.from(docZipBase64, 'base64');
  try {
    return zlib.gunzipSync(buf).toString('utf-8');
  } catch(e) {
    return buf.toString('utf-8'); // ja descomprimido
  }
}

function extrairTagXML(xml, tag) {
  // Tenta com e sem namespace, com e sem atributos
  const patterns = [
    new RegExp('<'+tag+'\\s*>([^<]+)<\/'+tag+'>','i'),
    new RegExp('<[a-zA-Z0-9]*:?'+tag+'[^>]*>([^<]+)<\/[a-zA-Z0-9]*:?'+tag+'>','i'),
  ];
  for (const p of patterns) {
    const m = xml.match(p);
    if (m) return m[1].trim();
  }
  return '';
}

function parsearNFeXML(xml) {
  // Extrai dados principais da NF-e
  const emitente = extrairTagXML(xml, 'xNome') || extrairTagXML(xml, 'xFant');
  const cnpjEmit = extrairTagXML(xml, 'CNPJ');
  const nNF = extrairTagXML(xml, 'nNF');
  const dhEmi = extrairTagXML(xml, 'dhEmi');
  const vNF = parseFloat(extrairTagXML(xml, 'vNF') || '0');
  const vProd = parseFloat(extrairTagXML(xml, 'vProd') || '0');
  const chNFe = extrairTagXML(xml, 'chNFe');

  // Extrai itens
  const itens = [];
  const detMatches = xml.matchAll(/<det nItem="(\d+)">([\s\S]*?)<\/det>/g);
  for (const m of detMatches) {
    const det = m[2];
    const xProd = extrairTagXML(det, 'xProd');
    const qCom = parseFloat(extrairTagXML(det, 'qCom') || '1');
    const vUnCom = parseFloat(extrairTagXML(det, 'vUnCom') || '0');
    const vProdItem = parseFloat(extrairTagXML(det, 'vProd') || '0');
    const uCom = extrairTagXML(det, 'uCom');
    if (xProd) itens.push({ descricao: xProd, quantidade: qCom, unidade: uCom, valor_unitario: vUnCom, valor_total: vProdItem });
  }

  // Data formatada DD/MM/YYYY
  let dataFormatada = '';
  if (dhEmi) {
    const d = new Date(dhEmi);
    if (!isNaN(d)) dataFormatada = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  }

  // Vencimento (boleto)
  const dVenc = extrairTagXML(xml, 'dVenc');
  let vencFormatado = '';
  if (dVenc) {
    const d = new Date(dVenc);
    if (!isNaN(d)) vencFormatado = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  }

  return { emitente, cnpjEmit, nNF, chNFe, data: dataFormatada, vencimento: vencFormatado, valor: vNF || vProd, itens };
}

function parsearDocZips(xmlResp) {
  const nfes = [];
  const xmlNorm = xmlResp.replace(/\r?\n/g," ");
  const matches = xmlNorm.matchAll(/<docZip[^>]*schema="([^"]*)"[^>]*>([A-Za-z0-9+\/=\s]+)<\/docZip>/g);
  for (const m of matches) {
    const schema = m[1];
    const b64 = m[2].trim();
    if (!schema.includes('NFe') && !schema.includes('nfe')) continue;
    try {
      const xmlNFe = descompactarDocZip(b64);
      const dados = parsearNFeXML(xmlNFe);
      if (dados.valor > 0 || dados.emitente) nfes.push({ schema, ...dados });
    } catch(e) { console.log('Erro ao parsear docZip:', e.message); }
  }
  return nfes;
}


// ═══════════════════════════════════════════════════════════════
// MANIFESTAÇÃO DO DESTINATÁRIO — Ciência da Operação (ciente=210210)
// ═══════════════════════════════════════════════════════════════
async function manifestarCiencia(certPfx, senha, cnpj, chNFe, ambiente='prod') {
  const { certPem, keyPem } = carregarCertPFX(certPfx, senha);
  const cnpjLimpo = cnpj.replace(/[^\d]/g, '');
  const agora = new Date().toISOString().split('.')[0] + '-03:00';
  const nSeqEvento = '1';
  const xmlEvento = `<envEvento versao="1.00" xmlns="http://www.portalfiscal.inf.br/nfe"><idLote>1</idLote><evento versao="1.00"><infEvento Id="ID210210${chNFe}${nSeqEvento.padStart(2,'0')}"><cOrgao>91</cOrgao><tpAmb>${ambiente==='prod'?'1':'2'}</tpAmb><CNPJ>${cnpjLimpo}</CNPJ><chNFe>${chNFe}</chNFe><dhEvento>${agora}</dhEvento><tpEvento>210210</tpEvento><nSeqEvento>${nSeqEvento}</nSeqEvento><verEvento>1.00</verEvento><detEvento versao="1.00"><descEvento>Ciencia da Operacao</descEvento></detEvento></infEvento></evento></envEvento>`;
  const url = ambiente==='prod'
    ? 'https://www1.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx'
    : 'https://hom1.nfe.fazenda.gov.br/NFeRecepcaoEvento4/NFeRecepcaoEvento4.asmx';
  const soapEnv = `<?xml version="1.0" encoding="UTF-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><nfeRecepcaoEvento xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeRecepcaoEvento4"><nfeDadosMsg>${xmlEvento}</nfeDadosMsg></nfeRecepcaoEvento></soap12:Body></soap12:Envelope>`;
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const body = Buffer.from(soapEnv, 'utf8');
    const opts = { hostname: u.hostname, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': body.length },
      cert: certPem, key: keyPem, rejectUnauthorized: false };
    const r = https.request(opts, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, xml: d }));
    });
    r.on('error', reject); r.write(body); r.end();
  });
}



function detectarGrupoServidor(descricao){
 const d=(descricao||'').toLowerCase();
 // Verifica primeiro a memoria de categorias confirmadas (vem do Supabase)
 if(/(coca|pepsi|guarana|fanta|sprite|schweppes|refrigerante|refri|agua|suco|isotonic|energetic|red bull|heineken|skol|brahma|cervej|chopp|vinho|espumante|whisky|vodka|gin|rum|cachaca)/i.test(d))
  return{cat:'venda_direta',grupo:'Bebidas',icone:'🥤',catDRE:'🥤 Bebidas'};
 if(/(alcatra|picanha|maminha|fraldinha|contrafile|file mignon|patinho|coxao|lagarto|costela|bife|bovino|carne)/i.test(d))
  return{cat:'materia_prima',grupo:'Carnes Bovinas',icone:'🥩',catDRE:'🥩 Matéria Prima'};
 if(/(frango|peito|coxa|sobrecoxa|chester|peru)/i.test(d))
  return{cat:'materia_prima',grupo:'Aves',icone:'🐔',catDRE:'🥩 Matéria Prima'};
 if(/(suino|lombo|pernil|bacon|linguica|linguiça|salsicha|presunto|copa|porco)/i.test(d))
  return{cat:'materia_prima',grupo:'Carnes Suínas',icone:'🐖',catDRE:'🥩 Matéria Prima'};
 if(/(camarao|peixe|tilapia|salmon|atum|bacalhau|fruto do mar)/i.test(d))
  return{cat:'materia_prima',grupo:'Frutos do Mar',icone:'🐟',catDRE:'🥩 Matéria Prima'};
 if(/(tomate|cebola|alho|batata|abobrinha|cenoura|brocolis|couve|alface|rucula|pepino|pimentao|milho|feijao|hortalica|legume|verdura|fruta|banana|maca|laranja)/i.test(d))
  return{cat:'materia_prima',grupo:'Hortifrúti',icone:'🥦',catDRE:'🥩 Matéria Prima'};
 if(/(arroz|macarrao|farinha|amido|polenta|fuba|trigo|massa)/i.test(d))
  return{cat:'materia_prima',grupo:'Cereais e Grãos',icone:'🌾',catDRE:'🥩 Matéria Prima'};
 if(/(queijo|mussarela|parmesao|requeijao|creme de leite|leite|manteiga|margarina|iogurte)/i.test(d))
  return{cat:'materia_prima',grupo:'Laticínios',icone:'🧀',catDRE:'🥩 Matéria Prima'};
 if(/(oleo|azeite|gordura|banha)/i.test(d))
  return{cat:'materia_prima',grupo:'Óleos e Gorduras',icone:'🫙',catDRE:'🥩 Matéria Prima'};
 if(/(sal |pimenta|tempero|condimento|oregano|molho|ketchup|mostarda|maionese|vinagre|shoyu)/i.test(d))
  return{cat:'materia_prima',grupo:'Temperos',icone:'🧂',catDRE:'🥩 Matéria Prima'};
 if(/(embalagem|bandeja|saco|sacola|caixa de papel|canudo|garfo|colher|copo descart|prato descart|guardanapo|palito|isopor|aluminio|filme pvc)/i.test(d))
  return{cat:'limpeza_embalagem',grupo:'Embalagens',icone:'📦',catDRE:'📦 Embalagem'};
 if(/(detergente|sabao|sabão|desinfetante|sanitaria|cloro|alcool|multiuso|limpeza|desgordurante)/i.test(d))
  return{cat:'limpeza_embalagem',grupo:'Limpeza',icone:'🧴',catDRE:'🧹 Limpeza/Higiene'};
 if(/(luva|touca|avental|mascara|epi|uniforme)/i.test(d))
  return{cat:'limpeza_embalagem',grupo:'EPI',icone:'🧤',catDRE:'🧹 Limpeza/Higiene'};
 if(/(gas|botijao|lenha|carvao|gelo)/i.test(d))
  return{cat:'materia_prima',grupo:'Combustível/Insumo',icone:'🔥',catDRE:'🥩 Matéria Prima'};
 return{cat:'materia_prima',grupo:'Outros Insumos',icone:'📋',catDRE:'🥩 Matéria Prima'};
}


async function lancarContaPagarNFeSefaz(nfe, dados, SB_URL, SB_KEY) {
  // Se nao tiver vencimento, estima 30 dias
  if (!dados.vencimento) {
    const dataEmissao = dados.data || new Date().toLocaleDateString('pt-BR');
    const pts = dataEmissao.split('/');
    if (pts.length===3) {
      const base = new Date(Number(pts[2]), Number(pts[1])-1, parseInt(pts[0])+30);
      dados.vencimento = base.toLocaleDateString('pt-BR');
    } else {
      const base = new Date(); base.setDate(base.getDate()+30);
      dados.vencimento = base.toLocaleDateString('pt-BR');
    }
    console.log('SEFAZ: vencimento estimado 30 dias para '+dados.emitente+':', dados.vencimento);
  }

  const rows = await req2('GET', SB_URL+'/rest/v1/erp_sync?select=data,device_id&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY});
  if (!Array.isArray(rows) || !rows.length) return false;
  const d = JSON.parse(rows[0].data);
  const deviceId = rows[0].device_id || 'sefaz_auto';
  if (!d.contasPagar) d.contasPagar = [];

  const idConta = 'sefaz_cp_' + (nfe.chNFe || (nfe.emitente+nfe.valor+dados.nNF).replace(/\s/g,''));
  const jaExiste = d.contasPagar.some(cp => cp.id === idConta);
  if (jaExiste) return false;
  // Vencimento: usa o da NF ou estima 30 dias se nao tiver
  if (!dados.vencimento) {
    const dataEmissao = dados.data || new Date().toLocaleDateString('pt-BR');
    const [dd,mm,yy] = dataEmissao.split('/');
    const dtBase = new Date(yy, mm-1, parseInt(dd)+30);
    dados.vencimento = dtBase.toLocaleDateString('pt-BR');
    console.log('SEFAZ: vencimento estimado 30 dias:', dados.vencimento);
  }
  d.contasPagar.push({
    id: idConta,
    forn: dados.emitente || 'Fornecedor',
    val: dados.valor,
    valor: dados.valor,
    venc: dados.vencimento,
    vencimento: dados.vencimento,
    pag: 'boleto',
    pago: false,
    nf: dados.nNF || '',
    desc: 'NF ' + (dados.nNF||'') + ' - ' + (dados.emitente||'Fornecedor'),
    dt: dados.data || new Date().toLocaleDateString('pt-BR'),
    cat: 'Fornecedores',
    semana: '',
    _sefaz: true,
    criadoEm: new Date().toISOString()
  });

  // Salva o blob atualizado
  await req2('POST', SB_URL+'/rest/v1/erp_sync',
    { device_id: deviceId, data: JSON.stringify(d) },
    { 'apikey': SB_KEY, 'Prefer': 'resolution=merge-duplicates', 'Content-Type': 'application/json' });

  // Tambem grava na tabela contas_pagar_v2
  await req2('POST', SB_URL+'/rest/v1/contas_pagar_v2',
    { id: idConta, fornecedor: dados.emitente, valor: dados.valor, vencimento: dados.vencimento, nf: dados.nNF||'', pago: false, device_id: 'sefaz_auto' },
    { 'apikey': SB_KEY, 'Prefer': 'return=minimal,resolution=ignore-duplicates', 'Content-Type': 'application/json' }
  ).catch(()=>{});

  return true;
}

async function lancarEstoqueNFeSefaz(nfe, dados, SB_URL, SB_KEY) {
  // So lanca estoque se tiver itens (NF completa, ja manifestada)
  if (!dados.itens || dados.itens.length === 0) return 0;

  // Busca o blob atual do Supabase
  const rows = await req2('GET', SB_URL+'/rest/v1/erp_sync?select=data,device_id&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY});
  if (!Array.isArray(rows) || !rows.length) return 0;
  const d = JSON.parse(rows[0].data);
  const deviceId = rows[0].device_id || 'sefaz_auto';
  if (!d.est) d.est = [];

  let itensLancados = 0;
  for (const it of dados.itens) {
    const nome = it.descricao;
    const qtd = Number(it.quantidade) || 1;
    const cuUn = Number(it.valor_unitario) || 0;
    const nfNum = dados.nNF || nfe.chNFe || '';

    // Classifica o produto automaticamente por nome
    const grp = detectarGrupoServidor(nome);
    // Verifica se produto ja existe (busca por nome aproximado)
    const exIdx = d.est.findIndex(p => p.n && p.n.toLowerCase() === nome.toLowerCase());
    if (exIdx >= 0) {
      d.est[exIdx].q = (d.est[exIdx].q || 0) + qtd;
      d.est[exIdx].qi = (d.est[exIdx].qi || 0) + qtd;
      if (!d.est[exIdx].lotes) d.est[exIdx].lotes = [];
      d.est[exIdx].lotes.push({ qtdCx: qtd, qtdUn: qtd, cuPorCx: cuUn, cuPorUn: cuUn, dt: dados.data, nf: nfNum, _sefaz: true });
      d.est[exIdx].cuAnterior = d.est[exIdx].cu || cuUn;
      d.est[exIdx].cu = cuUn;
      if (!d.est[exIdx].grupo) d.est[exIdx].grupo = grp;
    } else {
      d.est.push({
        id: 'sefaz_' + Date.now() + '_' + itensLancados,
        n: nome, u: it.unidade || 'un', q: qtd, qi: qtd, qun: qtd, upc: 1,
        cu: cuUn, cuAnterior: cuUn, grupo: grp,
        lotes: [{ qtdCx: qtd, qtdUn: qtd, cuPorCx: cuUn, cuPorUn: cuUn, dt: dados.data, nf: nfNum, _sefaz: true }],
        min: 0, s: [], perdas: []
      });
    }

    // Grava movimento de estoque na tabela
    await req2('POST', SB_URL+'/rest/v1/movimentos_estoque',
      { id: 'sefaz_est_'+nfe.chNFe+'_'+itensLancados, produto: nome, tipo: 'entrada', quantidade: qtd, origem: 'NF '+nfNum+' SEFAZ', device_id: 'sefaz_auto' },
      { 'apikey': SB_KEY, 'Prefer': 'return=minimal,resolution=ignore-duplicates', 'Content-Type': 'application/json' }
    ).catch(() => {});

    itensLancados++;
  }

  // Salva o blob atualizado
  await req2('POST', SB_URL+'/rest/v1/erp_sync',
    { device_id: deviceId, data: JSON.stringify(d) },
    { 'apikey': SB_KEY, 'Prefer': 'resolution=merge-duplicates', 'Content-Type': 'application/json' });

  return itensLancados;
}

// ═══════════════════════════════════════════════════════════════
// SEFAZ — Consulta automática diária de NFs recebidas
// Roda 1x por dia às 3h da manhã, salva NSU no Supabase
// ═══════════════════════════════════════════════════════════════
let _sefazUltNSU = '000000000004755'; // NSU confirmado pela SEFAZ

async function consultarNFsRecebidas() {
  try {
    const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
    const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';

    // Busca o certificado do blob
    const rows = await req2('GET', SB_URL+'/rest/v1/erp_sync?select=data&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY});
    if (!Array.isArray(rows) || !rows.length) return;
    const d = JSON.parse(rows[0].data);
    const cert = d.dadosFiscais?.certificado;
    if (!cert?.pfxBase64) { console.log('SEFAZ: certificado não configurado'); return; }

    // Busca o ultimo NSU salvo
    let nsuAtual = d.sefazUltNSU || _sefazUltNSU;
    const todasNfesDados = [];
    let totalLotes = 0;
    const MAX_LOTES = 10; // Maximo de consultas por ciclo (respeita limite SEFAZ)

    // Loop: consulta ate pegar todos os documentos disponiveis
    while (totalLotes < MAX_LOTES) {
      totalLotes++;
      console.log('SEFAZ: lote', totalLotes, '- consultando NSU', nsuAtual);
      const r = await sefazDistribuicaoDFe(cert.pfxBase64, cert.senha, '44686412000100', nsuAtual, 'prod');

      const cStat = (r.xml.match(/<cStat>(\d+)<\/cStat>/) || [])[1] || '';
      const ultNSUResp = (r.xml.match(/<ultNSU>(\d+)<\/ultNSU>/) || [])[1] || '';
      const maxNSU = (r.xml.match(/<maxNSU>(\d+)<\/maxNSU>/) || [])[1] || '';
      console.log('SEFAZ lote', totalLotes, '- cStat:', cStat, 'ultNSU:', ultNSUResp, 'maxNSU:', maxNSU);

      if (cStat === '656') { console.log('SEFAZ: consumo indevido, parando'); break; }
      if (!ultNSUResp || ultNSUResp === '000000000000000') break;

      // Parseia documentos deste lote
      const loteNfes = parsearDocZips(r.xml);
      todasNfesDados.push(...loteNfes);

      // Atualiza NSU para proximo lote
      nsuAtual = ultNSUResp;

      // Se ultNSU == maxNSU, chegou ao fim — nao tem mais documentos
      if (!maxNSU || maxNSU === '000000000000000' || ultNSUResp === maxNSU) {
        console.log('SEFAZ: todos os documentos recuperados em', totalLotes, 'lote(s)');
        break;
      }

      // Pequena pausa entre lotes para nao sobrecarregar SEFAZ
      await new Promise(res => setTimeout(res, 2000));
    }

    // Salva o NSU mais recente
    if (nsuAtual !== (d.sefazUltNSU || _sefazUltNSU)) {
      d.sefazUltNSU = nsuAtual;
      _sefazUltNSU = nsuAtual;
    }

    // Parseia os docZips para extrair dados completos das NFs
    // Deduplica por chNFe — evita processar mesma NF de lotes diferentes
    const nfesVistas = new Set();
    const nfesDados = todasNfesDados.filter(nfe => {
      if (!nfe.chNFe) return true;
      if (nfesVistas.has(nfe.chNFe)) { console.log('SEFAZ: NF duplicada ignorada:', nfe.emitente); return false; }
      nfesVistas.add(nfe.chNFe); return true;
    });
    if (todasNfesDados.length !== nfesDados.length)
      console.log('SEFAZ: '+todasNfesDados.length+' NFs -> '+nfesDados.length+' unicas apos dedup');
    if (nfesDados.length > 0) {
      console.log('SEFAZ: encontradas', nfesDados.length, 'NFs novas com dados');
      const hoje = new Date().toLocaleDateString('pt-BR');
      for (const nfe of nfesDados) {
        const dia = nfe.data || hoje;
        // Sequencial — evita race condition: primeiro estoque, depois conta
        try {
          if (nfe.itens && nfe.itens.length > 0) {
            const n = await lancarEstoqueNFeSefaz(nfe, nfe, SB_URL, SB_KEY);
            if(n>0) console.log('Estoque: '+n+' itens lancados da NF '+nfe.nNF);
          }
          // Cria conta a pagar para TODA NF - se nao tem vencimento estima 30 dias
          if (!nfe.vencimento && nfe.data) {
            const pts = nfe.data.split('/');
            if (pts.length===3) {
              const base = new Date(pts[2], pts[1]-1, parseInt(pts[0])+30);
              nfe.vencimento = base.toLocaleDateString('pt-BR');
              console.log('SEFAZ: vencimento estimado 30 dias:', nfe.vencimento);
            }
          }
          const ok = await lancarContaPagarNFeSefaz(nfe, nfe, SB_URL, SB_KEY);
          if(ok) console.log('Conta a pagar: '+nfe.emitente+' venc.'+nfe.vencimento+' R$'+nfe.valor);
        } catch(eSeq) { console.log('Erro ao lancar NF:', eSeq.message); }
        // Manifesta ciência e consulta procNFe completo pela chave
        if (nfe.chNFe) {
          manifestarCiencia(cert.pfxBase64, cert.senha, '44686412000100', nfe.chNFe, 'prod')
            .then(async mr => {
              const cStat = (mr.xml.match(/<cStat>(\d+)<\/cStat>/)||[])[1];
              console.log('Manifestacao', nfe.chNFe.slice(0,10), 'cStat:', cStat);
              // Aguarda 3s e consulta o procNFe completo pela chave
              await new Promise(r=>setTimeout(r,3000));
              try {
                const proc = await consultarNFeByChave(cert.pfxBase64, cert.senha, '44686412000100', nfe.chNFe, 'prod');
                const nfesCompletas = parsearDocZips(proc.xml);
                for (const nfeC of nfesCompletas) {
                  if (!nfeC.chNFe) continue;
                  console.log('procNFe completo recebido:', nfeC.emitente, 'itens:', (nfeC.itens&&nfeC.itens.length)||0, 'venc:', nfeC.vencimento||'sem venc');
                  // Lanca estoque com itens reais
                  if (nfeC.itens && nfeC.itens.length > 0) {
                    const n = await lancarEstoqueNFeSefaz(nfeC, nfeC, SB_URL, SB_KEY);
                    if(n>0) console.log('Estoque: '+n+' itens reais da NF '+nfeC.nNF);
                  }
                  // Atualiza conta a pagar com vencimento real se estava estimado
                  if (nfeC.vencimento) {
                    const rowsUpd = await req2('GET', SB_URL+'/rest/v1/erp_sync?select=data,device_id&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY}).catch(()=>[]);
                    if (Array.isArray(rowsUpd)&&rowsUpd.length) {
                      const dUpd = JSON.parse(rowsUpd[0].data);
                      const cpUpd = (dUpd.contasPagar||[]).find(cp=>cp.id==='sefaz_cp_'+nfeC.chNFe);
                      if (cpUpd && cpUpd._estimado) {
                        cpUpd.venc = nfeC.vencimento;
                        cpUpd._estimado = false;
                        await req2('POST', SB_URL+'/rest/v1/erp_sync',
                          {device_id:rowsUpd[0].device_id, data:JSON.stringify(dUpd)},
                          {'apikey':SB_KEY,'Prefer':'resolution=merge-duplicates','Content-Type':'application/json'});
                        console.log('Vencimento real atualizado:', nfeC.vencimento, nfeC.emitente);
                      }
                    }
                  }
                }
              } catch(ep) { console.log('Erro consulta procNFe:', ep.message); }
            })
            .catch(e => console.log('Erro manifestacao:', e.message));
        }
        // Lança custo no DRE
        // ID robusto: usa chNFe se disponivel, senao gera por emitente+valor+data
        const _nfId = nfe.chNFe
          ? 'nf_'+nfe.chNFe
          : 'nf_'+Buffer.from((nfe.emitente||'')+nfe.valor+dia).toString('base64').slice(0,20);
        console.log('SEFAZ lancamento custo: id='+_nfId+' emitente='+nfe.emitente+' valor='+nfe.valor+' dia='+dia);
        await req2('POST', SB_URL+'/rest/v1/lancamentos',
          { id: _nfId, tipo: 'custo', dia_comercial: dia,
            descricao: `NF ${nfe.nNF||''} - ${nfe.emitente||'Fornecedor'}`,
            categoria: detectarGrupoServidor(nfe.emitente||'').catDRE || '🥩 Matéria Prima', segmento: null, valor: Number(nfe.valor||0),
            device_id: 'sefaz_auto' },
          { 'apikey': SB_KEY, 'Prefer': 'return=minimal,resolution=ignore-duplicates', 'Content-Type': 'application/json' }
        ).catch(()=>{});

        // Lança no estoque (se tem itens reais do procNFe)
        if (nfe.itens && nfe.itens.length > 0) {
          const n = await lancarEstoqueNFeSefaz(nfe, nfe, SB_URL, SB_KEY).catch(()=>0);
          if (n>0) console.log('Estoque: '+n+' itens lancados da NF '+nfe.nNF+' '+nfe.emitente);
        }

        // Cria conta a pagar (com vencimento estimado se necessário)
        if (!nfe.vencimento && nfe.data) {
          const pts = nfe.data.split('/');
          if (pts.length===3) {
            const base = new Date(pts[2], pts[1]-1, parseInt(pts[0])+30);
            nfe.vencimento = base.toLocaleDateString('pt-BR');
          }
        }
        const cpOk = await lancarContaPagarNFeSefaz(nfe, nfe, SB_URL, SB_KEY).catch(()=>false);
        if (cpOk) console.log('Conta a pagar: '+nfe.emitente+' venc.'+nfe.vencimento+' R$'+nfe.valor);

        // Manifesta ciência e consulta procNFe completo pela chave
        if (nfe.chNFe && cert && cert.pfxBase64) {
          manifestarCiencia(cert.pfxBase64, cert.senha, '44686412000100', nfe.chNFe, 'prod')
            .then(async mr => {
              const cStat = (mr.xml.match(/<cStat>(\d+)<\/cStat>/)||[])[1];
              console.log('Manifestacao', nfe.chNFe.slice(0,10), 'cStat:', cStat);
              await new Promise(r=>setTimeout(r,3000));
              try {
                const proc = await consultarNFeByChave(cert.pfxBase64, cert.senha, '44686412000100', nfe.chNFe, 'prod');
                const nfesCompletas = parsearDocZips(proc.xml);
                for (const nfeC of nfesCompletas) {
                  if (!nfeC.chNFe) continue;
                  console.log('procNFe completo:', nfeC.emitente, 'itens:', (nfeC.itens&&nfeC.itens.length)||0, 'venc:', nfeC.vencimento||'sem venc');
                  if (nfeC.itens && nfeC.itens.length > 0) {
                    const n2 = await lancarEstoqueNFeSefaz(nfeC, nfeC, SB_URL, SB_KEY).catch(()=>0);
                    if (n2>0) console.log('Estoque procNFe: '+n2+' itens reais da NF '+nfeC.nNF);
                  }
                  if (nfeC.vencimento) {
                    const rowsUpd = await req2('GET', SB_URL+'/rest/v1/erp_sync?select=data,device_id&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY}).catch(()=>[]);
                    if (Array.isArray(rowsUpd)&&rowsUpd.length) {
                      const dUpd = JSON.parse(rowsUpd[0].data);
                      const cpUpd = (dUpd.contasPagar||[]).find(cp=>cp.id==='sefaz_cp_'+nfeC.chNFe);
                      if (cpUpd && cpUpd._estimado) {
                        cpUpd.venc = nfeC.vencimento;
                        cpUpd._estimado = false;
                        await req2('POST', SB_URL+'/rest/v1/erp_sync',
                          {device_id:rowsUpd[0].device_id, data:JSON.stringify(dUpd)},
                          {'apikey':SB_KEY,'Prefer':'resolution=merge-duplicates','Content-Type':'application/json'}).catch(()=>{});
                        console.log('Vencimento real atualizado:', nfeC.vencimento, nfeC.emitente);
                      }
                    }
                  }
                }
              } catch(ep) { console.log('Erro consulta procNFe:', ep.message); }
            })
            .catch(e => console.log('Erro manifestacao:', e.message));
        }
      }
      // Notifica via WhatsApp apenas sobre NFs REALMENTE novas (não duplicatas)
      const idsExistentes = new Set();
      try {
        const lancExist = await req2('GET', SB_URL+'/rest/v1/lancamentos?select=id&device_id=eq.sefaz_auto&limit=500', null, {'apikey':SB_KEY});
        if (Array.isArray(lancExist)) lancExist.forEach(l => idsExistentes.add(l.id));
      } catch(e) {}
      const nfesNovas = nfesDados.filter(nfe => {
        const _id = 'nf_'+nfe.chNFe;
        return !idsExistentes.has(_id);
      });
      if (nfesNovas.length > 0) {
        const destinos = ['5534996853258','5534997692282'];
        const resumo = nfesNovas.map(n=>`• ${n.emitente||'?'} — R$${Number(n.valor||0).toFixed(2)}`).join('\n');
        for (const num of destinos) {
          await wpp(num, `📄 SEFAZ: ${nfesNovas.length} NF(s) nova(s):\n${resumo}\n\nLançado no sistema!`);
        }
      } else {
        console.log('SEFAZ: todas NFs ja existiam, sem notificacao');
      }
    }

    // NSU ja foi salvo no loop acima
  } catch(e) { console.error('SEFAZ consulta erro:', e.message); }
}


// ═══════════════════════════════════════════════════════════════
// RELATÓRIO SEMANAL EM PDF — toda segunda às 7h
// ═══════════════════════════════════════════════════════════════
async function gerarEnviarRelatorioPDF() {
  try {
    const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
    const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
    const brl = v => 'R$ '+Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});

    const rows = await req2('GET', SB_URL+'/rest/v1/erp_sync?select=data&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY});
    // Funde com tabela lancamentos
    let r = {};
    if (Array.isArray(rows) && rows.length) r = JSON.parse(rows[0].data);
    try {
      const lancRows = await req2('GET', SB_URL+'/rest/v1/lancamentos?select=*&order=created_at.desc&limit=2000', null, {'apikey':SB_KEY});
      if (Array.isArray(lancRows)) lancRows.forEach(l => {
        const dia = l.dia_comercial; if (!dia) return;
        if (!r[dia]) r[dia] = {r:[],c:[]};
        const jaExiste = [...(r[dia].r||[]),...(r[dia].c||[])].some(x=>x.id===l.id);
        if (!jaExiste) {
          const item = {id:l.id,d:l.descricao,v:Number(l.valor||0),cat:l.categoria,seg:l.segmento,dt:dia};
          if (l.tipo==='receita') r[dia].r.push(item); else r[dia].c.push(item);
        }
      });
    } catch(e) {}

    // Periodo: ultimos 7 dias
    const agora = new Date();
    const dias7 = [];
    for (let i=6;i>=0;i--) {
      const dt = new Date(agora); dt.setDate(dt.getDate()-i);
      dias7.push(String(dt.getDate()).padStart(2,'0')+'/'+String(dt.getMonth()+1).padStart(2,'0')+'/'+dt.getFullYear());
    }

    let rec=0,matPrima=0,rhCus=0,emb=0,fixo=0,juros=0,tarifas=0,taxas=0,outros=0;
    dias7.forEach(k => {
      const dia = r[k]||{r:[],c:[]};
      rec += (dia.r||[]).reduce((a,x)=>a+Number(x.v||0),0);
      (dia.c||[]).forEach(x => {
        const cat=(x.cat||'').toLowerCase(); const v=Number(x.v||0);
        if(cat.includes('materia')||cat.includes('insumo'))matPrima+=v;
        else if(cat.includes('rh')||cat.includes('mao de obra'))rhCus+=v;
        else if(cat.includes('embalagem'))emb+=v;
        else if(cat.includes('fixo')||cat.includes('aluguel'))fixo+=v;
        else if(cat.includes('juros')||cat.includes('multa'))juros+=v;
        else if(cat.includes('tarifa')||cat.includes('iof'))tarifas+=v;
        else if(cat.includes('taxa')||cat.includes('imposto'))taxas+=v;
        else outros+=v;
      });
    });
    const cusTot = matPrima+rhCus+emb+fixo+juros+tarifas+taxas+outros;
    const lucro = rec-cusTot;
    const marg = rec>0 ? ((lucro/rec)*100).toFixed(1) : '0';
    const cmv = rec>0 ? (((matPrima+emb)/rec)*100).toFixed(1) : '0';

    // Desempenho funcionarios
    const funcs = r.funcionarios||[];
    const ponto = r.ponto||{};
    const funcLinhas = funcs.filter(f=>f.ativo).map(f => {
      let dias=0, pago=0;
      dias7.forEach(k => { const reg=ponto[k]?.[f.id]; if(reg?.presente){dias++;pago+=Number(reg.valorPago||f.valorDia||0);} });
      return dias>0 ? '  '+f.nome+': '+dias+'d presente | Pago: '+brl(pago) : null;
    }).filter(Boolean);

    // Contas vencendo essa semana
    const contasSemana = (r.contasPagar||[]).filter(cp => !cp.pago && dias7.includes(cp.venc||cp.vencimento||''));
    const totalCP = contasSemana.reduce((a,c)=>a+Number(c.val||c.valor||0),0);

    const linhasMsg = [
      '*Relatorio Semanal Di Casa Laranjinha*',
      dias7[0]+' a '+dias7[6],
      '',
      '*Resultado:*',
      'Receita: '+brl(rec)
    ];
    if(matPrima>0)linhasMsg.push('Materia Prima: '+brl(matPrima)+' CMV:'+cmv+'%');
    if(rhCus>0)linhasMsg.push('RH: '+brl(rhCus));
    if(emb>0)linhasMsg.push('Embalagem: '+brl(emb));
    if(fixo>0)linhasMsg.push('Fixos: '+brl(fixo));
    if(juros>0)linhasMsg.push('Juros/Multa: '+brl(juros));
    if(tarifas>0)linhasMsg.push('Tarifas Bancarias: '+brl(tarifas));
    if(taxas>0)linhasMsg.push('Impostos: '+brl(taxas));
    linhasMsg.push('---');
    linhasMsg.push('*Lucro: '+brl(lucro)+' ('+marg+'%)*');
    if(funcLinhas.length>0){linhasMsg.push('');linhasMsg.push('*Funcionarios:*');funcLinhas.forEach(l=>linhasMsg.push(l));}
    if(contasSemana.length>0){linhasMsg.push('');linhasMsg.push('*Contas da semana:*');contasSemana.forEach(cp=>linhasMsg.push('  '+( cp.forn||'?')+': '+brl(Number(cp.val||cp.valor||0))));linhasMsg.push('Total: '+brl(totalCP));}
    linhasMsg.push('');linhasMsg.push('GestaoERP Di Casa Laranjinha');
    const msg = linhasMsg.join('\n');

    const destinos = ['5534996853258','5534997692282'];
    for (const num of destinos) await wpp(num, msg);
    console.log('Relatorio semanal enviado');
    return {ok:true};
  } catch(e) {
    console.error('Erro relatorio:', e.message);
    return {ok:false, erro:e.message};
  }
}



// ═══════════════════════════════════════════════════════════════
// INTEGRAÇÃO PLUGGY — Open Finance automático
// Puxa transações de todos os bancos conectados no Meu Pluggy
// ═══════════════════════════════════════════════════════════════
const PLUGGY_CLIENT_ID = process.env.PLUGGY_CLIENT_ID || '';
const PLUGGY_CLIENT_SECRET = process.env.PLUGGY_CLIENT_SECRET || '';
const PLUGGY_API_KEY_ENV = process.env.PLUGGY_API_KEY || '';
let _pluggyApiKey = null;
let _pluggyApiKeyExpiry = 0;

async function pluggyAuthFetch(method, path, body) {
  // Funcao dedicada para Pluggy usando fetch nativo (evita problemas do req2)
  const url = 'https://api.pluggy.ai' + path;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);

  // Auth: gera ou reusa token
  if (path !== '/auth') {
    if (!_pluggyApiKey || Date.now() >= _pluggyApiKeyExpiry) {
      const authResp = await pluggyAuthFetch('POST', '/auth', {
        clientId: PLUGGY_CLIENT_ID,
        clientSecret: PLUGGY_CLIENT_SECRET
      });
      _pluggyApiKey = authResp.apiKey;
      _pluggyApiKeyExpiry = Date.now() + 1.5 * 60 * 60 * 1000;
      console.log('Pluggy: novo token gerado, tamanho:', (_pluggyApiKey||'').length);
    }
    opts.headers['X-API-KEY'] = _pluggyApiKey;
  }

  const res = await fetch(url, opts);
  const text = await res.text();
  console.log('Pluggy', method, path, 'status:', res.status, 'resp:', text.substring(0, 300));
  try { return JSON.parse(text); } catch(e) { return { raw: text }; }
}

async function pluggyAuth() {
  if (_pluggyApiKey && Date.now() < _pluggyApiKeyExpiry) return _pluggyApiKey;
  await pluggyAuthFetch('POST', '/auth', {
    clientId: PLUGGY_CLIENT_ID,
    clientSecret: PLUGGY_CLIENT_SECRET
  });
  return _pluggyApiKey;
}

async function pluggyGet(path) {
  return pluggyAuthFetch('GET', path, null);
}



// Gera imagem saldos - canvas nao disponivel, usa texto formatado
async function gerarImagemSaldos(dados) {
  return null; // fallback para texto - canvas requer dependencias nativas
}

async function enviarSaldosBancarios() {
  try {
    const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
    const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
    const brl = v => 'R$ '+Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
    const pct = (v,t) => t ? Math.round(Math.abs(v/t)*100)+'%' : '0%';

    const rows = await req2('GET', SB_URL+'/rest/v1/erp_sync?select=data&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY});
    const d = Array.isArray(rows)&&rows.length ? JSON.parse(rows[0].data) : {};
    const itemIds = d.pluggyItemIds || [];
    if (!itemIds.length) { console.log('Saldos: nenhum itemId'); return; }

    const agora = new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});

    const contasVistas = new Set();
    const bancoConta = [];
    const cartoes = [];
    const investimentos = [];
    const cheques = [];

    const dataInicio7d = new Date(); dataInicio7d.setDate(dataInicio7d.getDate()-7);
    const fmtDate = d2 => d2.toISOString().slice(0,10);
    const fmtDia = s => s ? s.slice(0,10).split('-').reverse().join('/') : '';

    const nomeBancoMap = {
      'C6 BANK':'C6 Bank','C6':'C6 Bank','CAIXA':'Caixa Econômica Federal',
      'STONE':'Stone Pagamentos','SANTANDER':'Santander Empresas',
      'BANDEIRADO':'Bandeirado (Santander)','NUBANK':'Nubank','INTER':'Inter','SICOOB':'Sicoob'
    };
    const nomeBanco = (raw) => Object.entries(nomeBancoMap).find(([k])=>raw.toUpperCase().includes(k))?.[1] || raw || 'Banco';

    for (const itemId of itemIds) {
      const contas = await pluggyGet('/accounts?itemId='+itemId);
      if (!contas||!contas.results) continue;

      for (const conta of contas.results) {
        if (contasVistas.has(conta.id)) continue;
        contasVistas.add(conta.id);
        const nomeRaw = (conta.name||'').trim();
        const banco = nomeBanco(nomeRaw);
        const saldo = Number(conta.balance||0);
        const tipo = (conta.type||'').toUpperCase();

        if (tipo==='CREDIT') {
          // Busca limite do cartão
          const fat = await pluggyAuthFetch('GET','/credit-cards/'+conta.id).catch(()=>({}));
          const limite = Number(fat.creditLimit||fat.availableCreditLimit||0) + Math.abs(saldo);
          const utilizado = saldo > 0 ? saldo : Math.abs(saldo);
          const pctUsado = limite>0 ? Math.round(utilizado/limite*100) : 0;
          cartoes.push({banco, nomeRaw, saldo: utilizado, limite, pctUsado});
        } else {
          bancoConta.push({banco, saldo});
          // Busca cheques dos últimos 7 dias
          const txs = await pluggyGet('/transactions?accountId='+conta.id+'&from='+fmtDate(dataInicio7d)+'&to='+fmtDate(new Date())+'&pageSize=50');
          if (txs&&txs.results) {
            for (const tx of txs.results) {
              const desc = (tx.description||'').toLowerCase();
              const metodo = (tx.paymentData&&tx.paymentData.paymentMethod||'').toLowerCase();
              if (metodo.includes('check')||desc.includes('cheque')||desc.includes('saque din ag')) {
                cheques.push({banco, valor:Math.abs(Number(tx.amount||0)), dia:fmtDia(tx.date), tipo:Number(tx.amount||0)>0?'📥':'📤'});
              }
            }
          }
        }
      }

      // Investimentos
      const invs = await pluggyAuthFetch('GET','/investments?itemId='+itemId).catch(()=>({}));
      if (invs&&invs.results) {
        for (const inv of invs.results) {
          investimentos.push({nome:inv.name||'Renda Fixa', valor:Number(inv.value||inv.amount||0)});
        }
      }
    }

    // Monta mensagem
    const linhas = [];
    linhas.push('*📊 Di Casa Laranjinha*');
    linhas.push('_'+agora+'_');
    linhas.push('');

    // Contas bancárias
    const totalBanco = bancoConta.reduce((a,b)=>a+b.saldo,0);
    linhas.push('*🏦 Contas Bancárias: '+brl(totalBanco)+'*');
    bancoConta.forEach(c => {
      const alerta = c.saldo<0?' ⚠️':'';
      linhas.push('  • '+c.banco+': *'+brl(c.saldo)+'*'+alerta);
    });

    // Cartões de crédito
    if (cartoes.length) {
      linhas.push('');
      const totalCartao = cartoes.reduce((a,b)=>a+b.saldo,0);
      const totalLimite = cartoes.reduce((a,b)=>a+b.limite,0);
      const pctTotal = totalLimite>0?Math.round(totalCartao/totalLimite*100):0;
      linhas.push('*💳 Cartões: '+brl(totalCartao)+' ('+pctTotal+'% de '+brl(totalLimite)+')*');
      cartoes.forEach(c => {
        linhas.push('  • '+c.nomeRaw+': *'+brl(c.saldo)+'* ('+c.pctUsado+'% de '+brl(c.limite)+')');
      });
    }

    // Investimentos
    if (investimentos.length) {
      linhas.push('');
      const totalInv = investimentos.reduce((a,b)=>a+b.valor,0);
      linhas.push('*📈 Investimentos: '+brl(totalInv)+'*');
      linhas.push('  • Renda Fixa ('+investimentos.length+' ativos): *'+brl(totalInv)+'*');
    }

    // Cheques
    if (cheques.length) {
      linhas.push('');
      const totalCheques = cheques.reduce((a,c)=>a+c.valor,0);
      linhas.push('*🔖 Cheques (7 dias): '+brl(totalCheques)+'*');
      cheques.forEach(c => linhas.push('  '+c.tipo+' '+c.banco+': *'+brl(c.valor)+'* ('+c.dia+')'));
    }

    // DDA (quando disponível)
    const ddaPendentes = (d.contasPagar||[]).filter(cp=>cp._dda&&!cp.pago);
    if (ddaPendentes.length) {
      linhas.push('');
      const totalDDA = ddaPendentes.reduce((a,b)=>a+Number(b.val||0),0);
      linhas.push('*📬 Boletos DDA pendentes: '+brl(totalDDA)+'*');
      ddaPendentes.slice(0,5).forEach(cp => linhas.push('  • '+cp.forn+': *'+brl(cp.val)+'* venc '+cp.venc));
      if (ddaPendentes.length>5) linhas.push('  _...e mais '+(ddaPendentes.length-5)+' boletos_');
    }

    linhas.push('');
    linhas.push('*Saldo líquido: '+brl(totalBanco)+'*');

    // Gera imagem do card financeiro
    const imgBuffer = await gerarImagemSaldos({
      agora, bancoConta, cartoes, investimentos, cheques,
      ddaPendentes: (d.contasPagar||[]).filter(cp=>cp._dda&&!cp.pago)
    });

    const destinos = ['5534996853258','5534997692282'];
    const EVO_URL = 'https://evolution-api-latest-lrlv.onrender.com';
    const EVO_KEY = 'dicasalaranjinha2024';
    const INSTANCE = 'dicasalaranjinha';

    // Envia como texto (canvas indisponivel no Render Starter)
    const msg = linhas.join('\n');
    const destinos = ['5534996853258','5534997692282'];
    for (const num of destinos) await wpp(num, msg);
    console.log('Saldos enviados. Banco:'+totalBanco);
  } catch(e) {
    console.error('Erro saldos:', e.message);
  }
}


// ═══════════════════════════════════════════════════════════════
// CONCILIACAO BANCARIA PLUGGY
// 1. Puxa DDA/boletos pendentes → Contas a Pagar
// 2. Concilia transacoes pagas → baixa Contas a Pagar
// 3. Transacoes sem match → Estravio (para classificacao manual)
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// DDA — Domicílio Bancário de Cobrança
// Vincula boletos DDA às NFs da SEFAZ pelo CNPJ emitente
// ═══════════════════════════════════════════════════════════════
async function processarDDA() {
  try {
    const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
    const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
    const rows = await req2('GET', SB_URL+'/rest/v1/erp_sync?select=data,device_id&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY});
    if (!Array.isArray(rows)||!rows.length) return {ok:false};
    const d = JSON.parse(rows[0].data);
    const deviceId = rows[0].device_id;
    const itemIds = d.pluggyItemIds || [];
    if (!itemIds.length) return {ok:false, erro:'Sem itemIds'};

    if (!d.contasPagar) d.contasPagar = [];
    if (!d.estravio) d.estravio = [];
    if (!d.ddaBoletos) d.ddaBoletos = []; // historico de boletos DDA

    const fmtDia = s => s ? s.slice(0,10).split('-').reverse().join('/') : '';
    let novos=0, vinculados=0, estravio=0;

    for (const itemId of itemIds) {
      const contas = await pluggyAuthFetch('GET', '/accounts?itemId='+itemId).catch(()=>({}));
      if (!contas||!contas.results) continue;

      for (const conta of contas.results) {
        if ((conta.type||'').toUpperCase()==='CREDIT') continue;

        // Busca boletos DDA desta conta
        const pagAgend = await pluggyAuthFetch('GET', '/payment-schedules?accountId='+conta.id).catch(()=>({}));
        if (!pagAgend||!pagAgend.results||!pagAgend.results.length) continue;

        for (const bol of pagAgend.results) {
          const idBol = 'dda_'+bol.id;
          if (d.ddaBoletos.find(b=>b.id===idBol)) continue; // ja processado

          const valor = Math.abs(Number(bol.amount||0));
          const venc = fmtDia(bol.dueDate||bol.date);
          const cnpjEmit = (bol.beneficiary&&(bol.beneficiary.documentNumber||bol.beneficiary.taxNumber||''))||'';
          const nomeEmit = (bol.beneficiary&&bol.beneficiary.name||bol.description||'Boleto DDA').slice(0,50);
          const barCode = bol.barCode||bol.transactionCode||'';

          // Tenta vincular ao CNPJ de uma NF em contas a pagar
          const nfMatch = d.contasPagar.find(cp => {
            if (cp.pago || !cp._sefaz) return false;
            // Match por CNPJ emitente
            if (cnpjEmit && cp.cnpjEmit) {
              const cnpj1 = cnpjEmit.replace(/\D/g,'');
              const cnpj2 = (cp.cnpjEmit||'').replace(/\D/g,'');
              if (cnpj1 && cnpj2 && cnpj1===cnpj2) return true;
            }
            // Match por nome (fallback)
            const nome1 = (cp.forn||'').toLowerCase().slice(0,10);
            const nome2 = nomeEmit.toLowerCase().slice(0,10);
            return nome1 && nome2 && nome1===nome2;
          });

          if (nfMatch) {
            // ✅ VINCULADO — cria parcela de pagamento vinculada à NF
            const idParcela = 'dda_parcela_'+bol.id;
            if (!d.contasPagar.find(cp=>cp.id===idParcela)) {
              d.contasPagar.push({
                id: idParcela,
                forn: nomeEmit,
                val: valor,
                venc: venc,
                pago: false,
                cat: nfMatch.cat || '🥩 Matéria Prima',
                cnpjEmit: cnpjEmit,
                barCode: barCode,
                _dda: true,
                _nfId: nfMatch.id, // referencia à NF original
                _pluggy: true
              });
              vinculados++;
            }
          } else {
            // ❌ SEM NF CORRESPONDENTE — vai para estravio
            const idE = 'dda_estravio_'+bol.id;
            if (!d.estravio.find(e=>e.id===idE)) {
              d.estravio.push({
                id: idE,
                desc: nomeEmit,
                valor: valor,
                dia: venc,
                tipo: 'DDA/Boleto',
                cnpj: cnpjEmit,
                barCode: barCode,
                revisado: false,
                _dda: true
              });
              estravio++;
            }
          }

          d.ddaBoletos.push({id:idBol, processado: new Date().toISOString()});
          novos++;
        }
      }
    }

    // Limpa historico antigo (60 dias)
    const limite = new Date(); limite.setDate(limite.getDate()-60);
    d.ddaBoletos = (d.ddaBoletos||[]).slice(-500);

    await req2('POST', SB_URL+'/rest/v1/erp_sync',
      {device_id:deviceId, data:JSON.stringify(d)},
      {'apikey':SB_KEY, 'Prefer':'resolution=merge-duplicates', 'Content-Type':'application/json'});

    console.log('DDA: '+novos+' boletos, '+vinculados+' vinculados a NFs, '+estravio+' em estravio');
    return {ok:true, novos, vinculados, estravio};
  } catch(e) {
    console.error('DDA erro:', e.message);
    return {ok:false, erro:e.message};
  }
}

// ── DIAGNÓSTICO PLUGGY ──────────────────────────────────────
async function diagnosticoPluggy() {
  try {
    const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
    const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
    const rows = await req2('GET', SB_URL+'/rest/v1/erp_sync?select=data&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY});
    const d = Array.isArray(rows)&&rows.length ? JSON.parse(rows[0].data) : {};
    const itemIds = d.pluggyItemIds || [];
    const resultado = {itemIds, bancos:[], resumo:{}};

    for (const itemId of itemIds) {
      const info = await pluggyAuthFetch('GET', '/items/'+itemId).catch(()=>({}));
      const banco = {
        id: itemId,
        nome: (info.connector&&info.connector.name)||'?',
        status: info.status||'?',
        ultimaSync: info.lastUpdatedAt||'?',
        contas: []
      };
      const contas = await pluggyAuthFetch('GET', '/accounts?itemId='+itemId).catch(()=>({}));
      if (contas&&contas.results) {
        for (const ct of contas.results) {
          const hasDDA = await pluggyAuthFetch('GET', '/payment-schedules?accountId='+ct.id).catch(()=>({}));
          banco.contas.push({
            id: ct.id,
            nome: ct.name,
            tipo: ct.type,
            saldo: Number(ct.balance||0),
            moeda: ct.currencyCode||'BRL',
            temDDA: hasDDA&&hasDDA.results ? hasDDA.results.length : 0
          });
        }
      }
      resultado.bancos.push(banco);
    }
    resultado.resumo = {
      totalBancos: resultado.bancos.length,
      totalContas: resultado.bancos.reduce((a,b)=>a+b.contas.length,0),
      saldoTotal: resultado.bancos.reduce((a,b)=>a+b.contas.filter(c=>c.tipo!=='CREDIT').reduce((x,y)=>x+y.saldo,0),0),
      boletossDDA: resultado.bancos.reduce((a,b)=>a+b.contas.reduce((x,y)=>x+(y.temDDA||0),0),0)
    };
    return resultado;
  } catch(e) {
    return {ok:false, erro:e.message};
  }
}

async function conciliarPluggy() {
  try {
    const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
    const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';

    const rowsBlob = await req2('GET', SB_URL+'/rest/v1/erp_sync?select=data,device_id&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY});
    if (!Array.isArray(rowsBlob)||!rowsBlob.length) return {ok:false,erro:'Sem dados'};
    const d = JSON.parse(rowsBlob[0].data);
    const deviceId = rowsBlob[0].device_id;
    const pluggyItemIds = d.pluggyItemIds || [];
    if (!pluggyItemIds.length) return {ok:false, erro:'Sem itemIds. Conecte os bancos.'};

    if (!d.contasPagar) d.contasPagar = [];
    if (!d.estravio) d.estravio = [];

    const hoje = new Date();
    const dataInicio = new Date(hoje); dataInicio.setDate(hoje.getDate()-60);
    const fmtDate = dt => dt.toISOString().slice(0,10);
    const fmtDia = s => s ? s.slice(0,10).split('-').reverse().join('/') : '';

    let novosBoletosCP=0, boletosLow=0, estravio=0;

    for (const itemId of pluggyItemIds) {
      const itemInfo = await pluggyAuthFetch('GET', '/items/'+itemId).catch(()=>({}));
      const bancoNome = (itemInfo.connector&&itemInfo.connector.name)||'Banco';
      const contas = await pluggyAuthFetch('GET', '/accounts?itemId='+itemId).catch(()=>({}));
      if (!contas||!contas.results) continue;

      for (const conta of contas.results) {
        if ((conta.type||'').toUpperCase()==='CREDIT') continue; // pula cartao aqui

        // DDA desativado por ora — evita duplicacao com contas a pagar manuais
        // Será ativado como funcionalidade separada no futuro

        // ── 2. TRANSACOES — concilia e detecta estravio ──
        const txs = await pluggyAuthFetch('GET', '/transactions?accountId='+conta.id+'&from='+fmtDate(dataInicio)+'&to='+fmtDate(hoje)+'&pageSize=300').catch(()=>({}));
        if (!txs||!txs.results) continue;

        for (const tx of txs.results) {
          if (tx.type !== 'DEBIT') continue; // so debitos para conciliar
          const valor = Math.abs(Number(tx.amount||0));
          if (valor < 0.01) continue;
          const dia = fmtDia(tx.date);
          const payDest = tx.paymentData&&tx.paymentData.receiver&&tx.paymentData.receiver.name;
          const desc = (payDest||tx.description||'').trim();
          const isBoleto = (tx.paymentData&&tx.paymentData.paymentMethod==='BOLETO')||
                           (tx.description||'').toLowerCase().includes('boleto')||
                           (tx.description||'').toLowerCase().includes('pagto');

          // Tenta conciliar com conta a pagar existente
          // Match por: valor igual + (fornecedor similar OU codigo de barras)
          const cpMatch = d.contasPagar.find(cp => {
            if (cp.pago) return false;
            const mesmoValor = Math.abs(Number(cp.val||cp.valor||0)-valor) < 0.02;
            if (!mesmoValor) return false;
            // Verifica nome similar
            const fn = (cp.forn||'').toLowerCase();
            const dn = desc.toLowerCase();
            const nomeMatch = fn.length>3 && dn.length>3 && (fn.includes(dn.slice(0,8))||dn.includes(fn.slice(0,8)));
            // Verifica codigo de barras
            const barMatch = cp.codigoBarras && tx.paymentData && tx.paymentData.paymentMethod==='BOLETO';
            return nomeMatch || barMatch;
          });

          if (cpMatch) {
            // ✅ CONCILIADO — baixa a conta a pagar
            cpMatch.pago = true;
            cpMatch.dtPagamento = dia;
            cpMatch.vlPago = valor;
            boletosLow++;
            // Lanca no DRE se ainda nao existe
            const idLanc = 'pluggy_'+tx.id;
            await req2('POST', SB_URL+'/rest/v1/lancamentos',
              {id:idLanc, tipo:'custo', dia_comercial:dia, descricao:desc||cpMatch.forn, categoria:cpMatch.cat||'🔄 Outros', segmento:null, valor, device_id:'pluggy_auto'},
              {'apikey':SB_KEY, 'Prefer':'return=minimal,resolution=ignore-duplicates', 'Content-Type':'application/json'}
            ).catch(()=>{});
          } else if (isBoleto) {
            // ❓ BOLETO PAGO SEM MATCH — cria CP ja marcado como pago
            const idCP = 'pluggy_bolpago_'+tx.id;
            if (!d.contasPagar.find(cp=>cp.id===idCP)) {
              d.contasPagar.push({id:idCP, forn:desc||'Boleto pago', val:valor, venc:dia, pago:true, dtPagamento:dia, vlPago:valor, banco:bancoNome, _pluggy:true});
              await req2('POST', SB_URL+'/rest/v1/lancamentos',
                {id:'pluggy_'+tx.id, tipo:'custo', dia_comercial:dia, descricao:desc||'Boleto pago', categoria:classificarTransacao(desc,-valor), segmento:null, valor, device_id:'pluggy_auto'},
                {'apikey':SB_KEY, 'Prefer':'return=minimal,resolution=ignore-duplicates', 'Content-Type':'application/json'}
              ).catch(()=>{});
            }
          } else {
            // ❌ ESTRAVIO — transacao sem match, vai para classificacao manual
            const idE = 'pluggy_'+tx.id;
            const jaNaEstravio = d.estravio.find(e=>e.id===idE);
            // Verifica se ja lancado no DRE
            const lancRows = await req2('GET', SB_URL+'/rest/v1/lancamentos?id=eq.'+idE+'&select=id', null, {'apikey':SB_KEY}).catch(()=>[]);
            const jaNoDRE = Array.isArray(lancRows)&&lancRows.length>0;
            if (!jaNaEstravio && !jaNoDRE) {
              d.estravio.push({id:idE, desc, valor, dia, banco:bancoNome, conta:conta.name, tipo:tx.paymentData&&tx.paymentData.paymentMethod||tx.type, revisado:false});
              estravio++;
            }
          }
        }
      }
    }

    // Limpa estravio antigo (mais de 60 dias)
    const limite = new Date(); limite.setDate(limite.getDate()-60);
    d.estravio = (d.estravio||[]).filter(e => {
      if (!e.dia) return false;
      const [dd,mm,yy] = e.dia.split('/');
      return new Date(yy,mm-1,dd) >= limite;
    }).slice(-200); // max 200 itens

    // Salva blob atualizado
    await req2('POST', SB_URL+'/rest/v1/erp_sync',
      {device_id:deviceId, data:JSON.stringify(d)},
      {'apikey':SB_KEY, 'Prefer':'resolution=merge-duplicates', 'Content-Type':'application/json'}
    );

    console.log('Conciliacao Pluggy: '+novosBoletosCP+' boletos DDA, '+boletosLow+' conciliados, '+estravio+' em estravio');
    return {ok:true, novosBoletosCP, boletosLow, estravio};
  } catch(e) {
    console.error('Conciliacao erro:', e.message);
    return {ok:false, erro:e.message};
  }
}


// Classifica transação usando dados nativos do Pluggy (EN ou PT, paymentMethod + descrição)
function classificarTransacaoPluggy(tx) {
  const desc = (tx.description||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  const metodo = (tx.paymentData&&tx.paymentData.paymentMethod||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  const cat = (tx.category||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
  const valor = Number(tx.amount||0);

  // TRANSFERÊNCIA ENTRE CONTAS PRÓPRIAS — ignorar no DRE
  // EN: same person transfer | PT: transferencia da mesma pessoa
  if (cat.includes('same person') || cat.includes('mesma pessoa') ||
      desc.includes('transferencia | conta stone') ||
      desc.includes('transferencia | pedra de conta') ||
      (desc.includes('pix') && (desc.includes('diogo') || desc.includes('herielly')))) {
    return '__IGNORAR__';
  }

  // CHEQUE
  // EN: transfer - check | PT: transferencia - verificacao
  if (metodo.includes('check') || cat.includes('check') || cat.includes('verificac') ||
      desc.includes('cheque') || desc.includes('saque din ag cheque')) {
    return '🔖 Cheque Compensado';
  }

  // EMPRÉSTIMO / PARCELA
  // EN: loans and financing | PT: emprestimos e financiamento
  if (cat.includes('loans') || cat.includes('emprestimos') || cat.includes('financiamento') ||
      desc.includes('parcela') || desc.includes('emprestimo') || desc.includes('financiam')) {
    return '🏦 Empréstimo/Financiamento';
  }

  // INVESTIMENTO / RENDIMENTO
  // EN: proceeds interests and dividends | PT: rendimentos, juros e dividendos
  if (cat.includes('proceeds') || cat.includes('dividends') || cat.includes('rendimentos') ||
      desc.includes('rendimento') || desc.includes('aporte') || desc.includes('investimento')) {
    return valor > 0 ? '📈 Rendimento' : '📈 Aporte/Investimento';
  }

  // TARIFAS BANCÁRIAS
  if (desc.startsWith('tar ') || desc.includes('tarifa') || desc.includes('manut') ||
      desc.includes('anuidade') || desc.includes('mensalidade maquininha') ||
      desc.includes('ccf') || desc.includes('iof')) {
    if (desc.includes('iof')) return '💳 Taxas/Impostos';
    return '🏦 Tarifas Bancárias';
  }

  // JUROS / MULTA
  if (desc.includes('juro') || desc.includes('encargo') || desc.includes('cheque especial') ||
      desc.includes('multa')) return '⚠️ Juros/Multa';

  // PIX — descrição tem precedência sobre categoria (Pluggy às vezes classifica errado)
  // EN: healthcare | PT: assistencia medica — mas pode ser PIX classificado errado
  if (desc.includes('pix') || desc.startsWith('deb pix') || metodo.includes('pix')) {
    return valor > 0 ? '💰 PIX Recebido' : '🔄 PIX Enviado';
  }

  // CARTÃO
  if (metodo.includes('credit') || metodo.includes('debit') || cat.includes('cashback')) {
    return '💳 Cartão';
  }

  // SERVIÇOS / CUSTOS FIXOS
  // EN: services, digital services, entrepreneurial | PT: servicos, servicos digitais
  if (cat.includes('services') || cat.includes('servicos') || cat.includes('servico') ||
      cat.includes('entrepreneurial') || cat.includes('atividades empresariais')) {
    return '🏢 Custos Fixos';
  }

  // SAÚDE — geralmente PIX mal classificado
  // EN: healthcare | PT: assistencia medica
  if (cat.includes('healthcare') || cat.includes('assistencia medica') || cat.includes('saude')) {
    return '🏢 Custos Fixos';
  }

  // TED / DOC / TRANSFERÊNCIAS GERAIS
  if (cat.includes('transfers') || cat.includes('transferencias') || cat.includes('transfere')) {
    if (metodo.includes('ted')) return '🔄 Transferência TED';
    if (metodo.includes('doc')) return '🔄 Transferência DOC';
    return valor > 0 ? '💰 Transferência Recebida' : '🔄 Transferência';
  }

  // SAQUE
  if (desc.includes('saque') || desc.includes('sangria')) return '💵 Saque/Sangria';

  // RH
  if (desc.includes('salario') || desc.includes('folha') || desc.includes('diaria')) return '👥 RH / Mão de Obra';

  // BOLETO
  if (metodo.includes('boleto') || desc.includes('boleto') || desc.includes('pagto')) return '📄 Boleto Pago';

  return valor > 0 ? '💰 Receita/Transferência recebida' : '🔄 Outros';
}

async function importarTransacoesPluggy() {
  try {
    const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
    const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
    const rowsBlob = await req2('GET', SB_URL+'/rest/v1/erp_sync?select=data,device_id&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY});
    const blobData = Array.isArray(rowsBlob)&&rowsBlob.length ? JSON.parse(rowsBlob[0].data) : {};
    const deviceId = Array.isArray(rowsBlob)&&rowsBlob.length ? rowsBlob[0].device_id : 'pluggy_auto';
    const pluggyItemIds = blobData.pluggyItemIds || [];
    if (!pluggyItemIds.length) return {ok:false, erro:'Nenhum itemId. Acesse /pluggy-connect'};

    const hoje = new Date();
    const dataInicio = new Date(hoje); dataInicio.setDate(hoje.getDate()-30);
    const fmtDate = d => d.toISOString().slice(0,10);
    const fmtDia = s => s ? s.slice(0,10).split('-').reverse().join('/') : '';
    let totalTx=0, totalInv=0, blobAtualizado=false;

    for (const itemId of pluggyItemIds) {
      const itemInfo = await pluggyAuthFetch('GET', '/items/'+itemId).catch(()=>({}));
      const bancoNome = (itemInfo.connector && itemInfo.connector.name) || 'Banco';
      console.log('Pluggy processando:', bancoNome, itemId);

      // CONTAS + TRANSACOES
      const contas = await pluggyAuthFetch('GET', '/accounts?itemId='+itemId).catch(()=>({}));
      if (contas && contas.results) {
        for (const conta of contas.results) {
          const isCartao = (conta.type||'').toUpperCase()==='CREDIT';
          const txs = await pluggyAuthFetch('GET', '/transactions?accountId='+conta.id+'&from='+fmtDate(dataInicio)+'&to='+fmtDate(hoje)+'&pageSize=200').catch(()=>({}));
          if (txs && txs.results) {
            for (const tx of txs.results) {
              const valor = Math.abs(Number(tx.amount||0));
              if (valor < 0.01) continue;
              if (tx.type==='CREDIT') continue; // Ignora creditos - receitas vem do STi3/iFood
              const tipotx = 'custo';
              const dia = fmtDia(tx.date);
              if (!dia) continue;
              const payDest = tx.paymentData && tx.paymentData.receiver && tx.paymentData.receiver.name;
              const desc = (payDest || tx.description || tx.merchant && tx.merchant.businessName || bancoNome).slice(0,80).trim();
              const cat = classificarTransacaoPluggy(tx);
              if (cat === '__IGNORAR__') { console.log('Pluggy: ignorando transferencia propria:', desc.slice(0,40)); continue; }
              await req2('POST', SB_URL+'/rest/v1/lancamentos',
                {id:'pluggy_'+tx.id, tipo:tipotx, dia_comercial:dia, descricao:desc, categoria:cat, segmento:null, valor, device_id:'pluggy_auto'},
                {'apikey':SB_KEY, 'Prefer':'return=minimal,resolution=ignore-duplicates', 'Content-Type':'application/json'}
              ).catch(()=>{});
              totalTx++;
            }
          }
          // Fatura cartao
          if (isCartao) {
            const fat = await pluggyAuthFetch('GET', '/credit-cards/'+conta.id).catch(()=>({}));
            if (fat && fat.dueAmount > 0 && fat.dueDate) {
              if (!blobData.contasPagar) blobData.contasPagar = [];
              const idFat = 'pluggy_fat_'+conta.id;
              if (!blobData.contasPagar.find(cp=>cp.id===idFat)) {
                blobData.contasPagar.push({id:idFat, forn:bancoNome+' Fatura '+conta.name, val:fat.dueAmount, venc:fmtDia(fat.dueDate), pago:false, _pluggy:true});
                blobAtualizado = true;
              }
            }
          }
        }
      }

      // INVESTIMENTOS
      const invs = await pluggyAuthFetch('GET', '/investments?itemId='+itemId).catch(()=>({}));
      if (invs && invs.results && invs.results.length) {
        if (!blobData.investimentos) blobData.investimentos = [];
        for (const inv of invs.results) {
          const idInv = 'pluggy_inv_'+inv.id;
          const obj = {id:idInv, nome:inv.name||'Investimento', tipo:inv.type||'Renda Fixa', valor:Number(inv.value||inv.amount||0), banco:bancoNome, atualizado:hoje.toLocaleDateString('pt-BR')};
          const idx2 = blobData.investimentos.findIndex(x=>x.id===idInv);
          if (idx2>=0) blobData.investimentos[idx2]=obj; else blobData.investimentos.push(obj);
          totalInv++; blobAtualizado=true;
        }
      }
    }

    if (blobAtualizado) {
      await req2('POST', SB_URL+'/rest/v1/erp_sync', {device_id:deviceId, data:JSON.stringify(blobData)}, {'apikey':SB_KEY, 'Prefer':'resolution=merge-duplicates', 'Content-Type':'application/json'});
    }
    console.log('Pluggy: '+totalTx+' transacoes, '+totalInv+' investimentos importados');
    return {ok:true, transacoes:totalTx, investimentos:totalInv};
  } catch(e) {
    console.error('Pluggy erro:', e.message);
    return {ok:false, erro:e.message};
  }
}

// Roda Pluggy junto com a consulta SEFAZ às 3h
// (ja incluido no agendador de 30min)


// ═══════════════════════════════════════════════════════════════
// STi3 VIA WHATSAPP — processa Excel de vendas enviado no grupo
// Uso: envie o arquivo .xlsx com legenda "STi3" no grupo
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
// INTEGRAÇÃO IFOOD — Financial Events + Orders
// Client ID: caea67bb-0499-4cb6-836c-b5fd71a7a10e
// Ticket homologacao: #29512378
// ═══════════════════════════════════════════════════════════════
const IFOOD_CLIENT_ID = process.env.IFOOD_CLIENT_ID || 'caea67bb-0499-4cb6-836c-b5fd71a7a10e';
const IFOOD_CLIENT_SECRET = process.env.IFOOD_CLIENT_SECRET || '';
const IFOOD_BASE = 'https://merchant-api.ifood.com.br';
let _ifoodToken = null;
let _ifoodTokenExpiry = 0;

async function ifoodAuth() {
  if (_ifoodToken && Date.now() < _ifoodTokenExpiry) return _ifoodToken;
  if (!IFOOD_CLIENT_SECRET) throw new Error('IFOOD_CLIENT_SECRET nao configurado no Render');
  const body = 'grantType=client_credentials&clientId='+IFOOD_CLIENT_ID+'&clientSecret='+encodeURIComponent(IFOOD_CLIENT_SECRET);
  const r = await fetch(IFOOD_BASE+'/authentication/v1.0/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await r.json();
  if (!data.accessToken) throw new Error('iFood auth falhou: '+JSON.stringify(data).slice(0,200));
  _ifoodToken = data.accessToken;
  _ifoodTokenExpiry = Date.now() + (data.expiresIn||21600)*1000 - 300000; // 5min antes de expirar
  console.log('iFood: token obtido, expira em', data.expiresIn, 'segundos');
  return _ifoodToken;
}

async function ifoodGet(path, homologation=false) {
  const tok = await ifoodAuth();
  const headers = { 'Authorization': 'Bearer '+tok, 'Content-Type': 'application/json' };
  if (homologation) headers['x-request-homologation'] = 'true'; // modo teste
  const r = await fetch(IFOOD_BASE+path, { headers });
  const text = await r.text();
  console.log('iFood GET', path, 'status:', r.status, text.slice(0,200));
  try { return JSON.parse(text); } catch(e) { return { raw: text, status: r.status }; }
}

// Importa eventos financeiros do iFood (repasses, taxas, cancelamentos)
async function importarFinancialEventsIFood(merchantId, competencia) {
  try {
    const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
    const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
    const hoje = new Date();
    const comp = competencia || hoje.getFullYear()+'-'+String(hoje.getMonth()+1).padStart(2,'0');
    const fmtDia = s => s ? s.slice(0,10).split('-').reverse().join('/') : '';

    // Busca eventos financeiros com paginacao
    let page=1, totalImportados=0, hasNext=true;
    while(hasNext && page<=10) {
      const path = '/financial/v3.0/financial-events?merchantId='+merchantId+'&competence='+comp+'&page='+page+'&size=100';
      const resp = await ifoodGet(path);
      if (!resp || !resp.financialEvents) { console.log('iFood: sem eventos financeiros'); break; }

      for (const ev of resp.financialEvents) {
        if (!ev.hasTransferImpact) continue; // so eventos que impactam o repasse
        const valor = Math.abs(Number(ev.amount?.value||0));
        if (valor < 0.01) continue;
        const tipo = Number(ev.amount?.value||0) > 0 ? 'receita' : 'custo';
        const dia = fmtDia(ev.reference?.date||ev.period?.beginDate);
        if (!dia) continue;
        const desc = (ev.description||ev.name||'iFood').replace(/_/g,' ').toLowerCase().replace(/\w/g,c=>c.toUpperCase());
        const cat = tipo==='receita' ? '💰 Receita/Vendas' : (ev.name?.includes('COMMISSION')||ev.name?.includes('TAXA') ? '💳 Taxas/Impostos' : '🔄 Outros');
        const id = 'ifood_'+ev.reference?.id+'_'+ev.name;
        await req2('POST', SB_URL+'/rest/v1/lancamentos',
          { id, tipo, dia_comercial:dia, descricao:'iFood: '+desc, categoria:cat, segmento:'hamburgueria', valor, device_id:'ifood_auto' },
          { 'apikey':SB_KEY, 'Prefer':'return=minimal,resolution=ignore-duplicates', 'Content-Type':'application/json' }
        ).catch(()=>{});
        totalImportados++;
      }
      hasNext = resp.hasNextPage;
      page++;
    }

    // Busca repasses (settlements)
    const settl = await ifoodGet('/financial/v3.0/settlements?merchantId='+merchantId+'&beginDate='+comp+'-01&endDate='+comp+'-31');
    let proximoRepasse = null;
    if (settl && settl.balance !== undefined) {
      proximoRepasse = { saldo: settl.balance };
      console.log('iFood saldo:', settl.balance);
    }

    console.log('iFood: '+totalImportados+' eventos importados, competencia '+comp);
    return { ok:true, importados:totalImportados, competencia:comp, proximoRepasse };
  } catch(e) {
    console.error('iFood erro:', e.message);
    return { ok:false, erro:e.message };
  }
}

// Polling de pedidos iFood
async function pollingIFood(merchantId) {
  try {
    const events = await ifoodGet('/order/v1.0/events:polling?merchantId='+merchantId);
    if (!events || !Array.isArray(events)) return;
    console.log('iFood pedidos:', events.length, 'eventos');
    for (const ev of events) {
      console.log('iFood pedido:', ev.fullCode, ev.orderId?.slice(0,8));
      // Confirma recebimento
      await fetch(IFOOD_BASE+'/order/v1.0/events/acknowledgment', {
        method: 'POST',
        headers: { 'Authorization':'Bearer '+(await ifoodAuth()), 'Content-Type':'application/json' },
        body: JSON.stringify([{ id: ev.id }])
      }).catch(()=>{});
    }
    return events;
  } catch(e) {
    console.error('iFood polling erro:', e.message);
    return [];
  }
}

async function processarSTi3WhatsApp(msg, grupoId) {
  try {
    const XLSX = require('xlsx');
    const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
    const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
    const EVO_URL = 'https://evolution-api-latest-lrlv.onrender.com';
    const EVO_KEY = 'dicasalaranjinha2024';
    const INSTANCE = 'dicasalaranjinha';

    await wpp(grupoId, '📊 STi3 recebido! Processando vendas...');

    // Baixa o arquivo via Evolution API
    const msgId = msg.key?.id;
    if (!msgId) throw new Error('ID da mensagem não encontrado');

    const dlResp = await req2('POST', EVO_URL+'/chat/getBase64FromMediaMessage/'+INSTANCE,
      { message: { key: msg.key, message: msg.message } },
      { 'apikey': EVO_KEY, 'Content-Type': 'application/json' }
    );

    if (!dlResp || !dlResp.base64) throw new Error('Não foi possível baixar o arquivo');

    // Processa o Excel
    const buf = Buffer.from(dlResp.base64, 'base64');
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    // raw:true para preservar tipos nativos (Date objects, numbers)
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '', header: 1, raw: true });

    if (!rows || rows.length < 2) throw new Error('Arquivo vazio ou sem dados');

    // Log detalhado das primeiras linhas para debug
    console.log('STi3 WhatsApp: total linhas:', rows.length);
    rows.slice(0,5).forEach((r,i) => {
      const nv = r.map((v,j) => {
        if (!v && v!==0) return null;
        const tipo = v instanceof Date ? 'Date:'+v.toISOString().slice(0,10) : typeof v+':'+String(v).slice(0,20);
        return '['+j+']='+tipo;
      }).filter(Boolean);
      console.log('STi3 L'+i+':', nv.join(' | '));
    });

    // Detecta colunas buscando a linha onde col[0] = "Venda"
    let colData=-1, colValor=-1, colVenda=0, headerRow=-1;

    // Passo 1: encontra a linha de cabecalho onde col[0] = "Venda"
    for (let i=0; i<Math.min(50,rows.length); i++) {
      const r = rows[i]; if (!r) continue;
      const c0 = String(r[0]||'').trim().toLowerCase();
      if (c0 === 'venda' || c0 === 'nr venda' || c0 === 'nrvenda') {
        headerRow = i;
        // Busca Data e Valor NESSA linha especificamente
        for (let j=0; j<r.length; j++) {
          const cel = String(r[j]||'').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
          if (cel === 'data') { colData=j; }
          if (cel === 'valor') { colValor=j; }
          if (cel === 'venda') { colVenda=j; }
        }
        console.log('STi3: cabecalho na linha '+i+', colData='+colData+', colValor='+colValor);
        break;
      }
    }

    // Passo 2: se nao achou pelo cabecalho, busca por conteudo nas primeiras linhas de dados
    if (colData<0 || colValor<0) {
      const startBusca = headerRow>=0 ? headerRow+1 : 1;
      for (let i=startBusca; i<Math.min(startBusca+30,rows.length); i++) {
        const r = rows[i]; if (!r || r.length<5) continue;
        // Linha de dados valida: col[0] deve ser numero inteiro (nr venda)
        const c0num = Number(String(r[0]||'').replace('.','').trim());
        if (!Number.isInteger(c0num) || c0num<=0) continue;
        // Busca data
        for (let j=1; j<r.length; j++) {
          const v = r[j];
          if (colData<0) {
            if (v instanceof Date && !isNaN(v) && v.getFullYear()>2020) { colData=j; }
            else if (typeof v==='number' && v>40000 && v<60000) { colData=j; }
            else if (typeof v==='string' && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v.trim())) { colData=j; }
          }
        }
        // Busca valor: ultimo numero razoavel antes do fim da linha
        if (colData>=0) {
          for (let j=r.length-1; j>=1; j--) {
            const v = r[j];
            if (j===colData) continue;
            const n = typeof v==='number' ? v : parseFloat(String(v||'').replace(',','.'));
            if (!isNaN(n) && n>0.1 && n<100000) { colValor=j; break; }
          }
        }
        if (colData>=0 && colValor>=0) {
          console.log('STi3: colunas detectadas por conteudo linha '+i+', colData='+colData+', colValor='+colValor);
          if (headerRow<0) headerRow=i-1;
          break;
        }
      }
    }

    if (colData<0 || colValor<0) {
      // Log da estrutura para debug
      const amostra = rows.slice(0,10).map((r,i)=>'L'+i+':'+r.map((v,j)=>v?'['+j+']='+String(v).slice(0,12):null).filter(Boolean).join(','));
      console.log('STi3 estrutura:\n'+amostra.join('\n'));
      throw new Error('Colunas Data/Valor nao encontradas. Veja logs do Render.');
    }

    // Processa linhas
    const porDia = {};
    let erros=0, linhas=0;
    const startRow = headerRow>=0 ? headerRow+1 : 1;

    for (let i=startRow; i<rows.length; i++) {
      const r = rows[i];
      if (!r || r.length <= Math.max(colData,colValor)) continue;

      // Linha valida: col[0] deve ser numero inteiro (nr venda como 39730)
      const c0 = String(r[0]||'').replace(/\./g,'').trim();
      if (!c0 || isNaN(Number(c0)) || !Number.isInteger(Number(c0)) || Number(c0)<=0) continue;

      // Data
      let dataFmt = null;
      const dv = r[colData];
      if (dv instanceof Date && !isNaN(dv)) {
        // Date object - usar UTC para evitar problema de fuso
        dataFmt = String(dv.getUTCDate()).padStart(2,'0')+'/'+String(dv.getUTCMonth()+1).padStart(2,'0')+'/'+dv.getUTCFullYear();
      } else if (typeof dv==='number' && dv>40000 && dv<60000) {
        // Serial Excel
        const d = new Date(Math.round((dv-25569)*86400*1000));
        dataFmt = String(d.getUTCDate()).padStart(2,'0')+'/'+String(d.getUTCMonth()+1).padStart(2,'0')+'/'+d.getUTCFullYear();
      } else if (typeof dv==='string' && dv.trim()) {
        const s = dv.trim();
        // DD/MM/YYYY ou MM/DD/YYYY ou YYYY-MM-DD
        let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (m) {
          // Se o primeiro numero > 12, e o segundo <= 12, e DD/MM
          const a=Number(m[1]), b=Number(m[2]);
          if (a>12 && b<=12) dataFmt=m[1].padStart(2,'0')+'/'+m[2].padStart(2,'0')+'/'+m[3];
          else dataFmt=m[1].padStart(2,'0')+'/'+m[2].padStart(2,'0')+'/'+m[3]; // assume DD/MM
        }
        if (!m) { m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if(m) dataFmt=m[3]+'/'+m[2]+'/'+m[1]; }
        if (!m) { m = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/); if(m){const y=m[3].length===2?'20'+m[3]:m[3];dataFmt=m[1].padStart(2,'0')+'/'+m[2].padStart(2,'0')+'/'+y;} }
      }
      if (!dataFmt) { if(erros<3)console.log('STi3 data nao reconhecida linha',i,typeof dv,String(dv).slice(0,30)); erros++; continue; }

      // Valor
      let valor = r[colValor];
      if (typeof valor!=='number') valor = parseFloat(String(valor||'0').replace(/\./g,'').replace(',','.'));
      if (!valor || valor<=0) continue;

      if (!porDia[dataFmt]) porDia[dataFmt]=0;
      porDia[dataFmt] += valor;
      linhas++;
    }

    if (!linhas) throw new Error('Nenhuma venda encontrada. Erros de data: '+erros);

    // Grava na tabela lancamentos
    const diasImportados = Object.keys(porDia).sort();
    let gravados=0;
    for (const dia of diasImportados) {
      const idLanc = 'sti3_'+dia.replace(/\//g,'');
      await req2('POST', SB_URL+'/rest/v1/lancamentos',
        { id: idLanc, tipo:'receita', dia_comercial:dia, descricao:'STi3 Vendas',
          categoria:'💰 Receita/Vendas', segmento:'restaurante', valor:porDia[dia], device_id:'sti3_auto' },
        { 'apikey': SB_KEY, 'Prefer': 'return=minimal,resolution=ignore-duplicates', 'Content-Type': 'application/json' }
      ).catch(()=>{});
      gravados++;
    }

    // Atualiza o blob erp_sync com os totais diários — frontend lê isso na próxima sync
    const rowsBlob = await req2('GET', SB_URL+'/rest/v1/erp_sync?select=data,device_id&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY}).catch(()=>[]);
    const blobData = Array.isArray(rowsBlob)&&rowsBlob.length ? JSON.parse(rowsBlob[0].data) : {};
    const blobDeviceId = Array.isArray(rowsBlob)&&rowsBlob.length ? rowsBlob[0].device_id : 'sti3_server';
    // Mescla cada dia no blob (preserva outros dados existentes)
    for (const dia of diasImportados) {
      if (!blobData[dia]) blobData[dia] = { r:[], c:[] };
      if (!blobData[dia].r) blobData[dia].r = [];
      // Remove sti3 antigo desse dia e adiciona o novo
      blobData[dia].r = blobData[dia].r.filter(x => x.fonte !== 'sti3');
      blobData[dia].r.push({
        id: 'sti3_'+dia.replace(/\//g,''),
        d: 'STi3 Vendas', s: 'restaurante',
        v: porDia[dia], cat: '💰 Receita/Vendas', fonte: 'sti3'
      });
    }
    await req2('POST', SB_URL+'/rest/v1/erp_sync',
      { device_id: 'sti3_server', data: JSON.stringify(blobData) },
      { 'apikey': SB_KEY, 'Prefer': 'resolution=merge-duplicates', 'Content-Type': 'application/json' }
    ).catch(()=>{});
    console.log('STi3: blob erp_sync atualizado com '+gravados+' dias');

    const total = Object.values(porDia).reduce((a,b)=>a+b,0);
    const meses = [...new Set(diasImportados.map(d=>d.slice(3)))];
    const msg_ok = '✅ *STi3 importado com sucesso!*\n'+
      '• '+linhas+' vendas processadas\n'+
      '• '+gravados+' dias gravados\n'+
      '• Período: '+diasImportados[0]+' a '+diasImportados[diasImportados.length-1]+'\n'+
      '• Meses: '+meses.join(', ')+'\n'+
      '• *Total: R$ '+total.toLocaleString('pt-BR',{minimumFractionDigits:2})+'*\n'+
      (erros>0 ? '• ⚠️ '+erros+' linhas ignoradas (sem data)' : '');

    await wpp(grupoId, msg_ok);
    console.log('STi3 WhatsApp: '+linhas+' vendas, '+gravados+' dias, total R$'+total.toFixed(2));
    return { ok:true, linhas, dias:gravados, total };
  } catch(e) {
    console.error('STi3 WhatsApp erro:', e.message);
    await wpp(grupoId, '❌ Erro ao processar STi3: '+e.message);
    return { ok:false, erro:e.message };
  }
}

// Verificacao a cada 30min — sobrevive a restarts do servidor
// Roda SEFAZ às 3h, alertas de contas às 7h, alertas de estoque às 8h e 14h
let _ultimoSefazDia = '';
let _ultimoContasDia = '';
let _ultimoEstoqueDia = '';
let _ultimoEstoque14hDia = '';
setInterval(() => {
  const agora = new Date();
  const hUTC = agora.getUTCHours();
  const diaKey = agora.toISOString().slice(0,10);
  // SEFAZ + Pluggy às 3h Brasilia = 6h UTC
  if (hUTC === 6 && _ultimoSefazDia !== diaKey) {
    _ultimoSefazDia = diaKey;
    console.log('SEFAZ: rodando consulta automatica', diaKey);
    consultarNFsRecebidas().catch(e=>console.error('SEFAZ erro:', e.message));
    if (PLUGGY_CLIENT_ID && PLUGGY_CLIENT_SECRET) {
      importarTransacoesPluggy().catch(e=>console.error('Pluggy erro:', e.message));
      conciliarPluggy().catch(e=>console.error('Conciliacao erro:', e.message));
      processarDDA().catch(e=>console.error('DDA erro:', e.message));
    }
    if (IFOOD_CLIENT_SECRET) {
      const IFOOD_MERCHANT = process.env.IFOOD_MERCHANT_ID || '';
      if (IFOOD_MERCHANT) importarFinancialEventsIFood(IFOOD_MERCHANT).catch(e=>console.error('iFood erro:', e.message));
    }
  }
  // Todos os dias às 7h Brasilia = 10h UTC — alertas de contas
  if (hUTC === 10 && _ultimoContasDia !== diaKey) {
    _ultimoContasDia = diaKey;
    // Alerta de contas vencendo (inline - funcao foi removida)
    (async () => {
      try {
        const SB2='https://bxppiwshjyddiieazoqx.supabase.co';
        const SK2='sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
        const r2=await req2('GET',SB2+'/rest/v1/erp_sync?select=data&order=updated_at.desc&limit=1',null,{'apikey':SK2});
        const d2=Array.isArray(r2)&&r2.length?JSON.parse(r2[0].data):{};
        const cp=(d2.contasPagar||[]).filter(c=>!c.pago);
        const hoje2=new Date();
        const vencHoje=[], vencAmanha=[], venc3dias=[];
        for(const c of cp){
          if(!c.venc)continue;
          const pts=c.venc.split('/');
          if(pts.length!==3)continue;
          const dv=new Date(Number(pts[2]),Number(pts[1])-1,parseInt(pts[0]));
          const diff=Math.round((dv-hoje2)/(1000*86400));
          if(diff===0)vencHoje.push(c);
          else if(diff===1)vencAmanha.push(c);
          else if(diff<=3&&diff>1)venc3dias.push(c);
        }
        const brl2=v=>'R$ '+Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2});
        if(vencHoje.length||vencAmanha.length||venc3dias.length){
          let linhasAlerta=['*Contas vencendo:*'];
          if(vencHoje.length){linhasAlerta.push('*Hoje:*');vencHoje.forEach(c=>linhasAlerta.push('  - '+c.forn+': '+brl2(c.val||c.valor)));}
          if(vencAmanha.length){linhasAlerta.push('*Amanha:*');vencAmanha.forEach(c=>linhasAlerta.push('  - '+c.forn+': '+brl2(c.val||c.valor)));}
          if(venc3dias.length){linhasAlerta.push('*Em 3 dias:*');venc3dias.forEach(c=>linhasAlerta.push('  - '+c.forn+': '+brl2(c.val||c.valor)));}
          var msg=linhasAlerta.join('\n');
          for(const num of ['5534996853258','5534997692282']) await wpp(num,msg).catch(()=>{});
        }
      } catch(e2){console.log('Contas vencendo err:',e2.message);}
    })();
    // Segunda-feira: envia relatório semanal também
    if (agora.getUTCDay() === 1) gerarEnviarRelatorioPDF().catch(()=>{});
  }
  // Fallback: se webhook nao disparou ate 11h Brasilia (14h UTC), envia saldos mesmo assim
  if (hUTC === 14 && _ultimoSaldoDia !== diaKey) {
    _ultimoSaldoDia = diaKey;
    console.log('Agendador: fallback saldos (webhook nao disparou)', diaKey);
    if (PLUGGY_CLIENT_ID && PLUGGY_CLIENT_SECRET) {
      enviarSaldosBancarios().catch(e=>console.error('Saldos fallback erro:', e.message));
    }
  }
  // Estoque às 8h Brasilia = 11h UTC
  if (hUTC === 11 && _ultimoEstoqueDia !== diaKey) {
    _ultimoEstoqueDia = diaKey;
    checarEstoqueBaixo().catch(()=>{});
  }
  // Estoque às 14h Brasilia = 17h UTC
  if (hUTC === 17 && _ultimoEstoque14hDia !== diaKey) {
    _ultimoEstoque14hDia = diaKey;
    checarEstoqueBaixo().catch(()=>{});
  }
}, 30 * 60 * 1000); // a cada 30 minutos
console.log('Agendador iniciado — verifica a cada 30min');

async function checarCaixaAberto6h(){
  try{
    const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
    const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
    const rows = await req2('GET', SB_URL+'/rest/v1/sessoes_caixa?status=eq.aberto&order=abertura_em.desc&limit=1', null, {'apikey':SB_KEY});
    if (!Array.isArray(rows) || !rows.length) return;
    const caixa = rows[0];
    const horasAberto = (Date.now() - new Date(caixa.abertura_em).getTime()) / 3600000;
    if (horasAberto < 6) return;
    if (_ultimoCaixaAlertado === caixa.id) return; // ja avisou desse caixa, nao repete
    _ultimoCaixaAlertado = caixa.id;
    const destinos = ['5534996853258','5534997692282'];
    const msg = `⚠️ Caixa aberto há ${horasAberto.toFixed(1)}h (desde ${new Date(caixa.abertura_em).toLocaleString('pt-BR')}). Esqueceu de fechar?`;
    for (const num of destinos) await wpp(num, msg);
  }catch(e){ console.error('Erro checarCaixaAberto6h:', e.message); }
}
setInterval(checarCaixaAberto6h, 600000); // checa a cada 10 minutos

async function checarDispatchDiario(){
  try{
    const agora = new Date();
    const brHora = agora.toLocaleString('en-US',{timeZone:'America/Sao_Paulo',hour12:false,hour:'2-digit',minute:'2-digit'});
    const brDataChave = agora.toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
    if (brHora !== '06:00') return;
    if (ultimoDispatchDia === brDataChave) return;
    ultimoDispatchDia = brDataChave;
    await executarDispatch();
  } catch(e) { console.log('Erro dispatch diario:', e.message); }
}
setInterval(checarDispatchDiario, 60000);
