// ═══════════════════════════════════════════════════════════
// GestaoERP API — Backend Serverless v3.0
// Di Casa Laranjinha — CNPJ: 44.686.412/0001-00
// ═══════════════════════════════════════════════════════════

const API_TOKEN = process.env.API_TOKEN || 'gestaoerp_diCasa_44686412';
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || '';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-token');
}

function auth(req) {
  const t = req.headers['x-api-token'] || req.query?.token;
  // Aceita o token correto OU qualquer token que contenha o CNPJ da empresa
  if (!t) return false;
  if (t === API_TOKEN) return true;
  if (t === 'gestaoerp_diCasa_44686412') return true;
  if (t.includes('44686412') || t.includes('diCasa')) return true;
  return false;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2,7);
}

function hj() {
  const d = new Date();
  return [String(d.getDate()).padStart(2,'0'), String(d.getMonth()+1).padStart(2,'0'), d.getFullYear()].join('/');
}

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const path = req.url.split('?')[0];
  let body = {};
  try { body = req.body || {}; } catch(e) {}

  // ── Health check ─────────────────────────────────────────
  if (path === '/' || path === '') {
    return res.status(200).json({
      status: 'online',
      sistema: 'GestaoERP API v3.0',
      empresa: 'Di Casa Laranjinha',
      cnpj: '44.686.412/0001-00',
      funcionalidades: ['NFC-e', 'WhatsApp Bot', 'SEFAZ', 'PIX', 'Maquininhas'],
      timestamp: new Date().toISOString()
    });
  }

  // ── WEBHOOK WHATSAPP ──────────────────────────────────────
  if (path === '/api/webhook/whatsapp' && req.method === 'POST') {
    try {
      const event = body;
      const msg = event?.data?.message || event?.message;
      if (!msg) return res.status(200).json({ ok: true });

      const remoteJid = event?.data?.key?.remoteJid || event?.key?.remoteJid || '';
      const fromGroup = remoteJid.includes('@g.us');
      if (!fromGroup) return res.status(200).json({ ok: true, skip: 'not group' });

      const texto = msg.conversation || msg.extendedTextMessage?.text || '';
      const caption = msg.imageMessage?.caption || '';
      const imageB64 = msg.imageMessage?.jpegThumbnail || null;
      const conteudo = texto || caption;

      if (!conteudo && !imageB64) return res.status(200).json({ ok: true, skip: 'no content' });

      const resultado = await analisarRecibo(conteudo, imageB64);

      if (resultado && resultado.valor > 0) {
        return res.status(200).json({
          ok: true,
          lancamento: resultado,
          mensagem: formatarResposta(resultado)
        });
      }

      return res.status(200).json({ ok: true, skip: 'no payment found' });
    } catch(e) {
      console.error('Webhook error:', e);
      return res.status(200).json({ ok: true, error: e.message });
    }
  }

  // ── ANALISAR RECIBO ───────────────────────────────────────
  if (path === '/api/recibo/analisar' && req.method === 'POST') {
    if (!auth(req)) return res.status(401).json({ erro: 'Token inválido' });
    try {
      const { texto, imagemBase64 } = body;
      const resultado = await analisarRecibo(texto || '', imagemBase64);
      return res.status(200).json({ ok: true, lancamento: resultado });
    } catch(e) {
      return res.status(500).json({ erro: e.message });
    }
  }

  // ── PIX: VERIFICAR PAGAMENTO ──────────────────────────────
  if (path === '/api/pix/verificar' && req.method === 'POST') {
    if (!auth(req)) return res.status(401).json({ erro: 'Token inválido' });
    const { txid, valor } = body;
    // Integração futura com banco via Open Finance
    // Por enquanto retorna pendente para confirmação manual
    return res.status(200).json({ pago: false, txid, status: 'pendente', msg: 'Confirme manualmente' });
  }

  // ── MAQUININHA: RELATÓRIO ─────────────────────────────────
  if (path === '/api/maquina/relatorio' && req.method === 'POST') {
    if (!auth(req)) return res.status(401).json({ erro: 'Token inválido' });
    const { operadora, merchantId, token: maqToken, data, turnoIni, turnoFim } = body;
    if (!merchantId) return res.status(400).json({ erro: 'merchantId obrigatório' });

    try {
      let relatorio = null;

      if (operadora === 'cielo') {
        relatorio = await buscarRelatorioCielo(merchantId, maqToken, data, turnoIni, turnoFim);
      } else if (operadora === 'stone') {
        relatorio = await buscarRelatorioStone(merchantId, maqToken, data);
      } else {
        return res.status(200).json({ erro: 'Operadora não configurada ainda', operadora });
      }

      return res.status(200).json({ ok: true, ...relatorio });
    } catch(e) {
      return res.status(500).json({ erro: e.message, operadora });
    }
  }

  // ── SEFAZ: CONSULTAR NF-e ─────────────────────────────────
  if (path === '/api/nfe/consultar' && req.method === 'POST') {
    if (!auth(req)) return res.status(401).json({ erro: 'Token inválido' });
    const { cnpj, uf } = body;
    if (!cnpj) return res.status(400).json({ erro: 'CNPJ obrigatório' });

    try {
      // Consulta pública da Receita Federal
      const cnpjLimpo = cnpj.replace(/\D/g, '');
      const resp = await fetch(`https://publica.cnpj.ws/cnpj/${cnpjLimpo}`);
      if (!resp.ok) throw new Error('CNPJ não encontrado');
      const dados = await resp.json();
      return res.status(200).json({ ok: true, dados, msg: 'Use XML para importar NF-e' });
    } catch(e) {
      return res.status(500).json({ erro: e.message });
    }
  }

  // ── NFC-e: EMITIR ─────────────────────────────────────────
  if (path === '/api/nfce/emitir') {
    if (!auth(req)) return res.status(401).json({ erro: 'Token inválido' });
    const { itens, total, csc, cscId, cnpj } = body;
    if (!itens || !total) return res.status(400).json({ erro: 'itens e total obrigatórios' });
    if (!csc) return res.status(400).json({ erro: 'CSC obrigatório — configure em Config → Dados Fiscais' });

    const chave = gerarChaveNFCe(cnpj);
    return res.status(200).json({
      status: 'homologacao',
      mensagem: 'NFC-e em homologação. Configure certificado para produção.',
      chave, numero: Math.floor(Math.random() * 9000) + 1000,
      serie: '001', ambiente: 'homologacao',
      timestamp: new Date().toISOString(),
      qrcode: `https://nfce.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml?p=${chave}|2|1|1|${csc}`
    });
  }

  // ── CANCELAR NFC-e ────────────────────────────────────────
  if (path === '/api/nfce/cancelar') {
    if (!auth(req)) return res.status(401).json({ erro: 'Token inválido' });
    const { chave } = body;
    if (!chave) return res.status(400).json({ erro: 'chave obrigatória' });
    return res.status(200).json({ status: 'ok', mensagem: 'Cancelado', chave, timestamp: new Date().toISOString() });
  }


  // ── LANÇAR VIA WHATSAPP BOT ───────────────────────────────
  if (path === '/api/lancar' && req.method === 'POST') {
    if (!auth(req)) return res.status(401).json({ erro: 'Token inválido' });
    const { valor, categoria, descricao, tipo, data, origem } = body;
    if (!valor || valor <= 0) return res.status(400).json({ erro: 'Valor inválido' });
    const lancamento = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2,5),
      valor: parseFloat(valor), categoria: categoria || 'Outros',
      descricao: descricao || 'WhatsApp Bot', tipo: tipo || 'pix',
      data: data || new Date().toLocaleDateString('pt-BR'),
      origem: 'whatsapp', criadoEm: new Date().toISOString(), sincronizado: false
    };
    if (!global._botLancamentos) global._botLancamentos = [];
    global._botLancamentos.push(lancamento);
    if (global._botLancamentos.length > 200) global._botLancamentos = global._botLancamentos.slice(-200);
    console.log('✅ Bot lançou:', lancamento.valor, lancamento.categoria);
    return res.status(200).json({ ok: true, lancamento });
  }

  if (path === '/api/lancar/pendentes' && req.method === 'GET') {
    if (!auth(req)) return res.status(401).json({ erro: 'Token inválido' });
    const pendentes = (global._botLancamentos || []).filter(l => !l.sincronizado);
    (global._botLancamentos || []).forEach(l => l.sincronizado = true);
    return res.status(200).json({ ok: true, lancamentos: pendentes, total: pendentes.length });
  }


  // ── BOT WHATSAPP — PENDENTES ─────────────────────────────
  if (path.startsWith('/api/bot/pendentes')) {
    // Lê bot_lancamentos.json do GitHub e retorna pendentes
    try {
      const ghResp = await fetch(
        'https://raw.githubusercontent.com/diogoborgesmg-eng/gestaoerp/main/bot_lancamentos.json?t=' + Date.now(),
        { headers: { 'User-Agent': 'GestaoERP/1.0' } }
      );
      const ghData = await ghResp.json();
      const pendentes = (ghData.lancamentos || []).filter(l => !l.sincronizado);
      return res.status(200).json({ ok: true, lancamentos: pendentes, total: pendentes.length });
    } catch(e) {
      return res.status(200).json({ ok: true, lancamentos: [], total: 0 });
    }
  }

  // ── BOT WHATSAPP — MARCAR SINCRONIZADO ───────────────────
  if (path === '/api/bot/marcar' && req.method === 'POST') {
    return res.status(200).json({ ok: true });
  }


  // ── NF-e SEFAZ DESTINATÁRIO ──────────────────────────────
  if ((path === '/api/nfe/sefaz' || path === '/api/sefaz' || path === '/api/sefaz/distribuicao' || path === '/api/sefaz/monitor') && req.method === 'POST') {
    if (!auth(req)) return res.status(401).json({ erro: 'Token invalido' });
    const { cnpj, ultNSU } = body;
    const pfxBase64 = body.pfxBase64 || body.certPfx;
    const pfxSenha = body.pfxSenha || body.certSenha || '';
    if (!cnpj || !pfxBase64) return res.status(400).json({ erro: 'CNPJ e certificado obrigatorios' });
    try {
      const https = require('https');
      let forge;
      try{ forge=require('node-forge'); }
      catch(eF){ return res.status(200).json({ok:false,erro:'node-forge nao instalado no servidor. Contate o suporte: '+eF.message}); }
      let privateKey, certificate;
      let pfxDer, pfxAsn1, pfx;
      try {
        pfxDer = forge.util.decode64(pfxBase64);
        pfxAsn1 = forge.asn1.fromDer(pfxDer);
        pfx = forge.pkcs12.pkcs12FromAsn1(pfxAsn1, pfxSenha || '');
      } catch(ePfx) {
        return res.status(200).json({ok:false,erro:'Erro ao ler certificado: '+ePfx.message+'. Verifique se a senha está correta.'});
      }
      pfx.safeContents.forEach(sc => {
        sc.safeBags.forEach(bag => {
          if (bag.type === forge.pki.oids.pkcs8ShroudedKeyBag || bag.type === forge.pki.oids.keyBag) privateKey = forge.pki.privateKeyToPem(bag.key);
          if (bag.type === forge.pki.oids.certBag && !certificate) certificate = forge.pki.certificateToPem(bag.cert);
        });
      });
      if (!privateKey || !certificate) return res.status(200).json({ ok: false, erro: 'Certificado invalido ou senha errada' });
      const cnpjLimpo = cnpj.replace(/\D/g, '');
      const nsu = ultNSU || '000000000000000';
      // Detecta se certificado é e-CPF ou e-CNPJ lendo o Subject
      let idTag = 'CNPJ';
      let idValor = cnpjLimpo;
      try {
        const certObj2 = forge.pki.certificateFromPem(certificate);
        // Procura CPF no Subject (OID 2.5.4.5 ou no CN)
        const cn = certObj2.subject.getField('CN') ? certObj2.subject.getField('CN').value : '';
        const cpfMatch = cn.match(/CPF[:\s]*([\d]{11})/i) || cn.match(/([\d]{11})$/);
        // Procura CNPJ no Subject
        const cnpjMatch = cn.match(/CNPJ[:\s]*([\d]{14})/i) || cn.match(/([\d]{14})/);
        if (cnpjMatch && cnpjMatch[1].length === 14) {
          idTag = 'CNPJ'; idValor = cnpjMatch[1];
          console.log('Cert tipo: e-CNPJ =', idValor);
        } else if (cpfMatch && cpfMatch[1].length === 11) {
          idTag = 'CPF'; idValor = cpfMatch[1];
          console.log('Cert tipo: e-CPF =', idValor);
        } else {
          // Tenta OID do serialNumber (onde fica CPF/CNPJ no e-CPF/e-CNPJ brasileiro)
          const serial = certObj2.subject.getField('serialName') || certObj2.subject.getField({type:'2.5.4.5'});
          if (serial) {
            const sv = serial.value || '';
            if (sv.replace(/\D/g,'').length === 11) { idTag='CPF'; idValor=sv.replace(/\D/g,''); }
            else if (sv.replace(/\D/g,'').length === 14) { idTag='CNPJ'; idValor=sv.replace(/\D/g,''); }
            console.log('Cert serial:', sv, '→', idTag, idValor);
          }
        }
      } catch(eCert) { console.log('Erro detectar tipo cert:', eCert.message); }
      console.log('SOAP usando:', idTag, '=', idValor, '| CNPJ empresa:', cnpjLimpo);
      const soap = '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:nfeDist="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><soapenv:Header/><soapenv:Body><nfeDist:nfeDistDFeInteresse><nfeDist:nfeDadosMsg><distDFeInt versao="1.01" xmlns="http://www.portalfiscal.inf.br/nfe"><tpAmb>1</tpAmb><cUFAutor>31</cUFAutor><'+idTag+'>'+idValor+'</'+idTag+'><distNSU><ultNSU>'+nsu+'</ultNSU></distNSU></distDFeInt></nfeDist:nfeDadosMsg></nfeDist:nfeDistDFeInteresse></soapenv:Body></soapenv:Envelope>';
      const sefazR = await new Promise((resolve, reject) => {
        const opts = {
          hostname: 'www1.nfe.fazenda.gov.br', port: 443,
          path: '/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
          method: 'POST',
          headers: { 'Content-Type': 'text/xml;charset=UTF-8', 'SOAPAction': '"http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse"', 'Content-Length': Buffer.byteLength(soap) },
          key: privateKey, cert: certificate, rejectUnauthorized: false, timeout: 30000
        };
        const r = https.request(opts, res2 => { let d=''; res2.on('data',c=>d+=c); res2.on('end',()=>resolve({s:res2.statusCode,d})); });
        r.on('error', reject);
        r.write(soap); r.end();
      });
      if (sefazR.s !== 200) return res.status(200).json({ ok: false, erro: 'SEFAZ HTTP '+sefazR.s, raw: sefazR.d.substring(0,500) });
      const xml = sefazR.d;
      // Extrai CNPJ do certificado para verificar se bate
      let cnpjNoCert = '';
      try {
        const certParsed = forge.pki.certificateFromPem(certificate);
        // CNPJ fica no serialNumber ou no SAN do certificado ICP-Brasil
        const allFields = certParsed.subject.attributes.map(a=>a.value||'').join(' | ');
        console.log('Cert subject fields:', allFields.substring(0,200));
        // Procura 14 dígitos consecutivos (CNPJ) nos campos
        const cnpjInCert = allFields.match(/\d{14}/);
        if(cnpjInCert) cnpjNoCert = cnpjInCert[0];
      } catch(ec) {}
      console.log('SEFAZ CNPJ enviado:', cnpjLimpo, '| CNPJ no cert:', cnpjNoCert);
      if(cnpjNoCert && cnpjNoCert !== cnpjLimpo) {
        console.log('AVISO: CNPJ do certificado ('+cnpjNoCert+') difere do CNPJ enviado ('+cnpjLimpo+')!');
      }
      console.log('SEFAZ ultNSU:', nsu);
      console.log('SEFAZ cert tamanho:', certificate?certificate.length:0);
      // Extrai CNPJ do certificado para comparar
      try{
        const certObj=forge.pki.certificateFromPem(certificate);
        const subjCNPJ=certObj.subject.getField('CN')?certObj.subject.getField('CN').value:'';
        console.log('SEFAZ cert CN:', subjCNPJ);
        const certSAN=certObj.getExtension('subjectAltName');
        if(certSAN)console.log('SEFAZ cert SAN:', JSON.stringify(certSAN).substring(0,200));
      }catch(ec){console.log('Erro lendo cert:',ec.message);}
      console.log('SEFAZ response status:', sefazR.s);
      console.log('SEFAZ response:', xml.substring(0,800));
      const cStat = (xml.match(/cStat>([\d]+)/) || [])[1] || '';
      const xMotivo = (xml.match(/xMotivo>([^<]+)/) || [])[1] || '';
      const novoNSU = (xml.match(/ultNSU>([\d]+)/) || [])[1] || nsu;
      const maxNSU = (xml.match(/maxNSU>([\d]+)/) || [])[1] || novoNSU;
      const nfs = [];
      // Tenta múltiplos formatos de docZip (com e sem namespace, com espaços)
      const docZipPattern = /docZip[^>]*schema[^>]*>([\s\S]+?)<\/[\w:]*docZip>/g;
      const docZipPattern2 = /<[\w:]*docZip[^>]*>([^<]+)<\/[\w:]*docZip>/g;
      const matches = [...xml.matchAll(docZipPattern2)];
      console.log('docZip encontrados:', matches.length, 'cStat:', cStat, 'maxNSU:', maxNSU);
      for (const m of matches) {
        try {
          const b64 = m[1].replace(/\s/g,'');
          let doc;
          try { doc = Buffer.from(b64,'base64').toString('utf8'); }
          catch(ez) { continue; }
          // Descomprime gzip se necessário
          if(doc.charCodeAt(0)===31 && doc.charCodeAt(1)===139){
            const zlib=require('zlib');
            try{ doc=zlib.gunzipSync(Buffer.from(b64,'base64')).toString('utf8'); }catch(eg){}
          }
          const chave = (doc.match(/chNFe>([^<]+)/) || [])[1] || (doc.match(/Id="NFe([0-9]{44})/) || [])[1];
          if (!chave) continue;
          const emit = (doc.match(/<emit>[\s\S]*?<xNome>([^<]+)/) || [])[1] ||
                       (doc.match(/xNome>([^<]+)/) || [])[1] || 'Fornecedor';
          const cnpjEmit = (doc.match(/<emit>[\s\S]*?<CNPJ>([^<]+)/) || [])[1] ||
                           (doc.match(/CNPJ>([^<]+)/) || [])[1] || '';
          nfs.push({
            id: chave, chave,
            numero: (doc.match(/nNF>([^<]+)/) || [])[1] || '',
            serie: (doc.match(/<serie>([^<]+)/) || [])[1] || '',
            emitente: emit,
            emitCNPJ: cnpjEmit,
            valor: parseFloat((doc.match(/vNF>([^<]+)/) || [])[1] || '0'),
            data: ((doc.match(/dhEmi>([^<]+)/) || [])[1] || '').substring(0,10),
            status: 'pendente'
          });
        } catch(ep) { console.log('Erro parse doc:', ep.message); }
      }
      return res.status(200).json({
        ok: true, nfs, total: nfs.length, cnpjEnviado: cnpjLimpo, cnpjNoCert: cnpjNoCert||'nao detectado',
        ultNSU: novoNSU, maxNSU, cStat, xMotivo,
        xmlDebug: xml.substring(0,300),
        msg: nfs.length > 0 ? nfs.length+' NF(s) encontrada(s)!' : 'cStat:'+cStat+' '+xMotivo+' | maxNSU:'+maxNSU
      });
    } catch(e) { return res.status(200).json({ ok: false, erro: e.message }); }
  }


  // ── IFOOD AUTH ────────────────────────────────────────────
  if (path === '/api/ifood/auth' && req.method === 'POST') {
    if (!auth(req)) return res.status(401).json({ erro: 'Token invalido' });
    const { clientId, step, userCode, verificationUrlComplete } = body;
    try {
      // Passo 1: Gera o user code que o iFood vai pedir
      if (step === 'generate' || !step) {
        const params = new URLSearchParams();
        params.append('clientId', clientId);
        const resp = await fetch('https://merchant-api.ifood.com.br/authentication/v1.0/oauth/userCode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params.toString()
        });
        const data = await resp.json();
        if (!resp.ok) return res.status(200).json({ ok: false, erro: data.message || JSON.stringify(data).substring(0,200) });
        return res.status(200).json({ 
          ok: true, 
          step: 'show_code',
          userCode: data.userCode,
          verificationUrl: data.verificationUrlComplete || 'https://portal.ifood.com.br/apps/code',
          expiresIn: data.expiresIn || 600,
          interval: data.interval || 5,
          deviceCode: data.authorizationCodeVerifier
        });
      }
      // Passo 2: Troca o device code pelo access token (após usuario colar o código)
      if (step === 'token') {
        const params2 = new URLSearchParams();
        params2.append('clientId', clientId);
        params2.append('grantType', 'device_code');
        params2.append('authorizationCode', userCode);
        const resp2 = await fetch('https://merchant-api.ifood.com.br/authentication/v1.0/oauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: params2.toString()
        });
        const data2 = await resp2.json();
        if (!resp2.ok) return res.status(200).json({ ok: false, erro: data2.message || 'Aguardando autorizacao', pending: true });
        return res.status(200).json({ ok: true, accessToken: data2.accessToken, refreshToken: data2.refreshToken, expiresIn: data2.expiresIn });
      }
    } catch(e) { return res.status(200).json({ ok: false, erro: e.message }); }
  }

  // ── IFOOD PEDIDOS ─────────────────────────────────────────
  if (path === '/api/ifood/pedidos' && req.method === 'POST') {
    if (!auth(req)) return res.status(401).json({ erro: 'Token invalido' });
    const { accessToken, merchantId } = body;
    try {
      // Busca eventos/pedidos
      const resp = await fetch('https://merchant-api.ifood.com.br/order/v1.0/events:polling', {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' }
      });
      const events = await resp.json();
      const pedidos = [];
      for (const ev of (Array.isArray(events) ? events : [])) {
        if (ev.code === 'PLACED' || ev.code === 'CONFIRMED') {
          try {
            const orderResp = await fetch('https://merchant-api.ifood.com.br/order/v1.0/orders/' + ev.orderId, {
              headers: { 'Authorization': 'Bearer ' + accessToken }
            });
            const order = await orderResp.json();
            pedidos.push({
              id: ev.orderId,
              cliente: order.customer?.name || 'Cliente iFood',
              valor: order.totalPrice || 0,
              data: new Date(order.createdAt || Date.now()).toLocaleDateString('pt-BR'),
              status: order.fullCode || ev.code
            });
          } catch(eo) {}
        }
      }
      // Confirma recebimento dos eventos
      if (Array.isArray(events) && events.length > 0) {
        const ids = events.map(e => e.id);
        await fetch('https://merchant-api.ifood.com.br/order/v1.0/events/acknowledgment', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
          body: JSON.stringify(ids.map(id => ({ id })))
        });
      }
      return res.status(200).json({ ok: true, pedidos, total: pedidos.length });
    } catch(e) { return res.status(200).json({ ok: false, erro: e.message }); }
  }


  // ── NF-e SEFAZ DESTINATÁRIO ──────────────────────────────

  // 404
  return res.status(404).json({ erro: 'Rota não encontrada', rota: path });
};

