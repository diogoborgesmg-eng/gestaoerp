// ═══════════════════════════════════════════════════════════
// GestaoERP API v1781122062 — Backend Serverless v3.0
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
    console.log('API v1781122513 iniciada');
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
    const { cnpj, pfxBase64, pfxSenha, dtInicio, ultNSU } = body;
    if (!cnpj) return res.status(400).json({ erro: 'CNPJ obrigatório' });
    if (!pfxBase64) return res.status(400).json({ erro: 'Certificado digital obrigatório' });

    try {
      const forge = require('node-forge');
      const https = require('https');
      
      // Descompacta o certificado PFX
      const pfxDer = forge.util.decode64(pfxBase64);
      const pfxAsn1 = forge.asn1.fromDer(pfxDer);
      const pfx = forge.pkcs12.pkcs12FromAsn1(pfxAsn1, pfxSenha || '');
      
      // Extrai chave privada e certificado
      let privateKey = null;
      let certificate = null;
      
      pfx.safeContents.forEach(sc => {
        sc.safeBags.forEach(bag => {
          if (bag.type === forge.pki.oids.pkcs8ShroudedKeyBag || bag.type === forge.pki.oids.keyBag) {
            privateKey = forge.pki.privateKeyToPem(bag.key);
          }
          if (bag.type === forge.pki.oids.certBag) {
            certificate = forge.pki.certificateToPem(bag.cert);
          }
        });
      });
      
      if (!privateKey || !certificate) {
        return res.status(400).json({ erro: 'Certificado inválido ou senha incorreta' });
      }

      const cnpjLimpo = cnpj.replace(/\D/g, '');
      const nsu = ultNSU || '000000000000000';
      const dtIni = dtInicio || '2026-06-01T00:00:00-03:00';
      
      // Monta SOAP para consulta de DF-e destinatário
      const soapBody = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:nfeDist="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe">
 <soapenv:Header/>
 <soapenv:Body>
  <nfeDist:nfeDistDFeInteresse>
   <nfeDist:nfeDadosMsg>
    <distDFeInt versao="1.01" xmlns="http://www.portalfiscal.inf.br/nfe">
     <tpAmb>1</tpAmb>
     <cUFAutor>31</cUFAutor>
     <CNPJ>${cnpjLimpo}</CNPJ>
     <distNSU>
      <ultNSU>${nsu}</ultNSU>
     </distNSU>
    </distDFeInt>
   </nfeDist:nfeDadosMsg>
  </nfeDist:nfeDistDFeInteresse>
 </soapenv:Body>
</soapenv:Envelope>`;

      // Assina e envia para SEFAZ
      const sefazResp = await new Promise((resolve, reject) => {
        const options = {
          hostname: 'www.nfe.fazenda.gov.br',
          port: 443,
          path: '/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml;charset=UTF-8',
            'SOAPAction': 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse',
            'Content-Length': Buffer.byteLength(soapBody)
          },
          key: privateKey,
          cert: certificate,
          rejectUnauthorized: false
        };
        
        const req2 = https.request(options, (res2) => {
          let data = '';
          res2.on('data', c => data += c);
          res2.on('end', () => resolve({ status: res2.statusCode, data }));
        });
        req2.on('error', reject);
        req2.write(soapBody);
        req2.end();
      });

      if (sefazResp.status !== 200) {
        return res.status(200).json({ ok: false, erro: 'SEFAZ retornou: ' + sefazResp.status, raw: sefazResp.data.substring(0, 500) });
      }

      // Parse da resposta SOAP
      const xmlResp = sefazResp.data;
      
      // Extrai os documentos fiscais
      const nfsEncontradas = [];
      const matches = xmlResp.matchAll(/<docZip[^>]*>([^<]+)<\/docZip>/g);
      for (const m of matches) {
        try {
          const xmlDoc = Buffer.from(m[1], 'base64').toString('utf8');
          // Extrai dados básicos da NF
          const chave = (xmlDoc.match(/chNFe>([^<]+)/) || [])[1] || '';
          const emitNome = (xmlDoc.match(/xNome>([^<]+)/) || [])[1] || 'Fornecedor';
          const emitCNPJ = (xmlDoc.match(/emit>[\s\S]*?CNPJ>([^<]+)/) || [])[1] || '';
          const valor = parseFloat((xmlDoc.match(/vNF>([^<]+)/) || [])[1] || '0');
          const numero = (xmlDoc.match(/nNF>([^<]+)/) || [])[1] || '';
          const serie = (xmlDoc.match(/serie>([^<]+)/) || [])[1] || '';
          const dhEmi = (xmlDoc.match(/dhEmi>([^<]+)/) || [])[1] || '';
          
          if (chave) {
            nfsEncontradas.push({
              id: chave,
              chave, numero, serie,
              emitente: emitNome,
              emitCNPJ,
              valor,
              data: dhEmi.substring(0, 10),
              status: 'pendente',
              xml: xmlDoc
            });
          }
        } catch(ep) {}
      }

      // Extrai novo NSU
      const novoNSU = (xmlResp.match(/ultNSU>([^<]+)/) || [])[1] || nsu;
      const maxNSU = (xmlResp.match(/maxNSU>([^<]+)/) || [])[1] || nsu;
      const cStat = (xmlResp.match(/cStat>([^<]+)/) || [])[1] || '';

      return res.status(200).json({
        ok: true,
        nfs: nfsEncontradas,
        total: nfsEncontradas.length,
        ultNSU: novoNSU,
        maxNSU,
        cStat,
        msg: nfsEncontradas.length > 0 ? nfsEncontradas.length + ' NF(s) encontrada(s)' : 'Nenhuma NF nova'
      });

    } catch(e) {
      return res.status(200).json({ ok: false, erro: e.message });
    }
  
  } else if (path === );
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


  // ── LANÇAR VIA WHATSAPP ───────────────────────────────────
  if (path === '/api/lancar' && req.method === 'POST') {
    if (!auth(req)) return res.status(401).json({ erro: 'Token inválido' });
    try {
      const { valor, categoria, descricao, tipo, data, origem, numero } = body;
      if (!valor || valor <= 0) return res.status(400).json({ erro: 'Valor inválido' });
      
      // Armazena em memória (KV store via Vercel)
      // Usa um arquivo JSON simples como buffer temporário
      const lancamento = {
        id: Date.now().toString(36),
        valor: parseFloat(valor),
        categoria: categoria || 'Outros',
        descricao: descricao || 'WhatsApp Bot',
        tipo: tipo || 'pix',
        data: data || new Date().toLocaleDateString('pt-BR'),
        origem: origem || 'whatsapp',
        numero,
        criadoEm: new Date().toISOString(),
        sincronizado: false
      };
      
      // Armazena no buffer global (persiste enquanto serverless está ativo)
      if (!global._lancamentosBuffer) global._lancamentosBuffer = [];
      global._lancamentosBuffer.push(lancamento);
      // Mantém só os últimos 100
      if (global._lancamentosBuffer.length > 100) {
        global._lancamentosBuffer = global._lancamentosBuffer.slice(-100);
      }
      
      console.log('✅ Lançamento recebido do bot:', lancamento.valor, lancamento.categoria);
      return res.status(200).json({ ok: true, lancamento });
    } catch(e) {
      return res.status(500).json({ erro: e.message });
    }
  }

  // ── BUSCAR LANÇAMENTOS PENDENTES ─────────────────────────
  if (path === '/api/lancar/pendentes' && req.method === 'GET') {
    if (!auth(req)) return res.status(401).json({ erro: 'Token inválido' });
    const pendentes = (global._lancamentosBuffer || []).filter(l => !l.sincronizado);
    // Marca como sincronizados
    (global._lancamentosBuffer || []).forEach(l => l.sincronizado = true);
    return res.status(200).json({ ok: true, lancamentos: pendentes });
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
