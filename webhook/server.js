'use strict';
// ═══════════════════════════════════════════════════════════
// GestaoERP — Servidor v9 (reconstrução limpa)
// Di Casa Laranjinha — Patos de Minas MG
// ═══════════════════════════════════════════════════════════
const https = require('https');
const http  = require('http');

// ── Constantes ───────────────────────────────────────────
const PORT        = process.env.PORT || 10000;
const SB_URL      = 'https://bxppiwshjyddiieazoqx.supabase.co';
const SB_KEY      = 'sb_publishable_eEZOmtLmoOEbjJDtrUBGcQ_KmnmeBxM';
const EVO_URL     = 'https://evolution-api-latest-lrlv.onrender.com';
const EVO_KEY     = 'dicasalaranjinha2024';
const INSTANCE    = 'dicasalaranjinha';
const DESTINOS    = ['5534996853258','5534997692282'];
const CNPJ_EMP    = '44686412000100';
const GHTOKEN     = process.env.GITHUB_TOKEN || '';
const REPO        = 'diogoborgesmg-eng/gestaoerp';
const CLAUDE_KEY  = process.env.ANTHROPIC_API_KEY || '';
const PLUGGY_CID  = process.env.PLUGGY_CLIENT_ID  || '';
const PLUGGY_CSEC = process.env.PLUGGY_CLIENT_SECRET || '';

// ── Utilidades HTTP ──────────────────────────────────────
function httpReq(method, url, data, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = data ? JSON.stringify(data) : null;
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: { 'Content-Type':'application/json',
        ...(body ? {'Content-Length': Buffer.byteLength(body)} : {}),
        ...headers }
    };
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(d); } });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const sb = (method, path, data, extra={}) =>
  httpReq(method, SB_URL+path, data, { apikey:SB_KEY, ...extra });

// ── WhatsApp ─────────────────────────────────────────────
async function wpp(numero, texto) {
  return httpReq('POST', EVO_URL+'/message/sendText/'+INSTANCE,
    { number: numero, text: texto }, { apikey: EVO_KEY });
}

async function wppParaTodos(texto) {
  for (const n of DESTINOS) await wpp(n, texto).catch(()=>{});
}

async function getMidia(msg) {
  try {
    const r = await httpReq('POST', EVO_URL+'/chat/getBase64FromMediaMessage/'+INSTANCE,
      { message: { key: msg.key, message: msg.message } }, { apikey: EVO_KEY });
    return r.base64 || null;
  } catch(e) { return null; }
}

// ── Claude ───────────────────────────────────────────────
async function claude(messages, maxTokens=1000) {
  return httpReq('POST', 'https://api.anthropic.com/v1/messages',
    { model:'claude-sonnet-4-6', max_tokens:maxTokens, messages },
    { 'x-api-key':CLAUDE_KEY, 'anthropic-version':'2023-06-01' });
}

// ── Supabase Lançamentos ─────────────────────────────────
const brl = v => 'R$ '+Number(v||0).toLocaleString('pt-BR',{minimumFractionDigits:2});

async function gravarLancamento(id, tipo, dia, descricao, categoria, valor, deviceId) {
  return sb('POST', '/rest/v1/lancamentos',
    { id, tipo, dia_comercial:dia, descricao, categoria:categoria||'🔄 Outros',
      segmento:null, valor:Math.abs(Number(valor||0)), device_id:deviceId },
    { Prefer:'return=minimal,resolution=ignore-duplicates' }).catch(()=>{});
}

// ── GitHub (bot_lancamentos.json) ────────────────────────
async function salvarBotLancamentosGitHub(lancamentos) {
  try {
    const fi = await httpReq('GET',
      'https://api.github.com/repos/'+REPO+'/contents/bot_lancamentos.json?ref=dados',
      null, { Authorization:'token '+GHTOKEN, Accept:'application/vnd.github.v3+json', 'User-Agent':'GestaoERP/9' });
    if (!fi.content) return;
    const fd = JSON.parse(Buffer.from(fi.content,'base64').toString());
    if (!fd.lancamentos) fd.lancamentos = [];
    const existentes = new Set(fd.lancamentos.map(l=>l.id||l.destinatario+'_'+l.valor));
    const novos = lancamentos.filter(l => !existentes.has(l.id||l.destinatario+'_'+l.valor));
    if (!novos.length) return;
    fd.lancamentos = [...fd.lancamentos, ...novos].slice(-500);
    await httpReq('PUT',
      'https://api.github.com/repos/'+REPO+'/contents/bot_lancamentos.json?ref=dados',
      { message:'bot:'+novos.length, content:Buffer.from(JSON.stringify(fd)).toString('base64'), sha:fi.sha, branch:'dados' },
      { Authorization:'token '+GHTOKEN, Accept:'application/vnd.github.v3+json', 'User-Agent':'GestaoERP/9' });
    console.log('GitHub: '+novos.length+' lançamentos salvos');
  } catch(e) { console.error('GitHub err:', e.message); }
}

// ── Blob erp_sync ────────────────────────────────────────
async function lerBlob() {
  const r = await sb('GET', '/rest/v1/erp_sync?select=data,device_id&order=updated_at.desc&limit=1');
  if (!Array.isArray(r)||!r.length) return { data:{}, deviceId:'v9' };
  return { data:JSON.parse(r[0].data||'{}'), deviceId:r[0].device_id };
}

async function salvarBlob(data, deviceId) {
  return sb('POST', '/rest/v1/erp_sync',
    { device_id:deviceId, data:JSON.stringify(data) },
    { Prefer:'resolution=merge-duplicates' });
}

// ── Pluggy ───────────────────────────────────────────────
let _pluggyToken = null, _pluggyExp = 0;

async function pluggyAuth() {
  if (_pluggyToken && Date.now() < _pluggyExp) return _pluggyToken;
  const r = await httpReq('POST', 'https://api.pluggy.ai/auth',
    { clientId:PLUGGY_CID, clientSecret:PLUGGY_CSEC }, {'Content-Type':'application/json'});
  _pluggyToken = r.apiKey;
  _pluggyExp = Date.now() + 1.5*60*60*1000;
  return _pluggyToken;
}

async function pluggyGet(path) {
  const k = await pluggyAuth();
  return httpReq('GET', 'https://api.pluggy.ai'+path, null, {'X-API-KEY':k});
}