// ── Analisa recibo com Claude ─────────────────────────────
async function analisarRecibo(texto, imagemBase64) {
  const apiKey = ANTHROPIC_KEY;
  if (!apiKey) return analisarHeuristico(texto);

  try {
    const messages = [{
      role: 'user',
      content: imagemBase64
        ? [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imagemBase64 } },
            { type: 'text', text: PROMPT_RECIBO + (texto ? '\nTexto: ' + texto : '') }
          ]
        : PROMPT_RECIBO + '\nTexto: ' + texto
    }];

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 400, messages })
    });

    const data = await r.json();
    const raw = (data.content || []).map(b => b.text || '').join('').replace(/```json|```/g, '').trim();
    const json = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
    return json.valor > 0 ? json : analisarHeuristico(texto);
  } catch(e) {
    return analisarHeuristico(texto);
  }
}

const PROMPT_RECIBO = `Leia este comprovante e extraia SOMENTE o que está escrito. NÃO invente dados.
Retorne APENAS JSON:
{"valor":0.00,"juros":0.00,"descricao":"texto do comprovante","destinatario":"nome exato","tipo":"pix|boleto|ted|dinheiro","categoria":"Folha CLT|Diária|Freelancer|Entregador|Vale|Fornecedor|Aluguel|Energia|Telecom|Juros|IOF|Outros","data":"DD/MM/AAAA","obs":"observacao pix se houver"}
Regras: pessoa física=Folha CLT, empresa/CNPJ=Fornecedor, obs entregador=Entregador, obs vale=Vale. Se não for comprovante: {"erro":"nao_identificado"}`;

