
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
          const ct = await pluggyAuthFetch('POST', '/connect_token', { clientUserId: 'dicasalaranjinha' });
          console.log('Connect token response:', JSON.stringify(ct).substring(0,300));
          const connectToken = ct.accessToken || ct.token || ct.connectToken || '';
          if (!connectToken) {
            res.writeHead(200,{'Content-Type':'text/plain'});
            res.end('Erro ao gerar connect token: '+JSON.stringify(ct));
            return;
          }
          const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conectar Bancos — Di Casa Laranjinha</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0f;">
<iframe 
  src="https://connect.pluggy.ai?token=${connectToken}&theme=dark"
  style="width:100%;height:100vh;border:none;"
  allow="camera; microphone; geolocation"
  title="Pluggy Connect">
</iframe>
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
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ultimoGrupoId: global._ultimoGrupoId||null}));
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
    const lancRows = await req2('GET', SB_URL+'/rest/v1/lancamentos?select=*&order=created_at.desc&limit=2000', null, {'apikey':SB_KEY});
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
  // So lanca conta a pagar se tiver vencimento (boleto)
  if (!dados.vencimento) return false;

  const rows = await req2('GET', SB_URL+'/rest/v1/erp_sync?select=data,device_id&order=updated_at.desc&limit=1', null, {'apikey':SB_KEY});
  if (!Array.isArray(rows) || !rows.length) return false;
  const d = JSON.parse(rows[0].data);
  const deviceId = rows[0].device_id || 'sefaz_auto';
  if (!d.contasPagar) d.contasPagar = [];

  // Evita duplicar conta da mesma NF (usa chNFe que e unico)
  const idConta = 'sefaz_cp_' + nfe.chNFe;
  const jaExiste = d.contasPagar.some(cp => cp.id === idConta);
  if (jaExiste) return false;
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
    const nfesDados = todasNfesDados;
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
          if (nfe.vencimento) {
            const ok = await lancarContaPagarNFeSefaz(nfe, nfe, SB_URL, SB_KEY);
            if(ok) console.log('Conta a pagar: '+nfe.emitente+' venc.'+nfe.vencimento+' R$'+nfe.valor);
          }
        } catch(eSeq) { console.log('Erro ao lancar NF:', eSeq.message); }
        // Manifesta ciência automaticamente para receber XML completo na próxima consulta
        if (nfe.chNFe) {
          manifestarCiencia(cert.pfxBase64, cert.senha, '44686412000100', nfe.chNFe, 'prod')
            .then(mr => console.log('Manifestação', nfe.chNFe.substring(0,10)+'...', 'cStat:', (mr.xml.match(/<cStat>(\d+)<\/cStat>/)||[])[1]))
            .catch(e => console.log('Erro manifestação:', e.message));
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
      }
      // Notifica via WhatsApp com resumo
      const destinos = ['5534996853258','5534997692282'];
      const resumo = nfesDados.map(n=>`• ${n.emitente||'?'} — R$${n.valor.toFixed(2)}`).join('\n');
      for (const num of destinos) {
        await wpp(num, `📄 SEFAZ: ${nfesDados.length} NF(s) nova(s) recebida(s):\n${resumo}\n\nDados lançados automaticamente no sistema!`);
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

async function importarTransacoesPluggy() {
  try {
    const SB_URL = 'https://bxppiwshjyddiieazoqx.supabase.co';
    const SB_KEY = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
    const brl = v => Number(v||0).toFixed(2);

    // Lista todos os itens (conexoes bancarias)
    const itens = await pluggyGet('/items');
    if (!itens || !itens.results || !itens.results.length) {
      console.log('Pluggy: nenhuma conexao bancaria encontrada');
      return {ok:false, erro:'Nenhuma conexao bancaria'};
    }

    let totalImportadas = 0;
    const hoje = new Date();
    const dataInicio = new Date(hoje); dataInicio.setDate(hoje.getDate()-7);
    const fmtDate = d => d.toISOString().slice(0,10);

    for (const item of itens.results) {
      const banco = item.connector?.name || 'Banco';
      // Lista contas do item
      const contas = await pluggyGet('/accounts?itemId='+item.id);
      if (!contas || !contas.results) continue;

      for (const conta of contas.results) {
        // Busca transacoes dos ultimos 7 dias
        const txUrl = '/transactions?accountId='+conta.id+'&from='+fmtDate(dataInicio)+'&to='+fmtDate(hoje)+'&pageSize=100';
        const txs = await pluggyGet(txUrl);
        if (!txs || !txs.results) continue;

        for (const tx of txs.results) {
          const valor = Math.abs(Number(tx.amount||0));
          if (valor < 0.01) continue;
          const tipo = tx.type === 'CREDIT' ? 'receita' : 'custo';
          const dia = (tx.date||'').slice(0,10).split('-').reverse().join('/');
          if (!dia) continue;
          const desc = (tx.description||tx.merchant?.name||'Transacao '+banco).slice(0,60);
          const id = 'pluggy_'+tx.id;

          // Classifica automaticamente
          const cat = classificarTransacao(desc, tipo==='custo'?-valor:valor);

          // Grava na tabela lancamentos
          await req2('POST', SB_URL+'/rest/v1/lancamentos',
            { id, tipo, dia_comercial: dia, descricao: desc, categoria: cat,
              segmento: null, valor, device_id: 'pluggy_auto' },
            { 'apikey': SB_KEY, 'Prefer': 'return=minimal,resolution=ignore-duplicates',
              'Content-Type': 'application/json' }
          ).catch(()=>{});
          totalImportadas++;
        }
      }
    }

    console.log('Pluggy: importadas', totalImportadas, 'transacoes');
    return {ok:true, importadas: totalImportadas};
  } catch(e) {
    console.error('Pluggy erro:', e.message);
    return {ok:false, erro:e.message};
  }
}

// Roda Pluggy junto com a consulta SEFAZ às 3h
// (ja incluido no agendador de 30min)

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
    }
  }
  // Segunda-feira às 7h Brasilia = 10h UTC — relatório semanal PDF
  if (hUTC === 10 && agora.getUTCDay() === 1 && _ultimoContasDia !== diaKey) {
    _ultimoContasDia = diaKey;
    checarContasVencendo().catch(()=>{});
    gerarEnviarRelatorioPDF().catch(()=>{});
  }
  // Demais dias às 7h — só alertas de contas
  if (hUTC === 10 && agora.getUTCDay() !== 1 && _ultimoContasDia !== diaKey) {
    _ultimoContasDia = diaKey;
    checarContasVencendo().catch(()=>{});
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
