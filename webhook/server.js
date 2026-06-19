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
      if (['imageMessage','documentMessage'].includes(tipo)) {
        await wpp(num, 'Recebi! Buscando imagem...');
        const b64 = await getMidia(msg);
        if (!b64) { await wpp(num, 'Nao consegui baixar.'); return; }
        await wpp(num, 'Analisando...');
        const r1 = await claude([{ role:'user', content:[
          tipo === 'documentMessage' ? { type:'document', source:{ type:'base64', media_type:'application/pdf', data:b64 } } : { type:'image', source:{ type:'base64', media_type: b64.startsWith('/9j/')||b64.startsWith('/9J/')?'image/jpeg':b64.startsWith('iVBORw')?'image/png':'image/jpeg', data:b64 } },
          { type:'text', text:'Leia este(s) comprovante(s) de pagamento. IGNORE COMPLETAMENTE quem e o pagador/remetente/origem - o pagador pode ser qualquer conta ou nome, isso NAO importa. Foque APENAS no campo de DESTINO do pagamento, que aparece estruturalmente como: "Favorecido", "Beneficiario", "Para", "Destino", "Recebedor", "Dados de destino > Nome", ou o estabelecimento/CNPJ cobrado em maquininha de cartao. Pode haver MAIS DE UM comprovante na mesma imagem/arquivo (ex: varios boletos enviados juntos pelo banco) - analise CADA UM separadamente. Para CADA comprovante encontrado, identifique: (1) VALOR: campo "Valor" ou "Total"; (2) NOME DE QUEM RECEBEU: o nome no campo de DESTINO (NAO o campo de origem/pagador/remetente, esse e irrelevante); (3) DATA; (4) TIPO: pix, credito, debito, boleto ou dinheiro; (5) OBSERVACAO se houver; (6) JUROS/MULTA: valor de juros ou multa SEPARADO do valor principal, se houver (comum em boleto pago com atraso - procure campos como "Juros", "Multa", "Encargos", ou "Valor pago" maior que "Valor do documento"). Liste CADA comprovante numerado (Comprovante 1, Comprovante 2...) com todos os campos em portugues.' }
        ]}], 1500);
        const analise = r1.content && r1.content[0] ? r1.content[0].text : 'Nao consegui extrair.';
        console.log('Analise:', analise.substring(0,150));
        const prompt2 = 'Extraia do texto abaixo APENAS JSON valido (sem markdown, sem comentarios). Texto: "' + analise + '". Pode haver UM ou VARIOS comprovantes - retorne SEMPRE um array, mesmo se for só 1. Formato: {"pagamentos":[{"valor":0.00,"valorJuros":0.00,"destinatario":"NOME COMPLETO no campo de DESTINO/beneficiario/favorecido - ignore completamente o campo de origem/pagador","categoria":"🥩 Matéria Prima (alimentos,insumos,carnes,hortifruti,frango,peixe,legumes,verduras,feira,padaria,mercado,bebidas ingredientes,pamonha,carvao,gelo,ovos,queijo,manteiga,farinha,tempero,molho)|👥 RH / Mão de Obra (salario,diaria,freelancer,diarista,funcionario,colaborador,pagamento pessoa)|🔧 Manutenção (reparo,conserto,tecnico)|💡 Energia / Utilidades (luz,agua,gas)|🚚 Frete / Entregador (entrega,motoboy,frete,logistica)|🏢 Aluguel / Fixos (aluguel,iptu,condominio)|📦 Embalagem (embalagem,caixa,sacola)|🍺 Bebidas / Bar (bebida,drinks,cerveja,refrigerante)|🧹 Limpeza / Higiene (limpeza,higiene,produto)|💳 Taxas / Impostos (taxa,imposto,multa,cartao)|📱 Telecom / Internet (internet,telefone,celular)|🔄 Outros","tipo":"pix|boleto|dinheiro|credito|debito|stone|cielo","data":"DD/MM/AAAA","descricao":"motivo se houver"}]}. IMPORTANTE: valorJuros e o valor de JUROS/MULTA cobrado SEPARADAMENTE do valor principal. Se nao houver, valorJuros=0. Se nao identificar nenhum valor retorne {"pagamentos":[]}';
        const r2 = await claude([{ role:'user', content: prompt2 }], 800);
        const texto2 = r2.content && r2.content[0] ? r2.content[0].text : '{}';
        const match = texto2.match(/\{[\s\S]*\}/);
        const lancamentosFeitos = [];
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
              const lanc = { valor: p.valor, categoria: p.categoria || 'Outros', descricao: _desc, destinatario: _dest, tipo: p.tipo || 'pix', data: p.data || new Date().toLocaleDateString('pt-BR'), confianca: 'alta', setor: 'Geral', origem: 'whatsapp' };
              await salvarGitHub(lanc, reciboUrl2);
              lancamentosFeitos.push(lanc);
              if (p.valorJuros && p.valorJuros > 0) {
                const lancJuros = { valor: p.valorJuros, categoria: '💳 Taxas / Impostos', descricao: 'Juros/multa', destinatario: _dest + ' (juros)', tipo: lanc.tipo, data: lanc.data, confianca: 'alta', setor: 'Geral', origem: 'whatsapp' };
                await salvarGitHub(lancJuros, reciboUrl2);
                lancamentosFeitos.push(lancJuros);
              }
            }
          } catch(ep) { console.error('parse err:', ep.message); }
        }
        let resp = 'Analise:\n' + analise + '\n\n_Di Casa Laranjinha_';
        if (lancamentosFeitos.length) {
          resp += '\n\n✅ ' + lancamentosFeitos.length + ' lancamento(s):';
          lancamentosFeitos.forEach(l => { resp += '\nR$ ' + l.valor.toFixed(2) + ' - ' + l.destinatario + ' - ' + l.categoria; });
        } else {
          resp += '\n\n⚠️ Nenhum valor identificado pra lancar.';
        }
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
async function checarDispatchDiario(){
  try{
    const agora = new Date();
    const brHora = agora.toLocaleString('en-US',{timeZone:'America/Sao_Paulo',hour12:false,hour:'2-digit',minute:'2-digit'});
    const brDataChave = agora.toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
    if (brHora !== '06:00') return;
    if (ultimoDispatchDia === brDataChave) return;
    ultimoDispatchDia = brDataChave;

    const r = await req2('GET','https://raw.githubusercontent.com/'+REPO+'/main/dre_sync.json?t='+Date.now(),null,{});
    if (!r || typeof r !== 'object') { console.log('Dispatch 6h: sem dre_sync.json ainda'); return; }

    const ontem = new Date(agora.getTime() - 24*60*60*1000);
    const ontemBR = ontem.toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'});
    const hojeBR = agora.toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo'});

    const diaOntem = r[ontemBR] || { r: [], c: [] };
    const receita = (diaOntem.r||[]).reduce((s,x)=>s+Number(x.v||0),0);
    const custo = (diaOntem.c||[]).reduce((s,x)=>s+Number(x.v||0),0);
    const lucro = receita - custo;

    const contasHoje = (r.contasPagar||[]).filter(c => c.status === 'pendente' && c.vencimento === hojeBR);
    const totalContas = contasHoje.reduce((s,c)=>s+Number(c.valor||0),0);

    let msg = '📊 *Balanço — ' + ontemBR + '*\n\n';
    msg += '💰 Receita: R$ ' + receita.toFixed(2) + '\n';
    msg += '💸 Custos: R$ ' + custo.toFixed(2) + '\n';
    msg += (lucro >= 0 ? '✅' : '⚠️') + ' Resultado: R$ ' + lucro.toFixed(2) + '\n\n';

    if (contasHoje.length) {
      msg += '🏦 *Contas a pagar hoje (' + hojeBR + ')*\n';
      contasHoje.forEach(c => { msg += '• ' + c.fornecedor + ': R$ ' + Number(c.valor).toFixed(2) + '\n'; });
      msg += '\n*Total do dia: R$ ' + totalContas.toFixed(2) + '*';
    } else {
      msg += '🏦 Nenhuma conta vence hoje.';
    }

    await wpp('5534996853258', msg); // Diogo
    await wpp('5534997692282', msg); // Herielly
    console.log('✅ Dispatch diário enviado — ' + ontemBR);
  } catch(e) { console.log('Erro dispatch diario:', e.message); }
}
setInterval(checarDispatchDiario, 60000);
