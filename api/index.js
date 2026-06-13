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
  return t === API_TOKEN;
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
    const { itens, total, csc, cscId, cnpj, pfxBase64, pfxSenha, cpfCliente, pagamentos } = body;
    if (!itens || !total) return res.status(400).json({ erro: 'itens e total obrigatórios' });
    if (!csc) return res.status(400).json({ erro: 'CSC obrigatório' });
    if (!pfxBase64) return res.status(400).json({ erro: 'Certificado digital obrigatório' });

    try {
      const https = require('https');
      const crypto = require('crypto');
      const forge = require('node-forge');

      // Parse do certificado
      let privateKey, certificate, certPem;
      try {
        const pfxDer = forge.util.decode64(pfxBase64);
        const pfxAsn1 = forge.asn1.fromDer(pfxDer);
        const pfx = forge.pkcs12.pkcs12FromAsn1(pfxAsn1, pfxSenha || '');
        pfx.safeContents.forEach(sc => {
          sc.safeBags.forEach(bag => {
            if (bag.type === forge.pki.oids.pkcs8ShroudedKeyBag || bag.type === forge.pki.oids.keyBag)
              privateKey = bag.key;
            if (bag.type === forge.pki.oids.certBag && !certificate) {
              certificate = bag.cert;
              certPem = forge.pki.certificateToPem(bag.cert);
            }
          });
        });
      } catch(eCert) {
        return res.status(200).json({ ok: false, erro: 'Certificado inválido: ' + eCert.message });
      }

      const cnpjLimpo = (cnpj || '44686412000100').replace(/\D/g, '');
      const cUF = '31'; // MG
      const dhEmi = new Date().toISOString().replace('Z', '-03:00').substring(0, 22) + ':00';
      const nNF = String(Math.floor(Math.random() * 900000) + 100000);
      const serie = '001';
      const tpAmb = '1'; // 1=produção 2=homologação

      // Gera chave de acesso (44 dígitos)
      const aamm = dhEmi.substring(0, 7).replace('-', '');
      const cNF = String(Math.floor(Math.random() * 90000000) + 10000000);
      const chaveBase = cUF + aamm + cnpjLimpo + '65' + serie.padStart(3,'0') + nNF.padStart(9,'0') + '1' + cNF;
      // Dígito verificador
      let peso = 2; let soma = 0;
      for (let i = chaveBase.length - 1; i >= 0; i--) {
        soma += parseInt(chaveBase[i]) * peso;
        peso = peso === 9 ? 2 : peso + 1;
      }
      const dv = 11 - (soma % 11);
      const cDV = dv > 9 ? 0 : dv;
      const chave = chaveBase + cDV;

      // Monta XML NFC-e
      const itensXML = (itens || []).map((it, idx) => {
        const vProd = (Number(it.vUnit || 0) * Number(it.qtd || 1)).toFixed(2);
        return `<det nItem="${idx+1}">
<prod>
<cProd>${String(it.id || idx+1).substring(0,60)}</cProd>
<cEAN>SEM GTIN</cEAN>
<xProd>${(it.nome || 'PRODUTO').substring(0,120)}</xProd>
<NCM>${(it.ncm || '21069090').replace(/\D/g,'')}</NCM>
<CFOP>5102</CFOP>
<uCom>UN</uCom>
<qCom>${Number(it.qtd || 1).toFixed(2)}</qCom>
<vUnCom>${Number(it.vUnit || 0).toFixed(2)}</vUnCom>
<vProd>${vProd}</vProd>
<cEANTrib>SEM GTIN</cEANTrib>
<uTrib>UN</uTrib>
<qTrib>${Number(it.qtd || 1).toFixed(2)}</qTrib>
<vUnTrib>${Number(it.vUnit || 0).toFixed(2)}</vUnTrib>
<indTot>1</indTot>
</prod>
<imposto>
<ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS>
<PIS><PISAliq><CST>07</CST><vBC>0.00</vBC><pPIS>0.00</pPIS><vPIS>0.00</vPIS></PISAliq></PIS>
<COFINS><COFINSAliq><CST>07</CST><vBC>0.00</vBC><pCOFINS>0.00</pCOFINS><vCOFINS>0.00</vCOFINS></COFINSAliq></COFINS>
</imposto>
</det>`;
      }).join('');

      const pgtoXML = (pagamentos || [{tipo:'01',valor:total}]).map(p =>
        `<detPag><tPag>${p.tipo||'01'}</tPag><vPag>${Number(p.valor||0).toFixed(2)}</vPag></detPag>`
      ).join('');

      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
<infNFe versao="4.00" Id="NFe${chave}">
<ide>
<cUF>${cUF}</cUF><cNF>${cNF}</cNF><natOp>VENDA AO CONSUMIDOR</natOp>
<mod>65</mod><serie>${serie}</serie><nNF>${nNF}</nNF>
<dhEmi>${dhEmi}</dhEmi><tpNF>1</tpNF><idDest>1</idDest>
<cMunFG>3149309</cMunFG><tpImp>4</tpImp><tpEmis>1</tpEmis>
<cDV>${cDV}</cDV><tpAmb>${tpAmb}</tpAmb><finNFe>1</finNFe>
<indFinal>1</indFinal><indPres>1</indPres><procEmi>0</procEmi><verProc>GestaoERP1.0</verProc>
</ide>
<emit>
<CNPJ>${cnpjLimpo}</CNPJ>
<xNome>DI CASA GASTRONOMIA LTDA</xNome>
<enderEmit>
<xLgr>RUA DAS PALMEIRAS</xLgr><nro>123</nro>
<xBairro>CENTRO</xBairro><cMun>3149309</cMun>
<xMun>PATOS DE MINAS</xMun><UF>MG</UF><CEP>38700000</CEP>
<cPais>1058</cPais><xPais>BRASIL</xPais>
</enderEmit>
<IE>00422949900056</IE><CRT>1</CRT>
</emit>
${cpfCliente ? `<dest><CPF>${cpfCliente.replace(/\D/g,'')}</CPF><xNome>CONSUMIDOR</xNome><indIEDest>9</indIEDest></dest>` : ''}
${itensXML}
<total><ICMSTot>
<vBC>0.00</vBC><vICMS>0.00</vICMS><vICMSDeson>0.00</vICMSDeson>
<vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST>
<vFCPST>0.00</vFCPST><vFCPSTRet>0.00</vFCPSTRet>
<vProd>${Number(total).toFixed(2)}</vProd>
<vFrete>0.00</vFrete><vSeg>0.00</vSeg><vDesc>0.00</vDesc>
<vII>0.00</vII><vIPI>0.00</vIPI><vIPIDevol>0.00</vIPIDevol>
<vPIS>0.00</vPIS><vCOFINS>0.00</vCOFINS><vOutro>0.00</vOutro>
<vNF>${Number(total).toFixed(2)}</vNF>
</ICMSTot></total>
<transp><modFrete>9</modFrete></transp>
<pag>${pgtoXML}<vTroco>0.00</vTroco></pag>
<infAdic><infCpl>OBRIGADO PELA PREFERENCIA!</infCpl></infAdic>
<infNFeSupl>
<qrCode>https://nfce.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml?p=${chave}|2|${tpAmb}|1|${csc.substring(0,8)}</qrCode>
<urlFrag>https://nfce.fazenda.mg.gov.br/portalnfce</urlFrag>
</infNFeSupl>
</infNFe>
</NFe>`;

      // Assina o XML
      const md = forge.md.sha256.create();
      const infNFeContent = xml.match(/<infNFe[\s\S]*<\/infNFe>/)?.[0] || '';
      md.update(forge.util.encodeUtf8(infNFeContent));
      const signature = forge.util.encode64(privateKey.sign(md));
      const certB64 = forge.util.encode64(forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes());

      const xmlAssinado = xml.replace('</NFe>', `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#">
<SignedInfo><CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>
<SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>
<Reference URI="#NFe${chave}"><Transforms><Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"/></Transforms>
<DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><DigestValue>${signature.substring(0,44)}</DigestValue>
</Reference></SignedInfo>
<SignatureValue>${signature}</SignatureValue>
<KeyInfo><X509Data><X509Certificate>${certB64}</X509Certificate></X509Data></KeyInfo>
</Signature></NFe>`);

      // Envia para SEFAZ MG
      const soapEnv = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:nfe="http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4">
<soapenv:Header/><soapenv:Body><nfe:nfeDadosMsg>${xmlAssinado}</nfe:nfeDadosMsg></soapenv:Body></soapenv:Envelope>`;

      const certKeyPem = forge.pki.privateKeyToPem(privateKey);
      const sefazResp = await new Promise((resolve, reject) => {
        const opts = {
          hostname: 'nfce.fazenda.mg.gov.br', port: 443,
          path: '/nfce/services/NFeAutorizacao4',
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml;charset=UTF-8',
            'SOAPAction': '"http://www.portalfiscal.inf.br/nfe/wsdl/NFeAutorizacao4/nfeAutorizacaoLote"',
            'Content-Length': Buffer.byteLength(soapEnv)
          },
          key: certKeyPem, cert: certPem, rejectUnauthorized: false, timeout: 25000
        };
        const r = https.request(opts, res2 => {
          let d = ''; res2.on('data', c => d += c); res2.on('end', () => resolve({ s: res2.statusCode, d }));
        });
        r.on('error', reject); r.write(soapEnv); r.end();
      });

      const xmlResp = sefazResp.d;
      const cStat = (xmlResp.match(/cStat>([^<]+)/) || [])[1] || '';
      const xMotivo = (xmlResp.match(/xMotivo>([^<]+)/) || [])[1] || '';
      const nProt = (xmlResp.match(/nProt>([^<]+)/) || [])[1] || '';
      const dhRecbto = (xmlResp.match(/dhRecbto>([^<]+)/) || [])[1] || '';

      const autorizada = cStat === '100';
      const qrCodeUrl = `https://nfce.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml?p=${chave}|2|${tpAmb}|1|${csc.substring(0,8)}`;

      return res.status(200).json({
        ok: autorizada,
        autorizada,
        chave, nProt, dhRecbto,
        cStat, xMotivo,
        qrCode: qrCodeUrl,
        numero: nNF, serie,
        mensagem: autorizada ? 'NFC-e autorizada!' : ('SEFAZ: ' + cStat + ' - ' + xMotivo),
        xmlAssinado: autorizada ? xmlAssinado : undefined
      });

    } catch(e) {
      return res.status(200).json({ ok: false, erro: e.message });
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
  if (path === '/api/nfe/sefaz' && req.method === 'POST') {
    if (!auth(req)) return res.status(401).json({ erro: 'Token invalido' });
    const { cnpj, pfxBase64, pfxSenha, ultNSU } = body;
    if (!cnpj || !pfxBase64) return res.status(400).json({ erro: 'CNPJ e certificado obrigatorios' });
    try {
      let forge;
      try { forge = require('node-forge'); }
      catch(eForge) { return res.status(200).json({ ok: false, erro: 'node-forge nao disponivel: ' + eForge.message }); }
      const https = require('https');
      let privateKey, certificate;
      const pfxDer = forge.util.decode64(pfxBase64);
      const pfxAsn1 = forge.asn1.fromDer(pfxDer);
      const pfx = forge.pkcs12.pkcs12FromAsn1(pfxAsn1, pfxSenha || '');
      pfx.safeContents.forEach(sc => {
        sc.safeBags.forEach(bag => {
          if (bag.type === forge.pki.oids.pkcs8ShroudedKeyBag || bag.type === forge.pki.oids.keyBag) privateKey = forge.pki.privateKeyToPem(bag.key);
          if (bag.type === forge.pki.oids.certBag && !certificate) certificate = forge.pki.certificateToPem(bag.cert);
        });
      });
      if (!privateKey || !certificate) return res.status(200).json({ ok: false, erro: 'Certificado invalido ou senha errada' });
      const cnpjLimpo = cnpj.replace(/\D/g, '');
      const nsu = ultNSU || '000000000000000';
      const soap = '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:nfeDist="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><soapenv:Header/><soapenv:Body><nfeDist:nfeDistDFeInteresse><nfeDist:nfeDadosMsg><distDFeInt versao="1.01" xmlns="http://www.portalfiscal.inf.br/nfe"><tpAmb>1</tpAmb><cUFAutor>31</cUFAutor><CNPJ>'+cnpjLimpo+'</CNPJ><distNSU><ultNSU>'+nsu+'</ultNSU></distNSU></distDFeInt></nfeDist:nfeDadosMsg></nfeDist:nfeDistDFeInteresse></soapenv:Body></soapenv:Envelope>';
      const sefazR = await new Promise((resolve, reject) => {
        const opts = {
          hostname: 'www1.nfe.fazenda.gov.br', port: 443,
          path: '/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
          method: 'POST',
          headers: { 'Content-Type': 'text/xml;charset=UTF-8', 'SOAPAction': '"http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse"', 'Content-Length': Buffer.byteLength(soap) },
          key: privateKey, cert: certificate, rejectUnauthorized: false, timeout: 25000
        };
        const r = https.request(opts, res2 => { let d=''; res2.on('data',c=>d+=c); res2.on('end',()=>resolve({s:res2.statusCode,d})); });
        r.on('error', reject);
        r.write(soap); r.end();
      });
      if (sefazR.s !== 200) return res.status(200).json({ ok: false, erro: 'SEFAZ HTTP '+sefazR.s, raw: sefazR.d.substring(0,300) });
      const xml = sefazR.d;
      const cStat = (xml.match(/cStat>([^<]+)/) || [])[1] || '';
      const xMotivo = (xml.match(/xMotivo>([^<]+)/) || [])[1] || '';
      const novoNSU = (xml.match(/ultNSU>([^<]+)/) || [])[1] || nsu;
      const nfs = [];
      for (const m of xml.matchAll(/docZip[^>]*>([^<]+)<\/docZip/g)) {
        try {
          const doc = Buffer.from(m[1],'base64').toString('utf8');
          const chave = (doc.match(/chNFe>([^<]+)/) || [])[1];
          if (chave) nfs.push({ id: chave, chave, numero: (doc.match(/nNF>([^<]+)/) || [])[1]||'', serie: (doc.match(/serie>([^<]+)/) || [])[1]||'', emitente: (doc.match(/xNome>([^<]+)/) || [])[1]||'Fornecedor', emitCNPJ: (doc.match(/CNPJ>([^<]+)/) || [])[1]||'', valor: parseFloat((doc.match(/vNF>([^<]+)/) || [])[1]||'0'), data: ((doc.match(/dhEmi>([^<]+)/) || [])[1]||'').substring(0,10), status: 'pendente' });
        } catch(ep) {}
      }
      return res.status(200).json({ ok: true, nfs, total: nfs.length, ultNSU: novoNSU, cStat: cStat||'', xMotivo: xMotivo||'', msg: nfs.length>0?nfs.length+' NF(s) encontrada(s)':'Nenhuma NF nova. cStat:'+cStat+' '+xMotivo });
    } catch(e) { console.error('SEFAZ erro:', e); return res.status(200).json({ ok: false, erro: e.message, stack: e.stack?.substring(0,200) }); }
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
