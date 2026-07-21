'use strict';
// ═══════════════════════════════════════════════════════════
// GestaoERP — Servidor v9 (reconstrução limpa)
// Di Casa Laranjinha — Patos de Minas MG
// ═══════════════════════════════════════════════════════════
const https = require('https');
const http  = require('http');
const zlib  = require('zlib');

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
  const r = await sb('GET', '/rest/v1/erp_sync?select=data,device_id&order=updated_at.desc&limit=20');
  if (!Array.isArray(r)||!r.length) return { data:{}, deviceId:'v9' };
  // Mescla todas as linhas preservando certificado e dados importantes
  const merged = {};
  // Processa do mais antigo para o mais recente (mais recente sobrescreve)
  for (const row of [...r].reverse()) {
    try {
      const d = JSON.parse(row.data||'{}');
      Object.assign(merged, d);
      // Certificado: sempre preserva se existir em qualquer linha
      if (d.dadosFiscais && d.dadosFiscais.certificado) {
        if (!merged.dadosFiscais) merged.dadosFiscais = {};
        merged.dadosFiscais.certificado = d.dadosFiscais.certificado;
        if (d.dadosFiscais.ultimoNSU) merged.dadosFiscais.ultimoNSU = d.dadosFiscais.ultimoNSU;
      }
      // pluggyItemIds: usa o da linha mais recente que tiver
      if (d.pluggyItemIds && d.pluggyItemIds.length) merged.pluggyItemIds = d.pluggyItemIds;
      // contasPagar: merge sem duplicar
      if (d.contasPagar) {
        if (!merged.contasPagar) merged.contasPagar = [];
        d.contasPagar.forEach(cp => { if (!merged.contasPagar.find(x=>x.id===cp.id)) merged.contasPagar.push(cp); });
      }
    } catch(e) {}
  }
  const deviceId = r[0].device_id || 'v9';
  return { data:merged, deviceId };
}

const BLOB_DEVICE_ID = 'gestaoerp_v9';
async function salvarBlob(data, deviceId) {
  // Sempre usa device_id fixo para não fragmentar dados em múltiplas linhas
  return sb('POST', '/rest/v1/erp_sync',
    { device_id: BLOB_DEVICE_ID, data:JSON.stringify(data) },
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
        // Usa saldo em tempo real se disponível
        let saldoReal = Number(c.balance||0);
        try {
          const bal = await pluggyGet('/accounts/'+c.id+'/balance').catch(()=>null);
          if (bal && bal.balance !== undefined) saldoReal = Number(bal.balance);
        } catch(e) {}
        if ((c.type||'').toUpperCase()==='CREDIT') cartoes.push({nome:c.name.trim(), saldo:saldoReal});
        else bancos.push({nome:nomeBanco, saldo:saldoReal});
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
          const catTx = (tx.category||tx.categoria||'').toLowerCase();
        if (metodo.includes('check')||catTx.includes('check')||catTx.includes('verifica')||desc.includes('cheque')||desc.includes('saque din ag')) {
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

    // Envia o resumo em texto
    await wppParaTodos(linhas.join('\n'));

    // Envia calendário de vencimentos como PDF
    try {
      const {data:blobCal} = await lerBlob();
      const pdfBuf = await gerarCalendarioPDF(blobCal.contasPagar||[]);
      const pdfB64 = pdfBuf.toString('base64');
      const mesNome = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][new Date().getMonth()];
      for (const num of DESTINOS) {
        await httpReq('POST', EVO_URL+'/message/sendMedia/'+INSTANCE,
          { number:num, mediatype:'document', mimetype:'application/pdf',
            fileName:'vencimentos_'+mesNome+'.pdf',
            caption:'📅 Calendário de Vencimentos — '+mesNome,
            media:pdfB64 },
          { apikey:EVO_KEY, 'Content-Type':'application/json' }
        ).catch(e=>console.log('PDF cal err:',e.message));
      }
      console.log('Calendário PDF enviado');
    } catch(ep) { console.log('Calendário err:', ep.message); }
    console.log('Saldos enviados OK. Total banco:', totalBanco.toFixed(2));
  } catch(e) { console.error('Erro saldos:', e.message); }
}

// ── PDF das 6h ───────────────────────────────────────────

// Gera PDF de calendário de vencimentos mensal
async function gerarCalendarioPDF(contasPagar) {
  return new Promise((resolve, reject) => {
    try {
      const PDFDocument = require('pdfkit');
      const doc = new PDFDocument({ size: [595, 420], margin: 0 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const hoje = new Date();
      const mes = hoje.getMonth();
      const ano = hoje.getFullYear();
      const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
      const diasSem = ['D','S','T','Q','Q','S','S'];

      // Fundo escuro
      doc.rect(0,0,595,420).fill('#0f0f1a');

      // Header
      doc.rect(0,0,595,52).fill('#1a1a2e');
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#ffffff')
        .text('Di Casa Laranjinha', 20, 12);
      doc.font('Helvetica').fontSize(11).fillColor('#aaaaaa')
        .text('Calendário de Vencimentos — '+meses[mes]+' '+ano, 20, 32);

      // Legenda
      doc.rect(310,14,12,12).fill('#ff8800');
      doc.font('Helvetica').fontSize(9).fillColor('#cccccc').text('Boleto', 326, 16);
      doc.rect(380,14,12,12).fill('#ff3333');
      doc.text('Cheque Sant.', 396, 16);
      doc.rect(465,14,12,12).fill('#3388ff');
      doc.text('Cheque Caixa', 481, 16);

      // Monta mapa de vencimentos do mês
      const vencMes = {};
      (contasPagar||[]).filter(cp=>!cp.pago).forEach(cp => {
        const vStr = cp.venc||cp.vencimento; if(!vStr) return;
        const [dd,mm,yy] = vStr.split('/');
        if(Number(mm)-1 !== mes || Number(yy) !== ano) return;
        const dia = parseInt(dd);
        if(!vencMes[dia]) vencMes[dia] = {boletos:[], cheqSant:[], cheqCaixa:[]};
        const tipo = (cp.pag||cp.tipo||'boleto').toLowerCase();
        const banco = (cp.banco||cp.forn||'').toLowerCase();
        if(tipo.includes('cheque')) {
          if(banco.includes('santander')||banco.includes('sant')) vencMes[dia].cheqSant.push(Number(cp.val||cp.valor||0));
          else vencMes[dia].cheqCaixa.push(Number(cp.val||cp.valor||0));
        } else {
          vencMes[dia].boletos.push(Number(cp.val||cp.valor||0));
        }
      });

      const brl = v => 'R$'+Number(v).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});

      // Grade do calendário
      const TOP = 60, LEFT = 10, COLS = 7;
      const CW = (595-LEFT*2)/COLS, CH = 52;

      // Cabeçalho dias da semana
      diasSem.forEach((d,i) => {
        doc.rect(LEFT+i*CW, TOP, CW, 22).fill(i===0||i===6?'#2a1a1a':'#1e1e2e').stroke();
        doc.font('Helvetica-Bold').fontSize(10).fillColor(i===0||i===6?'#ff6666':'#888888')
          .text(d, LEFT+i*CW+CW/2-5, TOP+6);
      });

      // Dias do mês
      const primeiroDia = new Date(ano, mes, 1).getDay();
      const ultimoDia = new Date(ano, mes+1, 0).getDate();
      let dia = 1;
      for(let semana=0; semana<6 && dia<=ultimoDia; semana++) {
        for(let col=0; col<7; col++) {
          if(semana===0 && col<primeiroDia) continue;
          if(dia>ultimoDia) break;
          const x = LEFT+col*CW, y = TOP+22+semana*CH;
          const isHoje = dia===hoje.getDate();
          const temVenc = vencMes[dia];

          // Fundo da célula
          let bgColor = '#13131f';
          if(isHoje) bgColor = '#1a2a1a';
          if(temVenc) bgColor = '#1f1515';
          doc.rect(x,y,CW,CH).fill(bgColor).stroke();
          if(isHoje) doc.rect(x,y,CW,2).fill('#00cc66');

          // Número do dia
          doc.font('Helvetica-Bold').fontSize(11)
            .fillColor(isHoje?'#00cc66':col===0||col===6?'#ff6666':'#888888')
            .text(String(dia), x+4, y+4);

          // Valores de vencimento
          if(temVenc) {
            let yOff = 20;
            const totalBol = temVenc.boletos.reduce((a,b)=>a+b,0);
            if(totalBol>0) {
              doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ff8800')
                .text(brl(totalBol), x+2, y+yOff, {width:CW-4, align:'center'});
              yOff+=11;
            }
            const totalCS = temVenc.cheqSant.reduce((a,b)=>a+b,0);
            if(totalCS>0) {
              doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ff3333')
                .text(brl(totalCS), x+2, y+yOff, {width:CW-4, align:'center'});
              yOff+=11;
            }
            const totalCC = temVenc.cheqCaixa.reduce((a,b)=>a+b,0);
            if(totalCC>0) {
              doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#3388ff')
                .text(brl(totalCC), x+2, y+yOff, {width:CW-4, align:'center'});
            }
          }
          dia++;
        }
      }

      // Rodapé com totais
      const totalAberto = (contasPagar||[]).filter(cp=>!cp.pago).reduce((a,cp)=>a+Number(cp.val||cp.valor||0),0);
      const vencidas = (contasPagar||[]).filter(cp=>!cp.pago&&(()=>{
        const v=cp.venc||cp.vencimento;if(!v)return false;
        const [d,m,y]=v.split('/');return new Date(Number(y),Number(m)-1,parseInt(d))<hoje;
      })());
      doc.rect(0,380,595,40).fill('#1a1a2e');
      doc.font('Helvetica').fontSize(9).fillColor('#aaaaaa')
        .text('Total em aberto: ', 20, 392);
      doc.font('Helvetica-Bold').fillColor('#ffffff')
        .text(brl(totalAberto), 110, 392, {continued:true})
        .fillColor('#aaaaaa').font('Helvetica')
        .text('   Vencidas: ', {continued:true})
        .fillColor(vencidas.length>0?'#ff4444':'#00cc66').font('Helvetica-Bold')
        .text(String(vencidas.length));
      doc.font('Helvetica').fontSize(8).fillColor('#555555')
        .text('Gerado em '+new Date().toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}), 395, 392);

      doc.end();
    } catch(e) { reject(e); }
  });
}