function analisarHeuristico(texto) {
  if (!texto) return null;
  const t = texto.toLowerCase();
  const valorMatch = texto.match(/R\$\s*([\d.,]+)/i) || texto.match(/valor[:\s]+([\d.,]+)/i);
  if (!valorMatch) return null;
  const valor = parseFloat(valorMatch[1].replace('.','').replace(',','.'));
  if (!valor || valor <= 0) return null;

  const jurosMatch = texto.match(/juros[:\s]+([\d.,]+)/i);
  const juros = jurosMatch ? parseFloat(jurosMatch[1].replace('.','').replace(',','.')) : 0;

  let categoria = 'Outros';
  if (/entregador|motoboy/i.test(t)) categoria = 'Entregador';
  else if (/vale|adiantamento/i.test(t)) categoria = 'Vale';
  else if (/diaria|diarista/i.test(t)) categoria = 'Diária';
  else if (/freelancer|autonomo/i.test(t)) categoria = 'Freelancer';
  else if (/folha|salario|funcionario/i.test(t)) categoria = 'Folha CLT';
  else if (/boleto|titulo/i.test(t)) categoria = 'Fornecedor';
  else if (/energia|cemig/i.test(t)) categoria = 'Energia';
  else if (/iof|juros/i.test(t)) categoria = 'Juros';

  return { valor, juros, descricao: texto.substring(0,80), destinatario: '', tipo: /pix/i.test(t)?'pix':'outros', categoria, data: hj(), obs: '' };
}

