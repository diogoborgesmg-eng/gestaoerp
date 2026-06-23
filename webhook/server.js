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
    fd.lancamentos.push({ id: Date.now().toString(36), ...lanc, tipo_lancamento: 'custo', setor: lanc.setor||'Geral', reciboUrl: reciboUrl||null,
      criadoEm: new Date().toISOString(), sincronizado: false });
    if (fd.lancamentos.length > 200) fd.lancamentos = fd.lancamentos.slice(-200);
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
        const r1 = await claude([{ role:'user', content: texto + '\n\nAnalise este comprovante de pagamento acima. Di Casa Gastronomia PAGOU alguem. Identifique: (1) VALOR, (2) NOME DE QUEM RECEBEU (em DADOS DE DESTINO > Nome, ou Favorecido, ou Beneficiario - nunca Di Casa), (3) DATA, (4) TIPO pix/boleto/cartao, (5) OBSERVACAO se houver. Se nao tiver observacao informe SEM_DESCRICAO.' }], 600);
        // Log completo da resposta para debug
        console.log('tipo msg:', tipo, '| b64 len:', b64.length, '| inicio:', b64.substring(0,10));
        console.log('r1 response:', JSON.stringify(r1).substring(0,300));
        let analise = 'Nao consegui extrair.';
        if (r1 && r1.content && r1.content[0]) {
          analise = r1.content[0].text || r1.content[0].type || 'Sem texto';
        } else if (r1 && r1.error) {
          analise = 'Erro API: ' + JSON.stringify(r1.error);
        }
        console.log('Analise texto:', analise.substring(0,100));
        // Salva recibo original no GitHub
        const reciboUrl = await salvarReciboGitHub(b64, tipo, new Date());
        if(reciboUrl) console.log('Recibo salvo:', reciboUrl);
        const msgAnalise = analise==='Nao consegui extrair.' ? 
          'Nao consegui extrair. Tente: 1) salvar a imagem e reenviar, 2) tirar foto da tela do comprovante.' : 
          'Analise:\n' + analise.substring(0,300);
        await wpp(num, msgAnalise);
        const prompt2 = 'Extraia do texto abaixo APENAS JSON valido. Texto: "' + analise + '". Formato: {"valor":0.00,"valorJuros":0.00,"destinatario":"nome de quem recebeu - NUNCA Di Casa Gastronomia","categoria":"🥩 Matéria Prima (alimentos,insumos,carnes,hortifruti,frango,peixe,legumes,verduras,feira,padaria,mercado,bebidas ingredientes,pamonha,carvao,gelo,ovos,queijo,manteiga,farinha,tempero,molho)|👥 RH / Mão de Obra (salario,diaria,freelancer,diarista,funcionario,colaborador,pagamento pessoa fisica - NAO usar para alimentos,comida,feira,mercado,padaria,carne,frango,legumes,hortifruti)|🔧 Manutenção (reparo,conserto,tecnico)|💡 Energia / Utilidades (luz,agua,gas)|🚚 Frete / Entregador (entrega,motoboy,frete,logistica)|🏢 Aluguel / Fixos (aluguel,iptu,condominio)|📦 Embalagem (embalagem,caixa,sacola)|🍺 Bebidas / Bar (bebida,drinks,cerveja,refrigerante)|🧹 Limpeza / Higiene (limpeza,higiene,produto)|💳 Taxas / Impostos (taxa,imposto,multa,cartao)|📱 Telecom / Internet (internet,telefone,celular)|🔄 Outros","tipo":"pix|boleto|dinheiro|credito|debito|stone|cielo","data":"DD/MM/AAAA","descricao":"motivo do pagamento se houver"}. IMPORTANTE: valorJuros e o valor de JUROS ou MULTA cobrado SEPARADAMENTE do valor principal (comum em boleto pago com atraso). Se o comprovante mostrar "Valor original" + "Juros/Multa" separados, valor=valor original e valorJuros=juros/multa. Se nao houver juros/multa, valorJuros=0. Se nao tiver valor retorne {"valor":0}';
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
          { type:'text', text:'Leia este(s) comprovante(s) de pagamento. IGNORE COMPLETAMENTE quem e o pagador/remetente/origem - o pagador pode ser qualquer conta ou nome, isso NAO importa. Foque APENAS no campo de DESTINO do pagamento, que aparece estruturalmente como: "Favorecido", "Beneficiario", "Para", "Destino", "Recebedor", "Dados de destino > Nome", ou o estabelecimento/CNPJ cobrado em maquininha de cartao. ATENCAO CRITICA: o nome do destinatario NUNCA pode ser "Di Casa Gastronomia", "Di Casa Laranjinha" ou "Diogo Jose dos Santos Borges" - essa e a empresa que esta PAGANDO, nunca quem recebe. Se voce ler esse nome no campo de destino, procure de novo no documento ate achar o nome de quem REALMENTE recebeu (pode ser pessoa fisica, funcionario, fornecedor). ATENCAO 2: em PIX, o nome de uma INSTITUICAO FINANCEIRA (ex: "Nu Pagamentos S.A.", "Stone Pagamentos", "Mercado Pago", qualquer nome com "Pagamentos S.A." ou "Instituicao de Pagamento") NUNCA e o destinatario real - e so o banco/instituicao que processa a transferencia. O destinatario real e a PESSOA ou EMPRESA dona da conta (geralmente aparece como nome + CPF/CNPJ proximo, mesmo que o documento tambem mostre o nome do banco). Sempre prefira o nome da PESSOA/EMPRESA sobre o nome do banco/instituicao financeira. Pode haver MAIS DE UM comprovante na mesma imagem/arquivo (ex: varios boletos enviados juntos pelo banco) - analise CADA UM separadamente. Para CADA comprovante encontrado, identifique: (1) VALOR: campo "Valor" ou "Total"; (2) NOME DE QUEM RECEBEU: o nome no campo de DESTINO (NAO o campo de origem/pagador/remetente, esse e irrelevante); (3) DATA E HORA (a hora exata, ex: 23:20); (4) TIPO: pix, credito, debito, boleto ou dinheiro; (5) OBSERVACAO se houver; (6) JUROS/MULTA: valor de juros ou multa SEPARADO do valor principal, se houver (comum em boleto pago com atraso - procure campos como "Juros", "Multa", "Encargos", ou "Valor pago" maior que "Valor do documento"). Liste CADA comprovante numerado (Comprovante 1, Comprovante 2...) com todos os campos em portugues.' }
        ]}], 3000);
        const analise = r1.content && r1.content[0] ? r1.content[0].text : 'Nao consegui extrair.';
        console.log('Analise:', analise.substring(0,150));
        const prompt2 = 'Extraia do texto abaixo APENAS JSON valido (sem markdown, sem comentarios). Texto: "' + analise + '". Pode haver UM ou VARIOS comprovantes - retorne SEMPRE um array, mesmo se for só 1. Formato: {"pagamentos":[{"valor":0.00,"valorJuros":0.00,"destinatario":"NOME COMPLETO no campo de DESTINO/beneficiario/favorecido - ignore completamente o campo de origem/pagador - NUNCA retorne Di Casa Gastronomia/Di Casa Laranjinha/Diogo Jose dos Santos Borges aqui, isso e sempre o pagador, nunca o destinatario - tambem NUNCA retorne nome de instituicao financeira (Nu Pagamentos S.A., Stone Pagamentos, Mercado Pago, etc), use o nome da PESSOA/EMPRESA dona da conta","categoria":"escolha APENAS UMA, sem parenteses, exatamente uma destas strings curtas: 🥩 Matéria Prima / 👥 RH / Mão de Obra / 🔧 Manutenção / 💡 Energia / Utilidades / 🚚 Frete / Entregador / 🏢 Aluguel / Fixos / 📦 Embalagem / 🍺 Bebidas / Bar / 🧹 Limpeza / Higiene / 💳 Taxas / Impostos / 📱 Telecom / Internet / 🎤 Shows / Eventos / 🔄 Outros. REGRAS OBRIGATORIAS: (1) diaria, salario, freelancer, autonomo, vale, pagamento a pessoa fisica/funcionario = SEMPRE 👥 RH / Mão de Obra (nunca Fixos). (2) cantor, musico, banda, dj, show, evento, animacao = SEMPRE 🎤 Shows / Eventos (nunca RH, nunca Fixos, nunca Outros).","tipo":"pix|boleto|dinheiro|credito|debito|stone|cielo","data":"DD/MM/AAAA","hora":"HH:MM se houver, senao vazio","descricao":"motivo se houver"}]}. IMPORTANTE: valorJuros e o valor de JUROS/MULTA cobrado SEPARADAMENTE do valor principal. Se nao houver, valorJuros=0. Se nao identificar nenhum valor retorne {"pagamentos":[]}';
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
              lancamentosFeitos.push(lanc);
              if (p.valorJuros && p.valorJuros > 0) {
                const lancJuros = { valor: p.valorJuros, categoria: '💳 Taxas / Impostos', descricao: 'Juros/multa', destinatario: _dest + ' (juros)', tipo: lanc.tipo, data: lanc.data, confianca: 'alta', setor: 'Geral', origem: 'whatsapp' };
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
      melhorDia, piorDia, diaMaiorCusto, mediaResultadoMes, mesNome: mesOntem, anoMes: anoOntem
    });
    pdfBase64 = pdfBuffer.toString('base64');
  } catch(ePdf) { erroPdf = ePdf.message; console.log('Erro gerar PDF dispatch:', ePdf.message); }

  if (pdfBase64) {
    for (const num of destinos) {
      await wppDocumento(num, pdfBase64, 'Fechamento_'+ontemBR.replace(/\//g,'-')+'.pdf', '📄 Fechamento — '+ontemBR);
    }
  }
  console.log('✅ Dispatch (PDF) — ' + ontemBR + ' — receita:'+receitaOntem+' custo:'+custoOntem+' — hoje(BR):'+brDataStr(hojeP.ano,hojeP.mes,hojeP.dia));
  return { ok: !!pdfBase64, ontemBR, hojeBR: brDataStr(hojeP.ano,hojeP.mes,hojeP.dia), receitaOntem, custoOntem, lucroOntem, diasComDados: diasDoMes.filter(d=>d.receita>0||d.custo>0).length, erroPdf };
}

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