async function enviarPDF() {
  try {
    const hoje = new Date();
    hoje.setHours(hoje.getHours()-3); // Brasília
    const ontem = new Date(hoje); ontem.setDate(ontem.getDate()-1);
    const diaOntem = ontem.toLocaleDateString('pt-BR'); // DD/MM/YYYY

    // Lê lançamentos do dia anterior
    const rows = await sb('GET', `/rest/v1/lancamentos?dia_comercial=eq.${diaOntem}&select=tipo,valor,descricao,categoria,device_id&limit=500`);
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
      '*📊 Di Casa Laranjinha*',
      `_Resumo do dia ${diaOntem}_`,
      '',
      `*💰 Receita total: ${brl(totalR)}*`,
      `  • Vendas STi3: ${brl(receitas.filter(r=>r.device_id==='sti3_auto').reduce((a,r)=>a+Number(r.valor||0),0))}`,
      `  • Bot/Outros: ${brl(receitas.filter(r=>r.device_id!=='sti3_auto').reduce((a,r)=>a+Number(r.valor||0),0))}`,
      '',
      `*📦 Custo total: ${brl(totalC)}*`,
    ];

    if (Object.keys(porCat).length) {
      Object.entries(porCat)
        .sort((a,b)=>b[1]-a[1])
        .slice(0,8)
        .forEach(([cat,val])=>linhas.push(`  • ${cat}: ${brl(val)}`));
    }

    linhas.push('');
    const emoji = resultado>=0 ? '✅' : '❌';
    linhas.push(`*${emoji} Resultado: ${brl(resultado)}*`);

    if (totalR===0 && totalC===0) {
      linhas.push('', '_Sem lançamentos para ontem_');
      console.log('PDF: sem dados para', diaOntem);
    }

    await wppParaTodos(linhas.join('\n'));

    // Envia calendário de vencimentos como PDF
    try {
      const {data:blobCal} = await lerBlob();
      const pdfBuf = await gerarCalendarioPDF(blobCal.contasPagar||[]);
      const pdfB64 = pdfBuf.toString('base64');
      const mesNome = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'][new Date().getMonth()];
      for (const num of DESTINOS) {
        await httpReq('POST', EVO_URL+'/message/sendMedia/'+INSTANCE,
          { number:num, mediatype:'document', mimetype:'application/pdf',
            fileName:'vencimentos_'+mesNome+'.pdf',
            caption:'📅 Calendário de Vencimentos — '+mesNome,
            media:pdfB64 },
          { apikey:EVO_KEY, 'Content-Type':'application/json' }
        ).catch(e=>console.log('PDF cal err:',e.message));
      }
      console.log('Calendário PDF enviado');
    } catch(ep) { console.log('Calendário err:', ep.message); }

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
        'Categorias possíveis (escolha a mais adequada):\n'+
        '- 🥩 Matéria Prima: compras de alimentos, bebidas, ingredientes\n'+
        '- 👥 RH / Mão de Obra: salário, diária, entregador, diarista, funcionário, freelancer, show, evento, artista\n'+
        '- 🏢 Custos Fixos: aluguel, energia, água, internet, manutenção, seguro\n'+
        '- 📦 Embalagem: embalagem, caixa, sacola, descartável\n'+
        '- 💳 Taxas/Impostos: imposto, taxa, IOF, tarifa bancária\n'+
        '- 🔄 Outros: qualquer outra coisa\n'+
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

    console.log('STi3: total linhas='+rows.length);

    // Detecta cabeçalho buscando linha com "Venda" em col[0]
    let colData=-1, colValor=-1, headerRow=-1;
    for (let i=0;i<Math.min(30,rows.length);i++) {
      const r=rows[i]; if(!r) continue;
      const c0=String(r[0]||'').trim().toLowerCase();
      if (c0==='venda'||c0==='nr venda'||c0==='nrvenda') {
        headerRow=i;
        console.log('STi3: cabecalho em L'+i+': '+r.map((v,j)=>v?'['+j+']='+String(v).slice(0,10):null).filter(Boolean).join(' '));
        for (let j=0;j<r.length;j++) {
          const cel=String(r[j]||'').trim().toLowerCase();
          if (cel==='data'||cel==='data venda'||cel==='dtvenda') colData=j;
          if (cel==='valor'||cel==='vl.total'||cel==='total'||cel==='valor total') colValor=j;
        }
        break;
      }
    }

    // Valida colValor — deve conter numero, não data
    if (colValor>=0 && headerRow>=0) {
      const linhaRef = rows[headerRow+1]||[];
      const valRef = linhaRef[colValor];
      if (valRef instanceof Date || (typeof valRef==='string' && /\d{4}-\d{2}/.test(valRef))) {
        console.log('STi3: colValor='+colValor+' tem data, buscando coluna numerica...');
        colValor=-1;
      }
    }

    // Se não achou Valor pelo cabeçalho, busca pela primeira coluna numérica real nas linhas de dados
    if (colValor<0 && headerRow>=0) {
      const linhaRef = rows[headerRow+1]||[];
      for (let j=linhaRef.length-1;j>colData;j--) {
        const v=linhaRef[j];
        if (typeof v==='number' && v>0 && v<100000 && j!==colData) { colValor=j; break; }
        if (typeof v==='string') {
          const n=parseFloat(v.replace(',','.'));
          if (!isNaN(n)&&n>0&&n<100000) { colValor=j; break; }
        }
      }
    }

    console.log('STi3: colData='+colData+' colValor='+colValor+' headerRow='+headerRow);
    if (colData<0||colValor<0) throw new Error('Colunas Data/Valor não encontradas. colData='+colData+' colValor='+colValor);

    const porDia={};let linhas=0,erros=0;
    for (let i=(headerRow>=0?headerRow+1:1);i<rows.length;i++) {
      const r=rows[i]; if(!r) continue;
      const c0=Number(String(r[0]||'').replace(/\./g,'').replace(',','').trim());
      if (!c0||isNaN(c0)||c0<=0) continue;

      // Data
      let dataFmt=null;
      const dv=r[colData];
      if (dv instanceof Date&&!isNaN(dv)) {
        dataFmt=String(dv.getUTCDate()).padStart(2,'0')+'/'+String(dv.getUTCMonth()+1).padStart(2,'0')+'/'+dv.getUTCFullYear();
      } else if (typeof dv==='string'&&dv.trim()) {
        const s=dv.trim();
        let m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        if(m) dataFmt=m[1].padStart(2,'0')+'/'+m[2].padStart(2,'0')+'/'+m[3];
        if(!m){m=s.match(/^(\d{4})-(\d{2})-(\d{2})/);if(m)dataFmt=m[3]+'/'+m[2]+'/'+m[1];}
      }
      if (!dataFmt){erros++;continue;}

      // Valor
      let valor=r[colValor];
      if (valor instanceof Date) {erros++;continue;} // era coluna de data errada
      if (typeof valor!=='number') valor=parseFloat(String(valor||'0').replace(',','.'));
      if (!valor||valor<=0) continue;

      if (!porDia[dataFmt]) porDia[dataFmt]=0;
      porDia[dataFmt]+=valor;
      linhas++;
    }

    if (!linhas) throw new Error('Nenhuma venda. Erros de data: '+erros);

    const dias=Object.keys(porDia).sort();
    for (const dia of dias) {
      await gravarLancamento('sti3_'+dia.replace(/\//g,''),'receita',dia,'STi3 Vendas','💰 Receita/Vendas',porDia[dia],'sti3_auto');
    }

    // Atualiza blob
    const {data:blobData,deviceId:blobDev}=await lerBlob();
    for (const dia of dias) {
      if (!blobData[dia]) blobData[dia]={r:[],c:[]};
      if (!blobData[dia].r) blobData[dia].r=[];
      blobData[dia].r=blobData[dia].r.filter(x=>x.fonte!=='sti3');
      blobData[dia].r.push({id:'sti3_'+dia.replace(/\//g,''),d:'STi3 Vendas',v:porDia[dia],fonte:'sti3'});
    }
    await salvarBlob(blobData,blobDev);

    const total=Object.values(porDia).reduce((a,b)=>a+b,0);
    await wpp(grupoId,'✅ STi3 importado!\n• '+linhas+' vendas\n• '+dias.length+' dias\n• Período: '+dias[0]+' a '+dias[dias.length-1]+'\n• *Total: '+brl(total)+'*');
  } catch(e) {
    console.error('STi3 err:', e.message);
    await wpp(grupoId,'❌ STi3 erro: '+e.message);
  }
}


// ── SEFAZ Loop Principal ──────────────────────────────────
async function consultarNFsSEFAZ(nsuForcado) {
  try {
    const { data, deviceId } = await lerBlob();
    const cert = data.dadosFiscais && data.dadosFiscais.certificado;
    if (!cert || !cert.pfxBase64) { console.log('SEFAZ: sem certificado'); return; }

    let nsuAtual = nsuForcado || data.dadosFiscais.ultimoNSU || '000000000000000';
    console.log('SEFAZ: iniciando com NSU='+nsuAtual+(nsuForcado?' (FORCADO)':''));
    const todasNFs = [];
    let continuar = true, lote = 0;

    while (continuar && lote < 10) {
      lote++;
      const resp = await sefazDistribuicaoDFe(cert.pfxBase64, cert.senha, CNPJ_EMP, nsuAtual, 'prod');
      const cStat = extrairTagXML(resp.xml, 'cStat');
      const ultNSU = extrairTagXML(resp.xml, 'ultNSU');
      const maxNSU = extrairTagXML(resp.xml, 'maxNSU');
      console.log(`SEFAZ lote ${lote} - cStat:${cStat} ultNSU:${ultNSU} maxNSU:${maxNSU}`);
      if (lote===1) console.log('SEFAZ XML amostra:', resp.xml.slice(0,800).replace(/\n/g,' '));

      if (cStat !== '138' && cStat !== '137') break;
      // Usa parsearNFesDoXML para extrair resumo (resNFe) e parsearDocZips para XML completo (docZip)
      const resumos = parsearNFesDoXML(resp.xml);
      const completos = parsearDocZips(resp.xml);
      // Mescla: prefere dados completos (docZip), usa resumo (resNFe) quando não tem docZip
      const porChave = {};
      completos.forEach(n => { if(n.chNFe) porChave[n.chNFe]=n; });
      resumos.forEach(n => { const k=n.chNFe||n.chave; if(k && !porChave[k]){if(!n.chNFe)n.chNFe=k;porChave[k]=n;} });
      const loteNFs = Object.values(porChave);
      console.log(`SEFAZ lote ${lote}: ${resumos.length} resNFe, ${completos.length} docZip, ${loteNFs.length} total`);
      todasNFs.push(...loteNFs);
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

      // Detecta NF de bonificação (valor zero ou CFOP 5910/6910/1910)
      const isBonificacao = Number(nfe.valor||0) < 0.01 ||
        (nfe.cfop && /^[156]91/.test(String(nfe.cfop))) ||
        (nfe.natureza && /(bonifica|brindes?|doacao|gratuita)/i.test(nfe.natureza));

      if (isBonificacao) {
        console.log('SEFAZ: NF bonificacao (sem custo DRE):', nfe.emitente);
        // Só lança no estoque, não no DRE nem contas a pagar
        if (nfe.itens && nfe.itens.length) {
          await lancarEstoqueNFeSefaz(nfe, nfe, SB_URL, SB_KEY).catch(e=>console.log('Estoque bonif err:',e.message));
        }
        nfesNovas.push(nfe); // mantém na notificação
        continue;
      }

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


// Consulta XML completo da NF por chave (procNFe com <dup>)
async function consultarNFePorChave(certPfx, senha, cnpj, chNFe, ambiente='prod') {
  const { certPem, keyPem } = carregarCertPFX(certPfx, senha);
  const cnpjLimpo = cnpj.replace(/[^\d]/g,'');
  const url = ambiente==='prod'
    ? 'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx'
    : 'https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx';
  const soapEnv = `<?xml version="1.0" encoding="UTF-8"?><soap12:Envelope xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDadosMsg><distDFeInt versao="1.01" xmlns="http://www.portalfiscal.inf.br/nfe"><tpAmb>${ambiente==='prod'?'1':'2'}</tpAmb><cUFAutor>31</cUFAutor><CNPJ>${cnpjLimpo}</CNPJ><consChNFe><chNFe>${chNFe}</chNFe></consChNFe></distDFeInt></nfeDadosMsg></nfeDistDFeInteresse></soap12:Body></soap12:Envelope>`;
  const u = new URL(url);
  return new Promise((resolve,reject) => {
    const body = Buffer.from(soapEnv,'utf8');
    const opts = { hostname:u.hostname, path:u.pathname, method:'POST',
      headers:{'Content-Type':'application/soap+xml; charset=utf-8','Content-Length':body.length},
      cert:certPem, key:keyPem, rejectUnauthorized:false };
    const r = https.request(opts, res => {
      let d=''; const chunks=[];
      res.on('data',c=>{d+=c;chunks.push(Buffer.isBuffer(c)?c:Buffer.from(c));});
      res.on('end',()=>{
        const enc=res.headers['content-encoding']||'';
        if(enc.includes('gzip')){
          try{ resolve({status:res.statusCode,xml:zlib.gunzipSync(Buffer.concat(chunks)).toString('utf-8')}); }
          catch(eg){ resolve({status:res.statusCode,xml:d}); }
        } else { resolve({status:res.statusCode,xml:d}); }
      });
    });
    r.on('error',reject); r.write(body); r.end();
  });
}

// Extrai parcelas <dup> do procNFe completo
function extrairParcelas(xmlProcNFe, valorTotal, diaEmissao) {
  const dups = [...xmlProcNFe.matchAll(/<dup[^>]*>[\s\S]*?<\/dup>/g)];
  if (!dups.length) {
    // Sem parcelas: vencimento 30 dias após emissão
    const pts=(diaEmissao||'').split('/');
    let venc='';
    if(pts.length===3){const b=new Date(Number(pts[2]),Number(pts[1])-1,parseInt(pts[0])+30);venc=b.toLocaleDateString('pt-BR');}
    return [{val:Number(valorTotal||0), venc}];
  }
  return dups.map(m=>{
    const bloco=m[0];
    const tagV=(t)=>{const r=bloco.match(new RegExp('<'+t+'>([^<]*)<\/'+t+'>'));return r?r[1].trim():'';};
    const nDup=tagV('nDup');
    const dVenc=tagV('dVenc'); // YYYY-MM-DD
    const vDup=parseFloat(tagV('vDup')||'0');
    let vencFmt='';
    if(dVenc){const[y,m,d]=dVenc.split('-');vencFmt=d+'/'+m+'/'+y;}
    return {nDup, val:vDup, venc:vencFmt};
  });
}

function parsearNFesDoXML(xmlResp){
  // Extrai dados completos dos resumos resNFe da resposta SEFAZ
  const nfes=[];
  const xml=xmlResp.replace(/\r?\n/g,' ');
  const tag = (x,t) => { const m=x.match(new RegExp('<'+t+'>([^<]*)<\/'+t+'>')); return m?m[1].trim():''; };
  // Tenta resNFe (resumo)
  const blocos=xml.matchAll(/<resNFe>([\s\S]*?)<\/resNFe>/g);
  for(const b of blocos){
    const bloco=b[1];
    const chNFe=tag(bloco,'chNFe');
    if(!chNFe||chNFe.length!==44) continue;
    const cnpjEmit=tag(bloco,'CNPJ');
    const xNome=tag(bloco,'xNome');
    const dEmi=tag(bloco,'dEmi')||tag(bloco,'dhEmi')||'';
    const vNF=parseFloat(tag(bloco,'vNF')||'0');
    const nNF=tag(bloco,'nNF');
    // Converte data YYYY-MM-DD para DD/MM/YYYY
    let dataFmt='';
    if(dEmi){const[y,m,d]=(dEmi.split('T')[0]).split('-');dataFmt=d+'/'+m+'/'+y;}
    nfes.push({chNFe,cnpjEmit,emitente:xNome,valor:vNF,data:dataFmt,nNF,_resNFe:true});
  }
  // Fallback: chNFe simples
  if(!nfes.length){
    const matches=xml.matchAll(/<chNFe>(\d{44})<\/chNFe>/g);
    for(const m of matches)nfes.push({chNFe:m[1],emitente:'',valor:0,data:'',_resNFe:true});
  }
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
      let d='';const chunks=[];res.on('data',c=>{d+=c;chunks.push(Buffer.isBuffer(c)?c:Buffer.from(c));});
      res.on('end',()=>{
          const enc=res.headers['content-encoding']||'';
          if(enc.includes('gzip')){
            try{
              const buf=Buffer.concat(chunks);
              const xml=require('zlib').gunzipSync(buf).toString('utf-8');
              console.log('SEFAZ resp gzip descomp, len:',xml.length,'inicio:',xml.slice(0,200).replace(/\n/g,' '));
              resolve({status:res.statusCode,xml});
            }catch(eg){resolve({status:res.statusCode,xml:d});}
          } else {
            console.log('SEFAZ resp len:',d.length,'inicio:',d.slice(0,200).replace(/\n/g,' '));
            resolve({status:res.statusCode,xml:d});
          }
        });
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

function descompactarDocZip(docZipBase64) {
  const buf = Buffer.from(docZipBase64.replace(/\s/g,''), 'base64');
  try {
    return zlib.gunzipSync(buf).toString('utf-8');
  } catch(e) {
    console.log('descompactarDocZip err:', e.message, 'buf len:', buf.length, 'inicio:', buf.slice(0,4).toString('hex'));
    try { return zlib.inflateRawSync(buf).toString('utf-8'); } catch(e2) {}
    return buf.toString('utf-8');
  }
}

function parsearDocZips(xmlResp) {
  const nfes = [];
  const xmlNorm = xmlResp.replace(/\r?\n/g," ");
  const matches = xmlNorm.matchAll(/<docZip[^>]*schema="([^"]*)"[^>]*>([A-Za-z0-9+\/=\s]+)<\/docZip>/g);
  for (const m of matches) {
    const schema = m[1];
    const b64 = m[2].trim();
    if (!schema.includes('NFe') && !schema.includes('nfe') && !schema.includes('resNFe')) continue;
    try {
      const xmlNFe = descompactarDocZip(b64);
      let dados;
      if (schema.includes('resNFe') && !schema.includes('procNFe')) {
        // Resumo da NF (resNFe) — extrai dados básicos do docZip descomprimido
        const tagR = (t) => { const r=xmlNFe.match(new RegExp('<'+t+'[^>]*>([^<]*)<\/'+t+'>')); return r?r[1].trim():''; };
        const chNFe=tagR('chNFe');
        if(!chNFe||chNFe.length!==44){continue;}
        const dEmiStr=(tagR('dEmi')||tagR('dhEmi')||'').split('T')[0];
        let dataFmt='';
        if(dEmiStr){const[y,mm,dd]=dEmiStr.split('-');dataFmt=dd+'/'+mm+'/'+y;}
        dados={chNFe,cnpjEmit:tagR('CNPJ'),emitente:tagR('xNome'),valor:parseFloat(tagR('vNF')||'0'),data:dataFmt,nNF:tagR('nNF'),_resNFe:true};
        console.log('SEFAZ resNFe:', dados.emitente, dados.valor, dados.data);
      } else {
        dados = parsearNFeXML(xmlNFe);
      }
      // Extrai duplicatas (parcelas) da seção <cobr><dup> (só para XML completo)
      const dups = [];
      const dupMatches = xmlNFe.matchAll(/<dup>(.*?)<\/dup>/gs);
      for (const dm of dupMatches) {
        const dupXml = dm[1];
        const nDup = (dupXml.match(/<nDup>([^<]+)<\/nDup>/)||[])[1]||'';
        const dVenc = (dupXml.match(/<dVenc>([^<]+)<\/dVenc>/)||[])[1]||'';
        const vDup = parseFloat((dupXml.match(/<vDup>([^<]+)<\/vDup>/)||[])[1]||'0');
        if (dVenc && vDup>0) {
          // Converte data YYYY-MM-DD para DD/MM/YYYY
          const [y,m,d2] = dVenc.split('-');
          dups.push({nDup, venc:d2+'/'+m+'/'+y, valor:vDup});
        }
      }
      if (dups.length) dados.duplicatas = dups;
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
  const rows = await sb('GET', '/rest/v1/erp_sync?select=data,device_id&order=updated_at.desc&limit=1');
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
  // Se tem duplicatas (parcelas reais da NF), cria uma conta por parcela
  const duplicatas = dados.duplicatas || [];
  if (duplicatas.length > 0) {
    for (const dup of duplicatas) {
      const idDup = idConta + '_dup' + dup.nDup;
      if (d.contasPagar.some(cp=>cp.id===idDup)) continue;
      d.contasPagar.push({
        id: idDup,
        forn: dados.emitente || 'Fornecedor',
        val: dup.valor,
        valor: dup.valor,
        venc: dup.venc,
        vencimento: dup.venc,
        pag: 'boleto',
        pago: false,
        nf: dados.nNF || '',
        nDup: dup.nDup,
        desc: 'NF '+( dados.nNF||'')+' Parcela '+dup.nDup+' - '+(dados.emitente||'Fornecedor'),
        dt: dados.data || new Date().toLocaleDateString('pt-BR'),
        cat: 'Fornecedores',
        _sefaz: true, cnpjEmit: dados.cnpjEmit||'',
        criadoEm: new Date().toISOString()
      });
      console.log('SEFAZ CP parcela:', dados.emitente, dup.nDup, dup.valor, dup.venc);
    }
  } else {
    // Sem duplicatas: cria uma única conta com valor total
    d.contasPagar.push({
      id: idConta,
      forn: dados.emitente || 'Fornecedor',
      val: dados.valor, valor: dados.valor,
      venc: dados.vencimento, vencimento: dados.vencimento,
      pag: 'boleto', pago: false,
      nf: dados.nNF || '',
      desc: 'NF '+(dados.nNF||'')+' - '+(dados.emitente||'Fornecedor'),
      dt: dados.data || new Date().toLocaleDateString('pt-BR'),
      cat: 'Fornecedores', _sefaz: true, _estimado: true,
      cnpjEmit: dados.cnpjEmit||'',
      criadoEm: new Date().toISOString()
    });
  }

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
  if (global._pluggyImportando) { console.log('Pluggy: import ja em andamento, ignorando'); return; }
  global._pluggyImportando = true;
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
          // Baixa automática: se for pagamento de fornecedor, marca conta a pagar como paga
          if (desc.startsWith('Pagamento | ')||desc.startsWith('pagamento | ')) {
            const fornPago = desc.replace(/^[Pp]agamento \| /,'').trim().toUpperCase().slice(0,20);
            try {
              const {data:blobCP, deviceId:devCP} = await lerBlob();
              const cps = blobCP.contasPagar||[];
              let baixou=false;
              for (const cp of cps) {
                if (cp.pago) continue;
                const fornCP = (cp.forn||'').toUpperCase().slice(0,20);
                const valorMatch = Math.abs(Number(cp.val||cp.valor||0)-valor)<0.10;
                const fornMatch = fornCP.includes(fornPago.slice(0,10))||fornPago.includes(fornCP.slice(0,10));
                if (valorMatch && fornMatch) {
                  cp.pago=true; cp.dataPagamento=dia; cp._baixaPluggy=true;
                  baixou=true;
                  console.log('Baixa automática CP:', cp.forn, cp.val, dia);
                  break;
                }
              }
              if (baixou) await salvarBlob(blobCP, devCP);
            } catch(eb) { console.log('Baixa CP err:', eb.message); }
          }
          total++;
          }
          cursor = page.nextCursor||page.proximoCursor||null;
        } while (cursor);
      }
    }
    console.log('Pluggy: '+total+' transações importadas');
    // Dedup automático: remove duplicatas bot+pluggy no mesmo dia+valor
    if (total > 0) {
      try {
        const todos = await sb('GET', '/rest/v1/lancamentos?tipo=eq.custo&select=id,dia_comercial,valor,device_id&limit=5000');
        if (Array.isArray(todos)) {
          const grupos = {};
          for (const l of todos) {
            const k = l.dia_comercial+'|'+Number(l.valor||0).toFixed(2);
            if (!grupos[k]) grupos[k]=[];
            grupos[k].push(l);
          }
          let dedup=0;
          for (const itens of Object.values(grupos)) {
            if (itens.length<2) continue;
            const temBot=itens.find(i=>i.device_id==='bot_whatsapp');
            const pluggyDups=itens.filter(i=>i.device_id==='pluggy_auto');
            if (temBot && pluggyDups.length) {
              for (const d of pluggyDups) { await sb('DELETE','/rest/v1/lancamentos?id=eq.'+d.id).catch(()=>{}); dedup++; }
            }
          }
          if (dedup>0) console.log('Pluggy: '+dedup+' duplicatas removidas (bot+pluggy mesmo dia+valor)');
        }
      } catch(ed) { console.log('Dedup err:', ed.message); }
      // Sincroniza blob para o frontend ver os dados
      try {
        const todosLanc = await sb('GET', '/rest/v1/lancamentos?select=id,tipo,dia_comercial,valor,descricao,categoria,segmento,device_id&order=dia_comercial.desc&limit=10000');
        if (Array.isArray(todosLanc)) {
          const {data:blobData, deviceId:blobDev} = await lerBlob();
          // Agrupa por dia
          const porDia = {};
          for (const l of todosLanc) {
            const dia = l.dia_comercial; if (!dia) continue;
            if (!porDia[dia]) porDia[dia] = {r:[], c:[]};
            // ID único por transação (usa ID do Supabase se disponível)
            const itemId = l.id || (l.device_id+'_'+dia+'_'+l.descricao+'_'+l.valor).slice(0,60);
            const item = {
              id: itemId,
              d: l.descricao || 'Lançamento',
              v: Number(l.valor||0),
              cat: l.categoria || '🔄 Outros',
              seg: l.segmento || null,
              dt: dia,
              fonte: l.device_id,
              _deOutroDispositivo: true
            };
            if (l.tipo==='receita') porDia[dia].r.push(item);
            else porDia[dia].c.push(item);
          }
          // Merge no blob preservando outros dados
          for (const [dia, items] of Object.entries(porDia)) {
            if (!blobData[dia]) blobData[dia] = {r:[], c:[]};
            // Substitui apenas os lançamentos automáticos (pluggy/sefaz/sti3)
            // Preserva manuais do bot, substitui automáticos
          const manuaisC = blobData[dia].c.filter(x=>{
            const src = x.fonte||'';
            if (['pluggy_auto','sefaz_auto'].includes(src)) return false;
            if ((x.id||'').startsWith('pluggy_')||(x.id||'').startsWith('nf_')) return false;
            return true;
          });
          blobData[dia].c = [...manuaisC, ...items.c];
          const manuaisR = (blobData[dia].r||[]).filter(x=>(x.fonte||'')!=='sti3_auto');
          blobData[dia].r = [...manuaisR, ...items.r];
          }
          await salvarBlob(blobData, blobDev);
          console.log('Pluggy: blob sincronizado com '+Object.keys(porDia).length+' dias');
        }
      } catch(es) { console.log('Sync blob err:', es.message); }
    }
    // Atualiza blob erp_sync com totais por dia — frontend lê isso
    if (total > 0) {
      try {
        const {data: blobData, deviceId} = await lerBlob();
        const todosLanc = await sb('GET', '/rest/v1/lancamentos?tipo=eq.custo&device_id=eq.pluggy_auto&select=dia_comercial,valor,descricao,categoria&limit=2000');
        if (Array.isArray(todosLanc)) {
          const porDia = {};
          for (const l of todosLanc) {
            const dia = l.dia_comercial;
            if (!porDia[dia]) porDia[dia] = [];
            porDia[dia].push({id:'pluggy_'+dia+'_'+l.valor, d:l.descricao, v:Number(l.valor||0), cat:l.categoria, fonte:'pluggy'});
          }
          for (const [dia, itens] of Object.entries(porDia)) {
            if (!blobData[dia]) blobData[dia] = {r:[], c:[]};
            if (!blobData[dia].c) blobData[dia].c = [];
            // Remove pluggy antigos e adiciona novos
            blobData[dia].c = blobData[dia].c.filter(x=>x.fonte!=='pluggy');
            // Agrupa em um único item por dia para não inflar o blob
            const totalDia = itens.reduce((a,b)=>a+b.v, 0);
            blobData[dia].c.push({id:'pluggy_dia_'+dia.replace(/\//g,''), d:'Pluggy ('+itens.length+' transações)', v:totalDia, fonte:'pluggy'});
          }
          await salvarBlob(blobData, 'pluggy_server');
          console.log('Pluggy: blob atualizado com '+Object.keys(porDia).length+' dias');
        }
      } catch(eb) { console.log('Blob update err:', eb.message); }
    }
  } catch(e) { console.error('Pluggy err:', e.message); } finally { global._pluggyImportando = false; }
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
  if (desc.includes('pix')||desc.startsWith('deb pix')||desc.startsWith('transferencia | pix')) return '🔄 PIX Enviado';

  // Pagamentos de boleto de fornecedores (Pagamento | FORNECEDOR)
  if (desc.startsWith('pagamento |')) {
    const forn = desc.replace('pagamento | ','').toLowerCase();
    if (forn.includes('food')||forn.includes('aliment')||forn.includes('carnes')||
        forn.includes('pesc')||forn.includes('suino')||forn.includes('frango')||
        forn.includes('minerva')||forn.includes('jbs')||forn.includes('brf')||
        forn.includes('riberfoods')||forn.includes('tgad')||forn.includes('uberlandia')||
        forn.includes('supreme')||forn.includes('suprema')||forn.includes('mart minas')||
        forn.includes('cecoti')||forn.includes('distribu')||forn.includes('import')) {
      return '🥩 Matéria Prima';
    }
    if (forn.includes('embalagem')||forn.includes('embala')||forn.includes('psg indust')) return '📦 Embalagem';
    if (forn.includes('pjbank')||forn.includes('banco')||forn.includes('fintech')) return '💳 Taxas/Impostos';
    return '📄 Boleto Pago';
  }
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

  // 14h30 Brasília = 17h UTC: força sync Pluggy (Pluggy sincroniza ~14h40) e envia saldos 15min depois
  if (hUTC===17 && _ultimoSaldo!==dia) {
    _ultimoSaldo = dia;
    if (PLUGGY_CID && PLUGGY_CSEC) {
      console.log('Agendador: forcando sync Pluggy para saldos das 10h...');
      // Força sync de todos os bancos
      (async()=>{
        try {
          const {data} = await lerBlob();
          const ids = data.pluggyItemIds||[];
          for (const id of ids) {
            await (async()=>{ const k=await pluggyAuth(); return httpReq('POST','https://api.pluggy.ai/items/'+id+'/update',{},{'X-API-KEY':k,'Content-Type':'application/json'}); })().catch(()=>{});
          }
          console.log('Sync forcado para '+ids.length+' bancos. Aguardando 15min...');
          // Aguarda 15min para Pluggy processar e envia saldos
          setTimeout(()=>enviarSaldos().catch(e=>console.error('Saldos err:',e.message)), 15*60*1000);
        } catch(e) { console.error('Sync saldos err:', e.message); }
      })();
    }
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
    if (req.url && req.url.startsWith('/test-sefaz')) { const nsuP=req.url.includes('nsu=')?(req.url.split('nsu=')[1]||''):null; consultarNFsSEFAZ(nsuP||undefined).then(()=>res.end('ok')).catch(e=>res.end(e.message)); return; }
    if (req.url==='/resync-blob') {
      importarTransacoesPluggy().then(()=>{
        res.writeHead(200); res.end(JSON.stringify({ok:true,msg:'Blob atualizado com transacoes individuais'}));
      }).catch(e=>{res.writeHead(200);res.end(JSON.stringify({erro:e.message}));});
      return;
    }
    if (req.url==='/test-pluggy') { importarTransacoesPluggy().then(()=>res.end('ok')).catch(e=>res.end(e.message)); return; }
    if (req.url==='/dedup-lancamentos') {
      (async()=>{
        try {
          // Busca todos os lançamentos de custo
          const todos = await sb('GET', '/rest/v1/lancamentos?tipo=eq.custo&select=id,dia_comercial,valor,descricao,device_id&limit=5000');
          if (!Array.isArray(todos)) { res.writeHead(200); res.end(JSON.stringify({erro:'sem dados'})); return; }

          // Agrupa por chave: dia+valor (arredondado 2 decimais)
          const grupos = {};
          for (const l of todos) {
            const chave = l.dia_comercial+'|'+Number(l.valor||0).toFixed(2);
            if (!grupos[chave]) grupos[chave] = [];
            grupos[chave].push(l);
          }

          // Encontra duplicatas (mesmo dia+valor, diferentes device_ids)
          const duplicatas = [];
          for (const [chave, itens] of Object.entries(grupos)) {
            if (itens.length < 2) continue;
            const temBot = itens.find(i=>i.device_id==='bot_whatsapp');
            const temPluggy = itens.find(i=>i.device_id==='pluggy_auto');
            // Duplicata: tem bot E pluggy com mesmo dia+valor
            if (temBot && temPluggy) {
              // Mantém o do bot (mais confiável, tem descrição real)
              // Remove os do pluggy
              const paraRemover = itens.filter(i=>i.device_id==='pluggy_auto');
              duplicatas.push({chave, bot:temBot.id, pluggy:paraRemover.map(i=>i.id)});
            }
          }

          // Remove as duplicatas do Pluggy
          let removidos = 0;
          for (const dup of duplicatas) {
            for (const id of dup.pluggy) {
              await sb('DELETE', '/rest/v1/lancamentos?id=eq.'+id).catch(()=>{});
              removidos++;
            }
          }

          console.log('Dedup: '+duplicatas.length+' duplicatas encontradas, '+removidos+' removidos');
          res.writeHead(200); res.end(JSON.stringify({ok:true, duplicatas:duplicatas.length, removidos, detalhes:duplicatas.slice(0,10)}));
        } catch(e) { res.writeHead(200); res.end(JSON.stringify({erro:e.message})); }
      })();
      return;
    }
    if (req.url && req.url.startsWith('/sefaz-capturar')) {
      // Uma unica consulta SEFAZ - salva XML bruto e processa tudo
      (async()=>{
        try {
          const params = new URL('http://x'+req.url).searchParams;
          const nsuParam = params.get('nsu') || null;
          const {data:d, deviceId} = await lerBlob();
          const cert = d.dadosFiscais && d.dadosFiscais.certificado;
          if (!cert||!cert.pfxBase64) { res.writeHead(200); res.end(JSON.stringify({ok:false,erro:'Sem certificado'})); return; }
          const nsuUsar = nsuParam || d.dadosFiscais.ultimoNSU || '000000000004394';
          console.log('SEFAZ captura unica NSU:', nsuUsar);
          // UMA UNICA consulta
          const resp = await sefazDistribuicaoDFe(cert.pfxBase64, cert.senha, CNPJ_EMP, nsuUsar, 'prod');
          const cStat = extrairTagXML(resp.xml, 'cStat');
          const ultNSU = extrairTagXML(resp.xml, 'ultNSU');
          const maxNSU = extrairTagXML(resp.xml, 'maxNSU');
          console.log('SEFAZ captura: cStat='+cStat+' ultNSU='+ultNSU+' maxNSU='+maxNSU+' xmlLen='+resp.xml.length);
          // Salva XML bruto no blob para processamento
          if (!d.sefazXMLBruto) d.sefazXMLBruto = [];
          d.sefazXMLBruto.push({ nsu: nsuUsar, ultNSU, cStat, xml: resp.xml, ts: new Date().toISOString() });
          if (d.dadosFiscais) d.dadosFiscais.ultimoNSU = ultNSU;
          // Processa NFs do XML capturado
          const completos = parsearDocZips(resp.xml);
          console.log('SEFAZ captura: '+completos.length+' NFs encontradas');
          await salvarBlob(d, deviceId);
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({
            ok: true, cStat, nsuUsado: nsuUsar, ultNSU, maxNSU,
            xmlLen: resp.xml.length,
            nfsEncontradas: completos.length,
            nfs: completos.map(n=>({emitente:n.emitente,valor:n.valor,data:n.data,chNFe:(n.chNFe||'').slice(0,10)+'...'})),
            xmlInicio: resp.xml.slice(0,500)
          }, null, 2));
        } catch(e) { res.writeHead(200); res.end(JSON.stringify({erro:e.message})); }
      })();
      return;
    }
    if (req.url && req.url.startsWith('/sefaz-capturar-tudo')) {
      (async()=>{
        try {
          const params = new URL('http://x'+req.url).searchParams;
          const nsuInicio = params.get('nsu') || '000000000004394';
          const {data:d, deviceId} = await lerBlob();
          const cert = d.dadosFiscais && d.dadosFiscais.certificado;
          if (!cert||!cert.pfxBase64) { res.writeHead(200); res.end(JSON.stringify({ok:false,erro:'Sem certificado'})); return; }
          if (!d.sefazXMLBruto) d.sefazXMLBruto = [];
          // Processa sincronamente - mantém conexão aberta até terminar
          try {
            let nsuAtual = nsuInicio;
            let lote = 0; let totalSalvos = 0;
            while (lote < 15) {
              lote++;
              try {
                // Delay de 8 segundos entre lotes para evitar bloqueio
                if (lote > 1) { console.log('SEFAZ: aguardando 35s antes do proximo lote...'); await new Promise(r=>setTimeout(r,35000)); }
                console.log('SEFAZ captura lote '+lote+' NSU='+nsuAtual);
                const resp = await sefazDistribuicaoDFe(cert.pfxBase64,cert.senha,CNPJ_EMP,nsuAtual,'prod');
                const cStat = extrairTagXML(resp.xml,'cStat');
                const ultNSU = extrairTagXML(resp.xml,'ultNSU');
                const maxNSU = extrairTagXML(resp.xml,'maxNSU');
                console.log('SEFAZ lote '+lote+': cStat='+cStat+' ultNSU='+ultNSU+' maxNSU='+maxNSU+' len='+resp.xml.length);
                if (cStat==='656') { console.log('SEFAZ: bloqueado, parando'); break; }
                if (cStat!=='138'&&cStat!=='137') { console.log('SEFAZ: cStat inesperado '+cStat+', parando'); break; }
                // Salva XML
                d.sefazXMLBruto.push({nsu:nsuAtual,ultNSU,cStat,xml:resp.xml,ts:new Date().toISOString()});
                totalSalvos++;
                nsuAtual = ultNSU;
                if (ultNSU >= maxNSU || cStat==='137') break;
              } catch(el) { console.log('SEFAZ lote '+lote+' err:',el.message); break; }
            }
            // Salva todos os XMLs no blob
            d.dadosFiscais.ultimoNSU = nsuAtual;
            await salvarBlob(d, deviceId);
            console.log('SEFAZ: '+totalSalvos+' lotes salvos. Processando NFs...');
            // Processa todas as NFs salvas
            const todasNFs = [];
            for (const item of d.sefazXMLBruto) {
              if (!item.xml) continue;
              const nfs = parsearDocZips(item.xml);
              todasNFs.push(...nfs);
            }
            const vistas = new Set();
            const nfesUnicas = todasNFs.filter(nfe=>{
              if(!nfe.chNFe)return false;
              if(vistas.has(nfe.chNFe))return false;
              vistas.add(nfe.chNFe);return true;
            });
            const ex = await sb('GET','/rest/v1/lancamentos?device_id=eq.sefaz_auto&select=id&limit=500');
            const idsExist = new Set(Array.isArray(ex)?ex.map(l=>l.id):[]);
            const nfesNovas = nfesUnicas.filter(nfe=>!idsExist.has('nf_'+nfe.chNFe));
            console.log('SEFAZ total: '+nfesUnicas.length+' unicas, '+nfesNovas.length+' novas para lançar');
            if (!d.contasPagar) d.contasPagar=[];
            for (const nfe of nfesNovas) {
              const dia = nfe.data || new Date().toLocaleDateString('pt-BR');
              const idLanc = 'nf_'+(nfe.chNFe||Date.now());
              const isBonif = Number(nfe.valor||0)<0.01;
              console.log('Lancando:',(isBonif?'[BONIF]':''),nfe.emitente,nfe.valor,dia);
              if (!isBonif) {
                await gravarLancamento(idLanc,'custo',dia,'NF - '+(nfe.emitente||'?'),
                  detectarGrupoServidor(nfe.emitente||'').catDRE||'🥩 Matéria Prima',nfe.valor,'sefaz_auto');
                const idCP='sefaz_cp_'+nfe.chNFe;
                if (!d.contasPagar.find(cp=>cp.id===idCP)) {
                  const venc=nfe.vencimento||(()=>{const p=(dia||'').split('/');if(p.length===3){const b=new Date(Number(p[2]),Number(p[1])-1,parseInt(p[0])+30);return b.toLocaleDateString('pt-BR');}return '';})();
                  d.contasPagar.push({id:idCP,forn:nfe.emitente||'?',val:Number(nfe.valor||0),venc,pago:false,_sefaz:true,cnpjEmit:nfe.cnpjEmit,chNFe:nfe.chNFe});
                }
              }
            }
            await salvarBlob(d,deviceId);
            if (nfesNovas.length) {
              const resumo=nfesNovas.filter(n=>Number(n.valor||0)>0).slice(0,10).map(n=>'• '+(n.emitente||'?').slice(0,25)+' R$'+Number(n.valor||0).toFixed(2)).join('\n');
              await wppParaTodos('📄 SEFAZ concluído!\n'+nfesNovas.length+' NF(s) lançadas:\n'+resumo);
            } else {
              await wppParaTodos('📄 SEFAZ: nenhuma NF nova encontrada nos '+totalSalvos+' lotes capturados.');
            }
            res.writeHead(200); res.end(JSON.stringify({ok:true,lotesCapturados:totalSalvos,nfsLancadas:nfesNovas.length,msg:'Concluido!'}));
          } catch(eb) { if(!res.headersSent){res.writeHead(200);res.end(JSON.stringify({erro:eb.message}));} }
        } catch(e) { res.writeHead(200); res.end(JSON.stringify({erro:e.message})); }
      })();
      return;
    }
    if (req.url==='/sefaz-processar-xml-salvo') {
      (async()=>{
        try {
          const {data:d, deviceId} = await lerBlob();
          const xmlBrutos = d.sefazXMLBruto || [];
          if (!xmlBrutos.length) { res.writeHead(200); res.end(JSON.stringify({erro:'Sem XML salvo'})); return; }
          // Processa TODOS os XMLs salvos
          const todasNFs = [];
          for (const item of xmlBrutos) {
            if (!item.xml) continue;
            const nfs = parsearDocZips(item.xml);
            console.log('XML salvo NSU='+item.nsu+': '+nfs.length+' NFs');
            todasNFs.push(...nfs);
          }
          // Deduplica por chNFe
          const vistas = new Set();
          const nfesUnicas = todasNFs.filter(nfe => {
            if (!nfe.chNFe) return false;
            if (vistas.has(nfe.chNFe)) return false;
            vistas.add(nfe.chNFe); return true;
          });
          // Verifica quais já existem na tabela
          const idsExistentes = new Set();
          const ex = await sb('GET', '/rest/v1/lancamentos?device_id=eq.sefaz_auto&select=id&limit=500');
          if (Array.isArray(ex)) ex.forEach(l => idsExistentes.add(l.id));
          const nfesNovas = nfesUnicas.filter(nfe => !idsExistentes.has('nf_'+nfe.chNFe));
          if (!d.contasPagar) d.contasPagar = [];
          console.log('SEFAZ XML salvo: '+nfesUnicas.length+' unicas, '+nfesNovas.length+' novas');
          const resultados = [];
          for (const nfe of nfesNovas) {
            const dia = nfe.data || new Date().toLocaleDateString('pt-BR');
            const idLanc = 'nf_'+(nfe.chNFe||Date.now());
            console.log('Lancando NF:', nfe.emitente, nfe.valor, dia);
            const isBonif = Number(nfe.valor||0) < 0.01;
            if (!isBonif) {
              await gravarLancamento(idLanc,'custo',dia,'NF - '+(nfe.emitente||'Fornecedor'),
                detectarGrupoServidor(nfe.emitente||'').catDRE||'🥩 Matéria Prima',nfe.valor,'sefaz_auto');
              // Conta a pagar
              // Cria CP para cada parcela real
              parcelas.forEach((parc,pi)=>{
                const idCP = 'sefaz_cp_'+nfe.chNFe+(parcelas.length>1?'_p'+(pi+1):'');
                if (!d.contasPagar.find(cp=>cp.id===idCP)) {
                  d.contasPagar.push({
                    id:idCP, forn:nfe.emitente||'Fornecedor',
                    val:parc.val||Number(nfe.valor||0),
                    venc:parc.venc||'', pago:false,
                    _sefaz:true, _estimado:!parc.venc,
                    nDup:parc.nDup, cnpjEmit:nfe.cnpjEmit, chNFe:nfe.chNFe,
                    parcela: parcelas.length>1?`${pi+1}/${parcelas.length}`:undefined
                  });
                }
              });
            }
            resultados.push({emitente:nfe.emitente,valor:nfe.valor,dia,bonif:isBonif});
          }
          await salvarBlob(d, deviceId);
          if (nfesNovas.length) {
            const resumo = nfesNovas.filter(n=>Number(n.valor||0)>0).map(n=>'• '+(n.emitente||'?').slice(0,30)+' — R$'+Number(n.valor||0).toFixed(2)).join('\n');
            if (resumo) await wppParaTodos('📄 SEFAZ (XML salvo): '+nfesNovas.length+' NF(s):\n'+resumo);
          }
          res.writeHead(200); res.end(JSON.stringify({ok:true,total:nfesUnicas.length,novas:nfesNovas.length,resultados},null,2));
        } catch(e) { res.writeHead(200); res.end(JSON.stringify({erro:e.message,stack:e.stack?.slice(0,300)})); }
      })();
      return;
    }
    if (req.url==='/sefaz-analisar-xml') {
      (async()=>{
        try {
          const {data:d} = await lerBlob();
          const xmlBrutos = d.sefazXMLBruto || [];
          if (!xmlBrutos.length) { res.writeHead(200); res.end(JSON.stringify({erro:'Sem XML salvo. Rode /sefaz-capturar primeiro.'})); return; }
          const ultimo = xmlBrutos[xmlBrutos.length-1];
          const xml = ultimo.xml || '';
          const xmlNorm = xml.replace(/\r?\n/g," ");
          // Testa regex exato do parsearDocZips
          const matchesFull = [...xmlNorm.matchAll(/<docZip[^>]*schema="([^"]*)"[^>]*>([A-Za-z0-9+\/=\s]+)<\/docZip>/g)];
          // Descomprime o primeiro resNFe para ver o XML interno
          const primeiroNFe = matchesFull.find(m=>m[1].includes('resNFe'));
          let xmlDescomp = '', erroDecomp = '';
          if (primeiroNFe) {
            try { xmlDescomp = descompactarDocZip(primeiroNFe[2].trim()).slice(0,600); }
            catch(ed) { erroDecomp = ed.message; }
          }
          // Testa regex mais permissivo (sem validar conteudo)
          const matchesSimples = [...xmlNorm.matchAll(/<docZip[^>]*>/g)];
          // Testa regex com conteudo diferente
          const matchesPermissivo = [...xmlNorm.matchAll(/<docZip[^>]*>([\s\S]*?)<\/docZip>/g)];
          // Pega amostra do primeiro docZip para ver conteudo real
          const primeiroMatch = matchesPermissivo[0];
          const conteudoPrimeiro = primeiroMatch ? primeiroMatch[1].slice(0,200) : 'nada';
          // Verifica se tem chars especiais
          const charEspecial = primeiroMatch ? [...primeiroMatch[1].slice(0,100)].map(c=>c.charCodeAt(0)).filter(c=>c<32||c>126) : [];
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({
            xmlLen: xml.length, xmlNormLen: xmlNorm.length,
            matchesFullRegex: matchesFull.length,
            matchesTagSimples: matchesSimples.length,
            matchesPermissivo: matchesPermissivo.length,
            schemasEncontrados: matchesPermissivo.slice(0,5).map(m=>({schema:m[0].match(/schema="([^"]*)"/)?.[1]||'?', conteudoLen:m[1].length, conteudoInicio:m[1].slice(0,50)})),
            conteudoPrimeiro,
            charEspecialNoPrimeiro: charEspecial.slice(0,10),
            xmlDescomprimido: xmlDescomp,
            erroDescompressao: erroDecomp
          }, null, 2));
        } catch(e) { res.writeHead(200); res.end(JSON.stringify({erro:e.message})); }
      })();
      return;
    }
    if (req.url==='/delete-sefaz-e-reprocessar') {
      (async()=>{
        try {
          // Deleta lancamentos SEFAZ da tabela
          const del1 = await sb('DELETE','/rest/v1/lancamentos?device_id=eq.sefaz_auto',null,{'Prefer':'return=minimal'});
          console.log('DELETE sefaz_auto:', JSON.stringify(del1).slice(0,100));
          // Reseta NSU no blob
          const {data:d3,deviceId:dev3}=await lerBlob();
          if(d3.dadosFiscais) d3.dadosFiscais.ultimoNSU='000000000000000';
          d3.contasPagar=(d3.contasPagar||[]).filter(cp=>!cp._sefaz);
          await salvarBlob(d3,dev3);
          console.log('NSU resetado. Iniciando SEFAZ com NSU forcado=000000000000000');
          res.writeHead(200);res.end(JSON.stringify({ok:true,msg:'Deletado! SEFAZ rodando com NSU zerado...'}));
          // Chama com NSU zerado, ignorando o blob
          consultarNFsSEFAZ('000000000000000').catch(e=>console.error('SEFAZ err:',e.message));
        }catch(e){res.writeHead(200);res.end(JSON.stringify({erro:e.message}));}
      })();
      return;
    }
    if (req.url==='/limpar-v8') {
      (async()=>{
        try {
          const todos = await sb('GET','/rest/v1/lancamentos?select=device_id&limit=5000');
          const v8ids = new Set();
          if(Array.isArray(todos)) todos.forEach(l=>{
            const d=l.device_id||'';
            if(d.startsWith('device_')) v8ids.add(d);
          });
          console.log('Limpar v8:', [...v8ids]);
          for(const did of v8ids){
            await sb('DELETE','/rest/v1/lancamentos?device_id=eq.'+encodeURIComponent(did),null,{'Prefer':'return=minimal'});
          }
          res.writeHead(200);
          res.end(JSON.stringify({ok:true,removidos:[...v8ids],msg:'Dados v8 removidos. Sincronize o sistema.'}));
        }catch(e){res.writeHead(200);res.end(JSON.stringify({erro:e.message}));}
      })();
      return;
    }
    if (req.url==='/deletar-bonificacoes') {
      (async()=>{
        try {
          // Deleta as NFs de bonificação da Uberlândia (R$2,29 e R$42,61)
          const r1 = await sb('DELETE','/rest/v1/lancamentos?device_id=eq.sefaz_auto&valor=eq.2.29',null,{'Prefer':'return=minimal'});
          const r2 = await sb('DELETE','/rest/v1/lancamentos?device_id=eq.sefaz_auto&valor=eq.42.61',null,{'Prefer':'return=minimal'});
          // Remove também das contas a pagar no blob
          const {data:d,deviceId} = await lerBlob();
          const cpAntes = (d.contasPagar||[]).length;
          d.contasPagar = (d.contasPagar||[]).filter(cp=>{
            const v = Number(cp.val||cp.valor||0);
            const forn = (cp.forn||'').toUpperCase();
            if(forn.includes('UBERLANDIA')&&(Math.abs(v-2.29)<0.01||Math.abs(v-42.61)<0.01)) return false;
            return true;
          });
          await salvarBlob(d,deviceId);
          res.writeHead(200);res.end(JSON.stringify({ok:true,cpRemovidas:cpAntes-(d.contasPagar||[]).length,msg:'Bonificacoes removidas'}));
        }catch(e){res.writeHead(200);res.end(JSON.stringify({erro:e.message}));}
      })();
      return;
    }
    if (req.url==='/limpar-reprocessar-sefaz') {
      (async()=>{
        try {
          const {data:d2,deviceId:dev2}=await lerBlob();
          if(!d2.dadosFiscais||!d2.dadosFiscais.certificado){res.writeHead(200);res.end(JSON.stringify({ok:false,erro:'Sem certificado'}));return;}
          // Remove CP SEFAZ
          const cpAntes=(d2.contasPagar||[]).length;
          d2.contasPagar=(d2.contasPagar||[]).filter(cp=>!cp._sefaz);
          // Remove lotes SEFAZ do estoque
          if(d2.est) d2.est.forEach(p=>{
            if(p.lotes){var antes=p.lotes.length;p.lotes=p.lotes.filter(l=>!l._sefaz);var rem=antes-p.lotes.length;if(rem>0){p.q=Math.max(0,(p.q||0)-rem);p.qi=Math.max(0,(p.qi||0)-rem);}}
          });
          // Remove lancamentos SEFAZ da tabela
          await sb('DELETE','/rest/v1/lancamentos?device_id=eq.sefaz_auto',null,{'Prefer':'return=minimal'}).catch(()=>{});
          // Reseta NSU para reprocessar tudo
          d2.dadosFiscais.ultimoNSU='000000000000000';
          await salvarBlob(d2,dev2);
          res.writeHead(200);res.end(JSON.stringify({ok:true,cpRemovidas:cpAntes-(d2.contasPagar||[]).length,msg:'Limpo! Rode /test-sefaz agora.'}));
        }catch(e){res.writeHead(200);res.end(JSON.stringify({erro:e.message}));}
      })();
      return;
    }
    if (req.url && req.url.startsWith('/debug-dia/')) {
      const diaParam = req.url.split('/debug-dia/')[1]; // formato DD-MM-YYYY
      const [dd,mm,yy] = diaParam.split('-');
      const diaFmt = dd+'/'+mm+'/'+yy;
      (async()=>{
        try {
          const rows = await sb('GET', '/rest/v1/lancamentos?dia_comercial=eq.'+encodeURIComponent(diaFmt)+'&select=tipo,valor,descricao,categoria,device_id&limit=200');
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({
            dia: diaFmt,
            total: Array.isArray(rows)?rows.length:0,
            lancamentos: rows
          },null,2));
        } catch(e) { res.writeHead(200); res.end(JSON.stringify({erro:e.message})); }
      })();
      return;
    }
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
          _saldoDebounce = setTimeout(()=>{
            const diaHoje = new Date().toISOString().slice(0,10);
            if (_ultimoSaldo === diaHoje) { console.log('Saldos: ja enviado hoje'); return; }
            _ultimoSaldo = diaHoje;
            enviarSaldos().catch(()=>{});
          }, 15*60*1000); // 15min para Pluggy atualizar + só 1x por dia
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