// ── Saldos Bancários (10h) ───────────────────────────────
async function enviarSaldos() {
  try {
    const { data } = await lerBlob();
    const ids = data.pluggyItemIds || [];
    if (!ids.length) return console.log('Saldos: sem itemIds');

    const vistas = new Set();
    const bancos = [], cartoes = [];

    for (const id of ids) {
      const contas = await pluggyGet('/accounts?itemId='+id).catch(()=>({}));
      if (!contas.results) continue;
      for (const c of contas.results) {
        if (vistas.has(c.id)) continue;
        vistas.add(c.id);
        const nomeBanco = c.name.includes('C6')?'C6 Bank':c.name.includes('CAIXA')?'Caixa':
          c.name.includes('STONE')?'Stone':c.name.includes('SANTANDER')?'Santander':c.name.trim();
        if ((c.type||'').toUpperCase()==='CREDIT') cartoes.push({nome:c.name.trim(), saldo:Number(c.balance||0)});
        else bancos.push({nome:nomeBanco, saldo:Number(c.balance||0)});
      }
    }

    const totalBanco = bancos.reduce((a,b)=>a+b.saldo,0);
    const agora = new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}).slice(0,16);
    const linhas = ['*📊 Di Casa Laranjinha*','_'+agora+'_','',
      '*🏦 Contas Bancárias: '+brl(totalBanco)+'*',
      ...bancos.map(b=>'  • '+b.nome+': *'+brl(b.saldo)+'*'+(b.saldo<0?' ⚠️ NEGATIVO':''))];

    if (cartoes.length) {
      const totalCartao = cartoes.reduce((a,b)=>a+b.saldo,0);
      linhas.push('','*💳 Faturas: '+brl(totalCartao)+'*');
      cartoes.forEach(c=>linhas.push('  • '+c.nome+': *'+brl(c.saldo)+'*'));
    }
    // Busca cheques dos últimos 7 dias
    const cheques = [];
    const dataInicio7d = new Date(); dataInicio7d.setDate(dataInicio7d.getDate()-7);
    const fmtDate7d = d => d.toISOString().slice(0,10);
    const fmtDia7d = s => s ? s.slice(0,10).split('-').reverse().join('/') : '';
    for (const id of ids) {
      const contas7d = await pluggyGet('/accounts?itemId='+id).catch(()=>({}));
      if (!contas7d.results) continue;
      for (const c of contas7d.results) {
        if ((c.type||'').toUpperCase()==='CREDIT') continue;
        const txs = await pluggyGet('/v2/transactions?accountId='+c.id+'&from='+fmtDate7d(dataInicio7d)+'&to='+fmtDate7d(new Date())+'&pageSize=50').catch(()=>({}));
        if (!txs.results) continue;
        const nomeBanco = c.name.includes('C6')?'C6 Bank':c.name.includes('CAIXA')?'Caixa':
          c.name.includes('STONE')?'Stone':c.name.includes('SANTANDER')?'Santander':c.name.trim();
        for (const tx of txs.results) {
          const desc = (tx.description||'').toLowerCase();
          const metodo = (tx.paymentData?.paymentMethod||'').toLowerCase();
          if (metodo.includes('check')||desc.includes('cheque')||desc.includes('saque din ag')) {
            cheques.push({banco:nomeBanco, valor:Math.abs(Number(tx.amount||0)), dia:fmtDia7d(tx.date), tipo:Number(tx.amount||0)>0?'📥':'📤'});
          }
        }
      }
    }
    if (cheques.length) {
      const totalCheques = cheques.reduce((a,c)=>a+c.valor,0);
      linhas.push('','*🔖 Cheques (7 dias): '+brl(totalCheques)+'*');
      cheques.forEach(c=>linhas.push('  '+c.tipo+' '+c.banco+': *'+brl(c.valor)+'* ('+c.dia+')'));
    }

    linhas.push('','*Saldo líquido: '+brl(totalBanco)+'*');

    await wppParaTodos(linhas.join('\n'));
    console.log('Saldos enviados OK. Total banco:', totalBanco.toFixed(2));
  } catch(e) { console.error('Erro saldos:', e.message); }
}

// ── PDF das 6h ───────────────────────────────────────────
async function enviarPDF() {
  try {
    const hoje = new Date();
    hoje.setHours(hoje.getHours()-3); // Brasília
    const ontem = new Date(hoje); ontem.setDate(ontem.getDate()-1);
    const diaOntem = ontem.toLocaleDateString('pt-BR'); // DD/MM/YYYY

    // Lê lançamentos do dia anterior
    const rows = await sb('GET', `/rest/v1/lancamentos?dia_comercial=eq.${diaOntem}&select=tipo,valor,descricao,categoria&limit=500`);
    if (!Array.isArray(rows)) return;

    const receitas = rows.filter(r=>r.tipo==='receita');
    const custos   = rows.filter(r=>r.tipo==='custo');
    const totalR   = receitas.reduce((a,r)=>a+Number(r.valor||0),0);
    const totalC   = custos.reduce((a,r)=>a+Number(r.valor||0),0);
    const resultado = totalR - totalC;

    // Agrupa custos por categoria
    const porCat = {};
    custos.forEach(r => {
      const cat = r.categoria||'Outros';
      porCat[cat] = (porCat[cat]||0) + Number(r.valor||0);
    });

    const linhas = [
      `*📊 Resumo ${diaOntem}*`,
      ``,
      `*💰 Receita: ${brl(totalR)}*`,
      `*📦 Custo: ${brl(totalC)}*`,
      `*${resultado>=0?'✅':'❌'} Resultado: ${brl(resultado)}*`,
    ];

    if (Object.keys(porCat).length) {
      linhas.push('', '*Custos por categoria:*');
      Object.entries(porCat)
        .sort((a,b)=>b[1]-a[1])
        .slice(0,8)
        .forEach(([cat,val])=>linhas.push(`  • ${cat}: ${brl(val)}`));
    }

    if (totalR===0 && totalC===0) {
      linhas.push('', '_Nenhum lançamento encontrado para ontem._');
      console.log('PDF: sem dados para', diaOntem);
    }

    await wppParaTodos(linhas.join('\n'));
    console.log(`PDF enviado: ${diaOntem} receita=${totalR.toFixed(2)} custo=${totalC.toFixed(2)}`);
  } catch(e) { console.error('Erro PDF:', e.message); }
}