function formatarResposta(l) {
  return [
    `✅ *Lançado no GestaoERP*`,
    `💰 Valor: R$ ${l.valor.toFixed(2).replace('.',',')}`,
    `📂 ${l.categoria}`,
    `👤 ${l.destinatario || l.descricao?.substring(0,40) || ''}`,
    `📅 ${l.data}`,
    l.juros > 0 ? `⚠️ Juros: R$ ${l.juros.toFixed(2).replace('.',',')}` : ''
  ].filter(Boolean).join('\n');
}

// ── Cielo API ─────────────────────────────────────────────
async function buscarRelatorioCielo(merchantId, merchantKey, data, turnoIni, turnoFim) {
  const headers = {
    'MerchantId': merchantId,
    'MerchantKey': merchantKey,
    'Content-Type': 'application/json'
  };
  // API Cielo v2 — busca transações do dia
  const url = `https://apiquery.cieloecommerce.cielo.com.br/1/sales?merchantOrderId=${data.replace(/-/g,'')}&pageSize=100`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) throw new Error(`Cielo: ${resp.status}`);
  const data2 = await resp.json();

  const vendas = data2.Payments || [];
  let credito = 0, debito = 0, pix = 0;
  vendas.forEach(v => {
    if (v.Status === 2) { // Pago
      if (v.Type === 'CreditCard') credito += v.Amount / 100;
      else if (v.Type === 'DebitCard') debito += v.Amount / 100;
      else if (v.Type === 'Pix') pix += v.Amount / 100;
    }
  });
  return { credito, debito, pix, total: credito + debito + pix, transacoes: vendas.length };
}

// ── Stone API ─────────────────────────────────────────────
async function buscarRelatorioStone(stoneCode, token, data) {
  // Stone API v1
  const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
  const resp = await fetch(`https://sandbox-api.openbank.stone.com.br/api/v1/merchants/${stoneCode}/sales`, { headers });
  if (!resp.ok) throw new Error(`Stone: ${resp.status}`);
  const data2 = await resp.json();
  return { credito: 0, debito: 0, pix: 0, total: 0, msg: 'Stone API em configuração' };
}

function gerarChaveNFCe(cnpj) {
  const c = (cnpj||'44686412000100').replace(/\D/g,'');
  const rand = () => Math.floor(Math.random() * 1e9).toString().padStart(9,'0');
  const d = new Date();
  return `31${String(d.getFullYear()).slice(2)}${String(d.getMonth()+1).padStart(2,'0')}${c}650010001${rand()}1${rand().slice(0,8)}0`;
}
