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

    await req2('PUT',
      'https://api.github.com/repos/'+REPO+'/contents/'+nome,
      body,
      {'Authorization':'token '+GHTOKEN,'Accept':'application/vnd.github.v3+json'});

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
    // Bot registra SEMPRE custos (pagamentos feitos pela Di Casa)
    fd.lancamentos.push({ id: Date.now().toString(36), ...lanc, tipo_lancamento: 'custo', setor: lanc.setor||'Geral', reciboUrl: reciboUrl||null,
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
        const prompt2 = 'Extraia do texto abaixo APENAS JSON valido. Texto: "' + analise + '". Formato: {"valor":0.00,"destinatario":"nome de quem recebeu - NUNCA Di Casa Gastronomia","categoria":"🥩 Matéria Prima (alimentos,insumos,carnes,hortifruti)|👥 RH / Mão de Obra (salario,diaria,freelancer,diarista,funcionario,colaborador,pagamento pessoa)|🔧 Manutenção (reparo,conserto,tecnico)|💡 Energia / Utilidades (luz,agua,gas)|🚚 Frete / Entregador (entrega,motoboy,frete,logistica)|🏢 Aluguel / Fixos (aluguel,iptu,condominio)|📦 Embalagem (embalagem,caixa,sacola)|🍺 Bebidas / Bar (bebida,drinks,cerveja,refrigerante)|🧹 Limpeza / Higiene (limpeza,higiene,produto)|💳 Taxas / Impostos (taxa,imposto,multa,cartao)|📱 Telecom / Internet (internet,telefone,celular)|🔄 Outros","tipo":"pix|boleto|dinheiro|credito|debito|stone|cielo","data":"DD/MM/AAAA","descricao":"motivo do pagamento se houver"}. Se nao tiver valor retorne {"valor":0}';
        const r2 = await claude([{ role:'user', content: prompt2 }], 300);
        const texto2 = r2.content && r2.content[0] ? r2.content[0].text : '{}';
        const match = texto2.match(/\{[\s\S]*\}/);
        let lanc = null;
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
          } catch(e) { lanc = null; }
        }
        if (!lanc || !lanc.valor) { await wpp(num, 'Nao identifiquei os dados. Tente enviar como foto.'); return; }
        // Salva no GitHub (mesmo fluxo das imagens)
        try {
          const fi = await req2('GET','https://api.github.com/repos/'+REPO+'/contents/bot_lancamentos.json',null,{'Authorization':'token '+GHTOKEN,'Accept':'application/vnd.github.v3+json'});
          if (!fi || !fi.content) { await wpp(num, 'Erro GitHub.'); return; }
          const fd = JSON.parse(Buffer.from(fi.content, 'base64').toString());
          if (!fd.lancamentos) fd.lancamentos = [];
          fd.lancamentos.push({ id: Date.now().toString(36), ...lanc, tipo_lancamento: 'custo', setor: lanc.setor||'Geral', criadoEm: new Date().toISOString(), sincronizado: false });
          if (fd.lancamentos.length > 50) fd.lancamentos = fd.lancamentos.slice(-50);
          await req2('PUT','https://api.github.com/repos/'+REPO+'/contents/bot_lancamentos.json',{ message: 'bot:'+lanc.valor, content: Buffer.from(JSON.stringify(fd)).toString('base64'), sha: fi.sha },{'Authorization':'token '+GHTOKEN,'Accept':'application/vnd.github.v3+json'});
          await wpp(num, 'Lancado! R$ '+lanc.valor.toFixed(2)+' - '+lanc.categoria);
        } catch(e) { await wpp(num, 'Erro ao salvar: '+e.message); }
        return;
      }
      if (['imageMessage','documentMessage'].includes(tipo)) {
        await wpp(num, 'Recebi! Buscando imagem...');
        const b64 = await getMidia(msg);
        if (!b64) { await wpp(num, 'Nao consegui baixar.'); return; }
        await wpp(num, 'Analisando...');
        const r1 = await claude([{ role:'user', content:[
          tipo === 'documentMessage' ? { type:'document', source:{ type:'base64', media_type:'application/pdf', data:b64 } } : { type:'image', source:{ type:'base64', media_type: b64.startsWith('/9j/')||b64.startsWith('/9J/')?'image/jpeg':b64.startsWith('iVBORw')?'image/png':'image/jpeg', data:b64 } },
          { type:'text', text:'Leia este comprovante de pagamento. Di Casa Gastronomia PAGOU alguem. Identifique: (1) VALOR: campo "Valor" ou "Total"; (2) NOME DE QUEM RECEBEU: Stone/C6/Itau: procure em "DADOS DE DESTINO > Nome" ou "Destino > Nome"; PIX comum: procure em "Favorecido", "Beneficiario", "Para", "Recebedor"; Cartao/maquininha: nome do estabelecimento cobrado; NUNCA use "Di Casa Gastronomia" como nome - esse e o pagador, nao o recebedor; (3) DATA: campo "Data", "Realizada em", "Data/Hora"; (4) TIPO: pix, credito, debito, boleto ou dinheiro; (5) OBSERVACAO: campo descricao, motivo, historico do pagamento. Se nao tiver informe SEM_DESCRICAO. Liste cada campo claramente em portugues.' }
        ]}], 800);
        const analise = r1.content && r1.content[0] ? r1.content[0].text : 'Nao consegui extrair.';
        console.log('Analise:', analise.substring(0,100));
        const prompt2 = 'Extraia do texto abaixo APENAS JSON valido. Texto: "' + analise + '". Formato: {"valor":0.00,"destinatario":"NOME COMPLETO da conta/pessoa que recebeu - campo Favorecido/Beneficiario/Nome da conta destino - NAO usar observacao/descricao/motivo do pix","categoria":"🥩 Matéria Prima (alimentos,insumos,carnes,hortifruti)|👥 RH / Mão de Obra (salario,diaria,freelancer,diarista,funcionario,colaborador,pagamento pessoa)|🔧 Manutenção (reparo,conserto,tecnico)|💡 Energia / Utilidades (luz,agua,gas)|🚚 Frete / Entregador (entrega,motoboy,frete,logistica)|🏢 Aluguel / Fixos (aluguel,iptu,condominio)|📦 Embalagem (embalagem,caixa,sacola)|🍺 Bebidas / Bar (bebida,drinks,cerveja,refrigerante)|🧹 Limpeza / Higiene (limpeza,higiene,produto)|💳 Taxas / Impostos (taxa,imposto,multa,cartao)|📱 Telecom / Internet (internet,telefone,celular)|🔄 Outros","tipo":"pix|boleto|dinheiro|credito|debito|stone|cielo","data":"DD/MM/AAAA","descricao":"motivo do pagamento se houver"}. Se nao tiver valor retorne {"valor":0}';
        const r2 = await claude([{ role:'user', content: prompt2 }], 200);
        const texto2 = r2.content && r2.content[0] ? r2.content[0].text : '{}';
        const match = texto2.match(/\{[\s\S]*\}/);
        let lanc = null;
        if (match) {
          try {
            const d = JSON.parse(match[0]);
            if (d.valor > 0) {
              lanc = (()=>{
              // Limpa prefixos do destinatario
              const _raw = d.destinatario||d.descricao||'';
              const _prefixos = ['Pagamento para ','Para ','Favorecido: ','Beneficiário: ','Beneficiario: ','Recebedor: ','Destino: ','Pago para ','Pago a ','Transferência para ','Transferencia para '];
              let _dest = _raw;
              for(const p of _prefixos){ if(_dest.toLowerCase().startsWith(p.toLowerCase())){ _dest=_dest.slice(p.length).trim(); break; } }
              // Descricao separada do destinatario
              const _desc = d.descricao&&d.descricao!==d.destinatario&&d.descricao!=='SEM_DESCRICAO' ? d.descricao : '';
              return { valor: d.valor, categoria: d.categoria||'Outros', descricao: _desc, destinatario: _dest, tipo: d.tipo||'pix', data: d.data||new Date().toLocaleDateString('pt-BR'), confianca: d.confianca||'alta', setor: d.setor||'Geral', origem: 'whatsapp' };
            })();
              await salvarGitHub(lanc);
            }
          } catch(ep) { console.error('parse err:', ep.message); }
        }
        let resp = 'Analise:\n' + analise + '\n\n_Di Casa Laranjinha_';
        if (lanc) resp += '\n\nLancado! R$ ' + lanc.valor.toFixed(2) + ' - ' + lanc.categoria;
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