// ── Alertas de Contas Vencendo (7h) ─────────────────────
async function alertaContasVencendo() {
  try {
    const { data } = await lerBlob();
    const cp = (data.contasPagar||[]).filter(c=>!c.pago);
    const hoje = new Date();
    const vencHoje=[], vencAmanha=[], venc3d=[];
    for (const c of cp) {
      if (!c.venc) continue;
      const [dd,mm,yy] = c.venc.split('/');
      const dv = new Date(Number(yy),Number(mm)-1,parseInt(dd));
      const diff = Math.round((dv-hoje)/86400000);
      if (diff===0) vencHoje.push(c);
      else if (diff===1) vencAmanha.push(c);
      else if (diff<=3&&diff>1) venc3d.push(c);
    }
    if (!vencHoje.length&&!vencAmanha.length&&!venc3d.length) return;
    const linhas=['⚠️ *Contas vencendo:*'];
    if (vencHoje.length) { linhas.push('*Hoje:*'); vencHoje.forEach(c=>linhas.push('  • '+c.forn+': '+brl(c.val))); }
    if (vencAmanha.length) { linhas.push('*Amanhã:*'); vencAmanha.forEach(c=>linhas.push('  • '+c.forn+': '+brl(c.val))); }
    if (venc3d.length) { linhas.push('*Próximos 3 dias:*'); venc3d.forEach(c=>linhas.push('  • '+c.forn+': '+brl(c.val))); }
    await wppParaTodos(linhas.join('\n'));
  } catch(e) { console.error('Erro alertas:', e.message); }
}

// ── Bot WhatsApp ─────────────────────────────────────────
async function processarMensagemBot(msg, grupoId) {
  const tipo = msg.messageType || Object.keys(msg.message||{})[0] || '';

  // STi3 Excel
  if (['documentMessage','documentWithCaptionMessage'].includes(tipo)) {
    const docMsg = msg.message?.documentMessage || msg.message?.documentWithCaptionMessage?.message?.documentMessage;
    const caption = (docMsg?.caption||'').toLowerCase();
    const fileName = (docMsg?.fileName||'').toLowerCase();
    if ((fileName.endsWith('.xlsx')||fileName.endsWith('.xls')) &&
        (caption.includes('sti3')||caption.includes('vendas'))) {
      processarSTi3WhatsApp(msg, grupoId).catch(e=>console.error('STi3 err:', e.message));
      return;
    }
  }

  // Imagem/PDF — comprovante ou NF
  if (['imageMessage','documentMessage'].includes(tipo) && tipo!=='documentWithCaptionMessage') {
    const b64 = await getMidia(msg);
    if (!b64) { await wpp(grupoId,'Não consegui baixar a imagem.'); return; }
    try {
      // Passo 1: extrai texto
      const r1 = await claude([{role:'user',content:[
        tipo==='documentMessage'
          ? {type:'document',source:{type:'base64',media_type:'application/pdf',data:b64}}
          : {type:'image',source:{type:'base64',media_type:'image/jpeg',data:b64}},
        {type:'text',text:'Transcreva todo o texto deste comprovante/nota fiscal brasileira. Se for comprovante PIX/TED: extraia valor, destinatário, data. Se for NF: extraia fornecedor, CNPJ, valor total, vencimento, itens.'}
      ]}], 2000);
      const texto = (r1.content||[]).map(b=>b.text||'').join('').trim();
      if (!texto||texto.length<10) { await wpp(grupoId,'Não consegui ler esse documento.'); return; }

      // Passo 2: estrutura JSON
      const r2 = await claude([{role:'user',content:
        'Interprete este comprovante/NF brasileiro e retorne APENAS JSON:\n'+
        '{"tipo":"comprovante|nf","destinatario":"","valor":0,"data":"DD/MM/AAAA","categoria":"","descricao":"","fornecedor":"","vencimento":"","itens":[]}\n'+
        'Categorias: Matéria Prima, RH, Custos Fixos, Embalagem, Taxas, Outros\n'+
        'TEXTO:\n'+texto
      }], 1000);
      const txt2 = (r2.content||[]).map(b=>b.text||'').join('').trim();
      const match = txt2.match(/\{[\s\S]*\}/);
      if (!match) { await wpp(grupoId,'Não consegui estruturar.'); return; }
      const dados = JSON.parse(match[0]);
      if (!dados.valor||dados.valor<=0) { await wpp(grupoId,'Valor não identificado.'); return; }

      const dia = dados.data || new Date().toLocaleDateString('pt-BR');
      const desc = dados.destinatario||dados.fornecedor||dados.descricao||'Lançamento';
      const cat = dados.categoria||'🔄 Outros';
      const id = 'bot_'+Date.now()+'_'+Math.random().toString(36).slice(2,6);

      // Grava no Supabase (fonte principal do PDF)
      await gravarLancamento(id, 'custo', dia, desc, cat, dados.valor, 'bot_whatsapp');

      // Grava no GitHub (frontend lê isso)
      await salvarBotLancamentosGitHub([{id,destinatario:desc,valor:dados.valor,dia,categoria:cat,descricao:dados.descricao||''}]);

      const msg_ok = '✅ Lançado!\n• '+desc+'\n• '+brl(dados.valor)+'\n• '+dia+'\n• '+cat;
      await wpp(grupoId, msg_ok);
      console.log('Bot: lançamento gravado', desc, dados.valor, dia);
    } catch(e) {
      console.error('Bot err:', e.message);
      await wpp(grupoId,'Erro ao processar: '+e.message);
    }
    return;
  }

  // Texto — comprovante colado
  if (['textMessage','extendedTextMessage','conversation'].includes(tipo)) {
    const texto = msg.message?.conversation||msg.message?.extendedTextMessage?.text||'';
    const palavras = ['comprovante','transferência','pix','valor','stone','c6','pagamento','recibo'];
    if (!palavras.some(p=>texto.toLowerCase().includes(p))) return;
    try {
      const r = await claude([{role:'user',content:
        'Interprete este comprovante brasileiro e retorne APENAS JSON:\n'+
        '{"destinatario":"","valor":0,"data":"DD/MM/AAAA","categoria":""}\n'+
        'TEXTO:\n'+texto
      }], 500);
      const txt = (r.content||[]).map(b=>b.text||'').join('').trim();
      const match = txt.match(/\{[\s\S]*\}/);
      if (!match) { await wpp(grupoId,'Não consegui ler.'); return; }
      const dados = JSON.parse(match[0]);
      if (!dados.valor||dados.valor<=0) { await wpp(grupoId,'Valor não identificado.'); return; }
      const dia = dados.data||new Date().toLocaleDateString('pt-BR');
      const id = 'bot_'+Date.now();
      await gravarLancamento(id,'custo',dia,dados.destinatario||'Pagamento',dados.categoria||'🔄 Outros',dados.valor,'bot_whatsapp');
      await salvarBotLancamentosGitHub([{id,destinatario:dados.destinatario,valor:dados.valor,dia,categoria:dados.categoria}]);
      await wpp(grupoId,'✅ '+brl(dados.valor)+' — '+dia);
    } catch(e) { await wpp(grupoId,'Erro: '+e.message); }
  }
}

// ── STi3 via WhatsApp ────────────────────────────────────
async function processarSTi3WhatsApp(msg, grupoId) {
  try {
    const XLSX = require('xlsx');
    const dlResp = await httpReq('POST', EVO_URL+'/chat/getBase64FromMediaMessage/'+INSTANCE,
      {message:{key:msg.key,message:msg.message}}, {apikey:EVO_KEY});
    if (!dlResp||!dlResp.base64) throw new Error('Não baixou o arquivo');
    await wpp(grupoId,'📊 STi3 recebido! Processando...');
    const buf = Buffer.from(dlResp.base64,'base64');
    const wb = XLSX.read(buf,{type:'buffer',cellDates:true});
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:'',header:1,raw:true});
    if (!rows||rows.length<2) throw new Error('Arquivo vazio');

    // Detecta cabeçalho onde col[0] = "Venda"
    let colData=-1,colValor=-1,headerRow=-1;
    for (let i=0;i<Math.min(20,rows.length);i++) {
      const r=rows[i]; if(!r) continue;
      const c0=String(r[0]||'').trim().toLowerCase();
      if (c0==='venda') {
        headerRow=i;
        for (let j=0;j<r.length;j++) {
          const cel=String(r[j]||'').trim().toLowerCase();
          if (cel==='data') colData=j;
          if (cel==='valor') colValor=j;
        }
        break;
      }
    }
    // Fallback por conteúdo
    if (colData<0||colValor<0) {
      for (let i=1;i<Math.min(30,rows.length);i++) {
        const r=rows[i]; if(!r||r.length<3) continue;
        const c0=Number(String(r[0]||'').replace(/\./g,'').trim());
        if (!Number.isInteger(c0)||c0<=0) continue;
        for (let j=0;j<r.length;j++) {
          const v=r[j];
          if (colData<0 && v instanceof Date && !isNaN(v) && v.getFullYear()>2020) colData=j;
          if (colData<0 && typeof v==='string' && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v.trim())) colData=j;
        }
        if (colData>=0) {
          for (let j=r.length-1;j>=1;j--) {
            const v=r[j]; const n=typeof v==='number'?v:parseFloat(String(v||'').replace(',','.'));
            if (!isNaN(n)&&n>0.5&&n<100000&&j!==colData){colValor=j;break;}
          }
          if (colValor>=0){headerRow=i-1;break;}
        }
      }
    }
    if (colData<0||colValor<0) throw new Error('Colunas Data/Valor não encontradas');

    const porDia={};let linhas=0,erros=0;
    for (let i=(headerRow>=0?headerRow+1:1);i<rows.length;i++) {
      const r=rows[i]; if(!r) continue;
      const c0=Number(String(r[0]||'').replace(/\./g,'').trim());
      if (!Number.isInteger(c0)||c0<=0) continue;
      let dataFmt=null;
      const dv=r[colData];
      if (dv instanceof Date&&!isNaN(dv)) dataFmt=String(dv.getUTCDate()).padStart(2,'0')+'/'+String(dv.getUTCMonth()+1).padStart(2,'0')+'/'+dv.getUTCFullYear();
      else if (typeof dv==='string'&&dv.trim()) { const m=dv.trim().match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); if(m) dataFmt=m[1].padStart(2,'0')+'/'+m[2].padStart(2,'0')+'/'+m[3]; }
      if (!dataFmt){erros++;continue;}
      let valor=r[colValor];
      if (typeof valor!=='number') valor=parseFloat(String(valor||'0').replace(',','.'));
      if (!valor||valor<=0) continue;
      if (!porDia[dataFmt]) porDia[dataFmt]=0;
      porDia[dataFmt]+=valor;
      linhas++;
    }
    if (!linhas) throw new Error('Nenhuma venda. Erros de data: '+erros);

    // Grava no Supabase
    const dias=Object.keys(porDia).sort();
    for (const dia of dias) {
      await gravarLancamento('sti3_'+dia.replace(/\//g,''),'receita',dia,'STi3 Vendas','💰 Receita/Vendas',porDia[dia],'sti3_auto');
    }

    // Atualiza blob
    const {data,deviceId} = await lerBlob();
    for (const dia of dias) {
      if (!data[dia]) data[dia]={r:[],c:[]};
      if (!data[dia].r) data[dia].r=[];
      data[dia].r=data[dia].r.filter(x=>x.fonte!=='sti3');
      data[dia].r.push({id:'sti3_'+dia.replace(/\//g,''),d:'STi3 Vendas',v:porDia[dia],fonte:'sti3'});
    }
    await salvarBlob(data,deviceId);

    const total=Object.values(porDia).reduce((a,b)=>a+b,0);
    await wpp(grupoId,'✅ STi3 importado!\n• '+linhas+' vendas\n• '+dias.length+' dias\n• Período: '+dias[0]+' a '+dias[dias.length-1]+'\n• *Total: '+brl(total)+'*');
  } catch(e) {
    console.error('STi3 err:', e.message);
    await wpp(grupoId,'❌ STi3 erro: '+e.message);
  }
}


// ── SEFAZ Loop Principal ──────────────────────────────────
async function consultarNFsSEFAZ() {
  try {
    const { data, deviceId } = await lerBlob();
    const cert = data.dadosFiscais && data.dadosFiscais.certificado;
    if (!cert || !cert.pfxBase64) { console.log('SEFAZ: sem certificado'); return; }

    let nsuAtual = data.dadosFiscais.ultimoNSU || '000000000000000';
    const todasNFs = [];
    let continuar = true, lote = 0;

    while (continuar && lote < 10) {
      lote++;
      const resp = await sefazDistribuicaoDFe(cert.pfxBase64, cert.senha, CNPJ_EMP, nsuAtual, 'prod');
      const cStat = extrairTagXML(resp.xml, 'cStat');
      const ultNSU = extrairTagXML(resp.xml, 'ultNSU');
      const maxNSU = extrairTagXML(resp.xml, 'maxNSU');
      console.log(`SEFAZ lote ${lote} - cStat:${cStat} ultNSU:${ultNSU} maxNSU:${maxNSU}`);

      if (cStat !== '138' && cStat !== '137') break;
      const nfes = parsearNFesDoXML(resp.xml);
      const dados = parsearDocZips(resp.xml);
      todasNFs.push(...dados);
      nsuAtual = ultNSU;
      if (ultNSU >= maxNSU) continuar = false;
      if (cStat === '137') continuar = false; // sem mais docs
    }

    // Salva NSU
    if (!data.dadosFiscais) data.dadosFiscais = {};
    data.dadosFiscais.ultimoNSU = nsuAtual;

    // Deduplica por chNFe
    const vistas = new Set();
    const nfesUnicas = todasNFs.filter(nfe => {
      if (!nfe.chNFe) return true;
      if (vistas.has(nfe.chNFe)) return false;
      vistas.add(nfe.chNFe); return true;
    });

    if (!nfesUnicas.length) { await salvarBlob(data, deviceId); return; }

    // Verifica NFs realmente novas (não no Supabase ainda)
    const idsExistentes = new Set();
    try {
      const ex = await sb('GET', '/rest/v1/lancamentos?device_id=eq.sefaz_auto&select=id&limit=500');
      if (Array.isArray(ex)) ex.forEach(l => idsExistentes.add(l.id));
    } catch(e) {}

    const nfesNovas = nfesUnicas.filter(nfe => !idsExistentes.has('nf_'+nfe.chNFe));
    if (!data.contasPagar) data.contasPagar = [];

    for (const nfe of nfesNovas) {
      const dia = nfe.data || new Date().toLocaleDateString('pt-BR');
      const idLanc = 'nf_'+(nfe.chNFe||Date.now());
      console.log('SEFAZ NF nova:', nfe.emitente, nfe.valor, dia);

      // 1. DRE
      await gravarLancamento(idLanc, 'custo', dia,
        `NF ${nfe.nNF||''} - ${nfe.emitente||'Fornecedor'}`,
        detectarGrupoServidor(nfe.emitente||'').catDRE || '🥩 Matéria Prima',
        nfe.valor, 'sefaz_auto');

      // 2. Estoque (se tem itens)
      if (nfe.itens && nfe.itens.length) {
        await lancarEstoqueNFeSefaz(nfe, nfe, SB_URL, SB_KEY).catch(e=>console.log('Estoque err:',e.message));
      }

      // 3. Conta a pagar (vencimento real ou estimado +30 dias)
      if (!nfe.vencimento) {
        const pts = dia.split('/');
        if (pts.length===3) {
          const base = new Date(Number(pts[2]),Number(pts[1])-1,parseInt(pts[0])+30);
          nfe.vencimento = base.toLocaleDateString('pt-BR');
        }
      }
      const idCP = 'sefaz_cp_'+(nfe.chNFe||idLanc);
      if (!data.contasPagar.find(cp=>cp.id===idCP)) {
        data.contasPagar.push({
          id:idCP, forn:nfe.emitente||'Fornecedor', val:Number(nfe.valor||0),
          venc:nfe.vencimento, pago:false, _sefaz:true, _estimado:true,
          cnpjEmit:nfe.cnpjEmit, chNFe:nfe.chNFe
        });
      }

      // 4. Manifesta ciência e busca XML completo
      if (nfe.chNFe && cert.pfxBase64) {
        manifestarCiencia(cert.pfxBase64, cert.senha, CNPJ_EMP, nfe.chNFe, 'prod')
          .then(async mr => {
            const cStatM = (mr.xml.match(/<cStat>(\d+)<\/cStat>/)||[])[1];
            console.log('Ciência:', nfe.emitente, 'cStat:', cStatM);
            await new Promise(r=>setTimeout(r,3000));
            try {
              const proc = await consultarNFeByChave(cert.pfxBase64, cert.senha, CNPJ_EMP, nfe.chNFe, 'prod');
              const completas = parsearDocZips(proc.xml);
              for (const nfeC of completas) {
                if (!nfeC.chNFe) continue;
                console.log('procNFe:', nfeC.emitente, 'itens:', nfeC.itens?.length||0, 'venc:', nfeC.vencimento||'-');
                if (nfeC.itens?.length) await lancarEstoqueNFeSefaz(nfeC,nfeC,SB_URL,SB_KEY).catch(()=>{});
                if (nfeC.vencimento) {
                  const cp = data.contasPagar.find(c=>c.id==='sefaz_cp_'+nfeC.chNFe);
                  if (cp) { cp.venc=nfeC.vencimento; cp._estimado=false; }
                }
              }
              await salvarBlob(data, deviceId);
            } catch(ep) { console.log('consChNFe err:', ep.message); }
          }).catch(e=>console.log('Ciência err:', e.message));
      }
    }

    await salvarBlob(data, deviceId);

    // Notifica apenas NFs novas
    if (nfesNovas.length) {
      const resumo = nfesNovas.map(n=>`• ${n.emitente||'?'} — R$${Number(n.valor||0).toFixed(2)}`).join('\n');
      await wppParaTodos(`📄 SEFAZ: ${nfesNovas.length} NF(s) nova(s):\n${resumo}\n\nLançado no sistema!`);
    }
  } catch(e) { console.error('SEFAZ err:', e.message); }
}



// ── Módulo SEFAZ ──────────────────────────────────────────

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

function parsearNFesDoXML(xmlResp){
  // Extrai os documentos fiscais (NF-e XML) da resposta da SEFAZ
  const nfes=[];
  const matches=xmlResp.matchAll(/<chNFe>(\d{44})<\/chNFe>[\s\S]*?<NSU>(\d+)<\/NSU>/g);
  for(const m of matches)nfes.push({chave:m[1],nsu:m[2]});
  return nfes;
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

// ── Pluggy importar transações ────────────────────────────
async function importarTransacoesPluggy() {
  try {
    const { data, deviceId } = await lerBlob();
    const ids = data.pluggyItemIds || [];
    if (!ids.length) return;
    const hoje = new Date();
    const dataInicio = new Date(hoje); dataInicio.setDate(hoje.getDate()-90); // 3 meses
    const fmtDate = d => d.toISOString().slice(0,10);
    const fmtDia = s => s ? s.slice(0,10).split('-').reverse().join('/') : '';
    let total = 0;
    const vistas = new Set();
    console.log('Pluggy: processando '+ids.length+' itemIds');
    for (const id of ids) {
      const contas = await pluggyGet('/accounts?itemId='+id).catch(e=>{console.log('Contas err '+id.slice(0,8)+':',e.message);return{};});
      if (!contas.results) { console.log('Pluggy: sem contas para item '+id.slice(0,8)); continue; }
      console.log('Pluggy item '+id.slice(0,8)+': '+contas.results.length+' contas');
      for (const conta of contas.results) {
        if (vistas.has(conta.id)) continue;
        vistas.add(conta.id);
        if ((conta.type||'').toUpperCase()==='CREDIT') continue;
        // Usa v2/transactions com paginação por cursor
        let cursor = null, totalTxConta = 0;
        do {
          const url = '/v2/transactions?accountId='+conta.id+(cursor?'&cursor='+cursor:'');
          const page = await pluggyGet(url).catch(e=>{console.log('Tx v2 err:',e.message);return{};});
          // v2 usa "resultados" em PT ou "results" em EN
          const txList = page.resultados || page.results;
          if (!txList) break;
          console.log('Pluggy v2 '+conta.name.slice(0,10)+': '+txList.length+' txs');
          totalTxConta += txList.length;
          for (const tx of txList) {
          // v2: amount/valor positivo = crédito, negativo = débito
          const valorRaw = Number(tx.amount||tx.valor||0);
          if (valorRaw >= 0) continue; // ignora créditos
          const valor = Math.abs(valorRaw);
          if (valor<0.01) continue;
          // v2: data em PT ou date em EN
          const dataStr = tx.date||tx.data||'';
          const dia = fmtDia(dataStr); if (!dia) continue;
          // v2: descrição em PT ou description em EN
          const descRaw = tx.description||tx.descrição||tx.descriptionRaw||tx.descriçãoRaw||'Transação';
          const desc = descRaw.slice(0,80);
          // Monta objeto compatível com classificarPluggy
          const txCompat = {
            description: desc,
            category: tx.category||tx.categoria||'',
            paymentData: tx.paymentData,
            amount: valorRaw
          };
          const cat = classificarPluggy(txCompat);
          if (cat==='__IGNORAR__') continue;
          await gravarLancamento('pluggy_'+tx.id,'custo',dia,desc,cat,valor,'pluggy_auto');
          total++;
          }
          cursor = page.nextCursor||page.proximoCursor||null;
        } while (cursor);
      }
    }
    console.log('Pluggy: '+total+' transações importadas');
  } catch(e) { console.error('Pluggy err:', e.message); }
}

function classificarPluggy(tx) {
  const desc = (tx.description||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const cat = (tx.category||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  if (cat.includes('same person')||cat.includes('mesma pessoa')||desc.includes('conta stone')||desc.includes('pedra de conta')) return '__IGNORAR__';
  if (cat.includes('check')||cat.includes('verificac')||desc.includes('cheque')) return '🔖 Cheque Compensado';
  if (cat.includes('loans')||cat.includes('emprestimos')||desc.includes('parcela')) return '🏦 Empréstimo/Financiamento';
  if (cat.includes('proceeds')||cat.includes('rendimentos')) return '📈 Investimento';
  if (desc.startsWith('tar ')||desc.includes('tarifa')||desc.includes('ccf')||desc.includes('mensalidade maquininha')) return '🏦 Tarifas Bancárias';
  if (desc.includes('iof')) return '💳 Taxas/Impostos';
  if (desc.includes('juro')||desc.includes('encargo')) return '⚠️ Juros/Multa';
  if (desc.includes('pix')||desc.startsWith('deb pix')) return '🔄 PIX Enviado';
  if (cat.includes('services')||cat.includes('servicos')||cat.includes('entrepreneurial')||cat.includes('atividades')) return '🏢 Custos Fixos';
  if (cat.includes('healthcare')||cat.includes('assistencia')) return '🏢 Custos Fixos';
  if (cat.includes('transfers')||cat.includes('transferencias')) return '🔄 Transferência';
  return '🔄 Outros';
}

// ── Agendador ─────────────────────────────────────────────
let _ultimoSefaz = '', _ultimoSaldo = '', _ultimoPDF = '', _ultimoAlerta = '';
let _saldoDebounce = null;

setInterval(async () => {
  const agora = new Date();
  const hUTC = agora.getUTCHours();
  const dia = agora.toISOString().slice(0,10);

  // 3h Brasília = 6h UTC: SEFAZ + Pluggy
  if (hUTC===6 && _ultimoSefaz!==dia) {
    _ultimoSefaz = dia;
    consultarNFsSEFAZ().catch(e=>console.error('SEFAZ err:',e.message));
    if (PLUGGY_CID && PLUGGY_CSEC) importarTransacoesPluggy().catch(e=>console.error('Pluggy err:',e.message));
  }

  // 6h Brasília = 9h UTC: PDF do dia anterior
  if (hUTC===9 && _ultimoPDF!==dia) {
    _ultimoPDF = dia;
    enviarPDF().catch(e=>console.error('PDF err:',e.message));
  }

  // 7h Brasília = 10h UTC: alertas de contas vencendo
  if (hUTC===10 && _ultimoAlerta!==dia) {
    _ultimoAlerta = dia;
    alertaContasVencendo().catch(e=>console.error('Alerta err:',e.message));
  }

  // Fallback saldos 11h Brasília = 14h UTC (se webhook não disparou)
  if (hUTC===14 && _ultimoSaldo!==dia) {
    _ultimoSaldo = dia;
    if (PLUGGY_CID && PLUGGY_CSEC) enviarSaldos().catch(e=>console.error('Saldos err:',e.message));
  }
}, 30*60*1000);

// ── Servidor HTTP ────────────────────────────────────────
http.createServer(async (req, res) => {
  // Rotas GET
  if (req.method==='GET') {
    if (req.url==='/') { res.writeHead(200); res.end(JSON.stringify({status:'ok v9'})); return; }
    if (req.url==='/ultimo-grupo') { res.writeHead(200); res.end(JSON.stringify({ultimoGrupoId:global._ultimoGrupoId||null})); return; }
    if (req.url && req.url.startsWith('/ultimo-grupo?debug')) {
      try {
        const lr = await sb('GET','/rest/v1/lancamentos?select=tipo,dia_comercial,valor,device_id&limit=2000');
        const pd={};
        if (Array.isArray(lr)) lr.forEach(l=>{const d=l.dia_comercial||'?';if(!pd[d])pd[d]={r:0,c:0,tr:0,tc:0};if(l.tipo==='receita'){pd[d].r++;pd[d].tr+=Number(l.valor||0);}else{pd[d].c++;pd[d].tc+=Number(l.valor||0);}});
        const {data} = await lerBlob();
        res.writeHead(200,{'Content-Type':'application/json'});
        res.end(JSON.stringify({total:Array.isArray(lr)?lr.length:0,porDia:pd,pluggyItemIds:data.pluggyItemIds||[]},null,2));
      } catch(e) { res.writeHead(200); res.end(JSON.stringify({erro:e.message})); }
      return;
    }
    if (req.url==='/test-saldos') { enviarSaldos().then(()=>res.end('ok')).catch(e=>res.end(e.message)); return; }
    if (req.url==='/test-pdf') { enviarPDF().then(()=>res.end('ok')).catch(e=>res.end(e.message)); return; }
    if (req.url==='/test-sefaz') { consultarNFsSEFAZ().then(()=>res.end('ok')).catch(e=>res.end(e.message)); return; }
    if (req.url==='/test-pluggy') { importarTransacoesPluggy().then(()=>res.end('ok')).catch(e=>res.end(e.message)); return; }
    if (req.url==='/test-pluggy-tx') {
      (async()=>{
        try {
          const {data} = await lerBlob();
          const ids = data.pluggyItemIds||[];
          const resultado = {};
          for (const id of ids.slice(0,2)) {
            const contas = await pluggyGet('/accounts?itemId='+id).catch(e=>({erro:e.message}));
            if (!contas.results) { resultado[id.slice(0,8)]={erro:'sem contas',raw:contas}; continue; }
            for (const conta of contas.results.slice(0,1)) {
              if ((conta.type||'').toUpperCase()==='CREDIT') continue;
              // Tenta sem filtro de data
              const tx1 = await pluggyGet('/v2/transactions?accountId='+conta.id).catch(e=>({erro:e.message}));
              const tx2 = await pluggyGet('/v2/transactions?accountId='+conta.id+'&cursor=').catch(e=>({erro:e.message}));
              resultado[conta.name.slice(0,10)] = {
                semFiltro: {total:tx1.results?.length||0, raw:JSON.stringify(tx1).slice(0,300)},
                comFiltro: {total:tx2.results?.length||0, raw:JSON.stringify(tx2).slice(0,300)}
              };
            }
          }
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify(resultado,null,2));
        } catch(e) { res.writeHead(200); res.end(JSON.stringify({erro:e.message})); }
      })();
      return;
    }
    if (req.url==='/pluggy-force-sync') {
      (async()=>{
        const {data} = await lerBlob();
        const ids = data.pluggyItemIds||[];
        const res2=[];
        for(const id of ids){
          const r=await (async()=>{const k=await pluggyAuth();return httpReq('POST','https://api.pluggy.ai/items/'+id+'/update',{},{'X-API-KEY':k,'Content-Type':'application/json'});})().catch(e=>({erro:e.message}));
          res2.push({id:id.slice(0,8),resultado:r.status||r.erro||'enviado'});
          console.log('Force sync:',id.slice(0,8),r.status||r.erro||'ok');
        }
        res.writeHead(200); res.end(JSON.stringify({ok:true,itens:ids.length,resultados:res2,aviso:'Aguarde 5-10min'}));
      })().catch(e=>{res.writeHead(200);res.end(JSON.stringify({erro:e.message}));});
      return;
    }
    if (req.url==='/limpar-pluggy-duplicados') {
      (async()=>{
        const {data,deviceId} = await lerBlob();
        const ids = data.pluggyItemIds||[];
        const contasVistas=new Set(), idsUnicos=[];
        for (const id of ids) {
          const contas = await pluggyGet('/accounts?itemId='+id).catch(()=>({}));
          if (!contas.results||!contas.results.length) continue;
          const novas = contas.results.filter(c=>!contasVistas.has(c.id));
          if (novas.length>0) { idsUnicos.push(id); contas.results.forEach(c=>contasVistas.add(c.id)); }
        }
        data.pluggyItemIds=idsUnicos;
        await salvarBlob(data,deviceId);
        res.writeHead(200); res.end(JSON.stringify({ok:true,antes:ids.length,depois:idsUnicos.length,idsUnicos}));
      })().catch(e=>{res.writeHead(200);res.end(JSON.stringify({erro:e.message}));});
      return;
    }
    if (req.url==='/pluggy-connect') {
      (async()=>{
        const ct = await (async()=>{
          const k=await pluggyAuth();
          return httpReq('POST','https://api.pluggy.ai/connect_token',{clientUserId:'dicasalaranjinha'},{'X-API-KEY':k,'Content-Type':'application/json'});
        })();
        const token = ct.accessToken||'';
        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Conectar Bancos</title><script src="https://cdn.pluggy.ai/pluggy-connect/latest/pluggy-connect.js"></script></head>
<body style="background:#0a0a0f;color:#fff;font-family:sans-serif;padding:20px;box-sizing:border-box;">
<div style="max-width:400px;margin:40px auto;text-align:center;">
<p style="font-size:40px">🏦</p><h2>Conectar Banco</h2>
<p style="color:#888;font-size:13px;margin-bottom:24px">Di Casa Laranjinha</p>
<input type="hidden" id="t" value="${token}">
<button onclick="abrirPluggy()" style="padding:14px 32px;border-radius:10px;border:none;background:#0066ff;color:#fff;font-size:15px;font-weight:700;cursor:pointer;width:100%">🔗 Conectar banco</button>
<p id="s" style="margin-top:16px;color:#888;font-size:13px"></p></div>
<script>
function abrirPluggy(){
  document.getElementById('s').textContent='Abrindo...';
  try{
    var p=new PluggyConnect({connectToken:document.getElementById('t').value,
      onSuccess:function(d){
        var id=d&&d.item&&d.item.id?d.item.id:'';
        document.getElementById('s').textContent='Salvando...';
        fetch('/pluggy-save-item',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({itemId:id})})
          .then(function(r){return r.json();}).then(function(r){document.getElementById('s').textContent=r.ok?'✅ Conectado! Conecte outro se quiser.':'Erro: '+r.erro;});
      },
      onError:function(e){document.getElementById('s').textContent='Erro: '+(e.message||JSON.stringify(e));},
      onClose:function(){document.getElementById('s').textContent='Fechado.';}});
    p.init();
  }catch(e){document.getElementById('s').textContent='Erro: '+e.message;}
}
</script></body></html>`;
        res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'}); res.end(html);
      })().catch(e=>{res.writeHead(200);res.end('Erro: '+e.message);});
      return;
    }
    res.writeHead(200); res.end(JSON.stringify({status:'ok v9'}));
    return;
  }

  // Rotas POST
  let body='';
  req.on('data',c=>body+=c);
  req.on('end', async()=>{
    try {
      // Ignora body vazio (health checks do Render)
      if (!body || !body.trim()) { res.writeHead(200); res.end('ok'); return; }

      if (req.url==='/pluggy-save-item') {
        const {itemId} = JSON.parse(body);
        if (!itemId) { res.writeHead(400); res.end(JSON.stringify({ok:false})); return; }
        const {data,deviceId} = await lerBlob();
        if (!data.pluggyItemIds) data.pluggyItemIds=[];
        if (!data.pluggyItemIds.includes(itemId)) data.pluggyItemIds.push(itemId);
        await salvarBlob(data,deviceId);
        res.writeHead(200); res.end(JSON.stringify({ok:true,total:data.pluggyItemIds.length}));
        return;
      }

      const ev = JSON.parse(body);

      // Webhook Evolution API (WhatsApp)
      if (ev.event && ['messages.upsert','message.upsert'].includes(ev.event)) {
        const msg = ev.data;
        if (!msg||!msg.key||!msg.key.remoteJid||!msg.key.remoteJid.includes('@g.us')) { res.writeHead(200); res.end('ok'); return; }
        const grupoId = msg.key.remoteJid;
        global._ultimoGrupoId = grupoId;
        if (!msg.key.fromMe) {
          processarMensagemBot(msg, grupoId).catch(e=>console.error('Bot err:',e.message));
        }
        res.writeHead(200); res.end('ok');
        return;
      }

      // Webhook Pluggy
      if (ev.event && (ev.event.includes('pluggy')||ev.event.includes('item')||ev.event.includes('transaction')||ev.event.includes('boleto'))) {
        const evtName = ev.event||'';
        const itemId = ev.itemId||(ev.item&&ev.item.id);
        console.log('Pluggy webhook:', evtName, itemId?.slice(0,8));

        if (evtName==='item/updated'||evtName==='item.updated') {
          importarTransacoesPluggy().catch(()=>{});
          if (_saldoDebounce) clearTimeout(_saldoDebounce);
          _saldoDebounce = setTimeout(()=>enviarSaldos().catch(()=>{}), 5*60*1000);
        }
        if (evtName==='item/created'||evtName==='item.created') {
          if (itemId) {
            const {data,deviceId} = await lerBlob();
            if (!data.pluggyItemIds) data.pluggyItemIds=[];
            if (!data.pluggyItemIds.includes(itemId)) { data.pluggyItemIds.push(itemId); await salvarBlob(data,deviceId); }
          }
        }
        if (evtName==='item/error'||evtName==='item/waiting_user_input') {
          const banco = ev.connector?.name||'Banco';
          await wppParaTodos('⚠️ Banco '+banco+' desconectou. Reconecte em: gestaoerp-webhook.onrender.com/pluggy-connect');
        }
        if (evtName==='transactions/created'||evtName==='transactions/updated') {
          importarTransacoesPluggy().catch(()=>{});
        }
        if (evtName==='boleto/updated'||evtName==='boleto.updated') {
          const bol = ev.data||ev.boleto||{};
          const valor = Math.abs(Number(bol.amount||bol.value||0));
          const venc = (bol.dueDate||'').slice(0,10).split('-').reverse().join('/');
          const nome = (bol.beneficiary?.name||bol.description||'Boleto').slice(0,60);
          const cnpj = (bol.beneficiary?.documentNumber||bol.beneficiary?.taxNumber||'').replace(/\D/g,'');
          if (valor>0) {
            const {data,deviceId} = await lerBlob();
            if (!data.contasPagar) data.contasPagar=[];
            if (!data.estravio) data.estravio=[];
            const idBol='dda_'+(bol.id||Date.now());
            if (!data.contasPagar.find(cp=>cp.id===idBol)&&!data.estravio.find(e=>e.id===idBol)) {
              const nfMatch = data.contasPagar.find(cp=>{
                if(!cp._sefaz||cp.pago)return false;
                const c1=(cp.cnpjEmit||'').replace(/\D/g,'');
                return c1&&cnpj&&c1===cnpj;
              });
              if (nfMatch) {
                data.contasPagar.push({id:idBol,forn:nome,val:valor,venc,pago:false,_dda:true,_nfId:nfMatch.id});
                await wppParaTodos('📬 Boleto DDA:\n• '+nome+'\n• '+brl(valor)+'\n• Venc: '+venc+'\n• Vinculado à NF ✅');
              } else {
                data.estravio.push({id:idBol,desc:nome,valor,dia:venc,tipo:'DDA/Boleto',cnpj,revisado:false});
                await wppParaTodos('⚠️ Boleto sem NF:\n• '+nome+'\n• '+brl(valor)+'\n• Venc: '+venc+'\n• Verifique em 🔍 Estravio');
              }
              await salvarBlob(data,deviceId);
            }
          }
        }
        res.writeHead(200); res.end('ok');
        return;
      }

      res.writeHead(200); res.end('ok');
    } catch(e) {
      console.error('POST err:', e.message);
      res.writeHead(200); res.end('ok');
    }
  });
}).listen(PORT, ()=>{
  console.log('GestaoERP v9 porta '+PORT);
  console.log('Anthropic:', CLAUDE_KEY?'OK':'FALTANDO');
  console.log('GitHub:', GHTOKEN?'OK':'FALTANDO');
});

