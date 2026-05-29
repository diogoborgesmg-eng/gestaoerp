// ═══════════════════════════════════════════════════════════
// GestaoERP API — Backend SEFAZ
// Di Casa Laranjinha — CNPJ: 44.686.412/0001-00
// Deploy: Vercel (serverless)
// ═══════════════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');
const { carregarCertificado, consultarStatus, consultarNFe, distribuicaoDFe } = require('./sefaz');
const { montarXMLNFCe } = require('./nfce');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// ─── Autenticação simples por token ────────────────────────
// Token gerado automaticamente — mude antes do deploy
const API_TOKEN = process.env.API_TOKEN || 'gestaoerp_diCasa_44686412';

function autenticar(req, res, next) {
  const token = req.headers['x-api-token'] || req.query.token;
  if (token !== API_TOKEN) {
    return res.status(401).json({ erro: 'Token inválido' });
  }
  next();
}

// ─── Rota raiz — health check ───────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    sistema: 'GestaoERP API - Di Casa Laranjinha',
    cnpj: '44.686.412/0001-00',
    versao: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// ─── Status da SEFAZ MG ─────────────────────────────────────
app.post('/api/sefaz/status', autenticar, async (req, res) => {
  try {
    const { pfxBase64, senha, ambiente } = req.body;
    if (!pfxBase64 || !senha) return res.status(400).json({ erro: 'pfxBase64 e senha obrigatórios' });
    const resultado = await consultarStatus(pfxBase64, senha, ambiente || 'prod');
    res.json({ sucesso: true, xml: resultado });
  } catch (e) {
    res.status(500).json({ sucesso: false, erro: e.message });
  }
});

// ─── Validar certificado ────────────────────────────────────
app.post('/api/certificado/validar', autenticar, async (req, res) => {
  try {
    const { pfxBase64, senha } = req.body;
    if (!pfxBase64 || !senha) return res.status(400).json({ erro: 'Campos obrigatórios' });
    const info = carregarCertificado(pfxBase64, senha);
    const vencido = new Date(info.validade) < new Date();
    res.json({
      sucesso: true,
      validade: info.validade,
      cnpj: info.cnpj,
      vencido,
      diasRestantes: Math.floor((new Date(info.validade) - new Date()) / (1000*60*60*24))
    });
  } catch (e) {
    res.status(400).json({ sucesso: false, erro: 'Certificado inválido ou senha incorreta: ' + e.message });
  }
});

// ─── Consultar NF-e pela chave ──────────────────────────────
app.post('/api/nfe/consultar', autenticar, async (req, res) => {
  try {
    const { chave, pfxBase64, senha, ambiente } = req.body;
    if (!chave || !pfxBase64 || !senha) return res.status(400).json({ erro: 'Campos obrigatórios' });
    if (chave.replace(/[^\d]/g,'').length !== 44) return res.status(400).json({ erro: 'Chave deve ter 44 dígitos' });
    const resultado = await consultarNFe(chave.replace(/[^\d]/g,''), pfxBase64, senha, ambiente || 'prod');
    res.json({ sucesso: true, xml: resultado });
  } catch (e) {
    res.status(500).json({ sucesso: false, erro: e.message });
  }
});

// ─── Distribuição DFe — NF-e emitidas CONTRA o CNPJ ────────
// (busca notas de fornecedores automaticamente)
app.post('/api/nfe/distribuicao', autenticar, async (req, res) => {
  try {
    const { pfxBase64, senha, cnpj, ultNSU, ambiente } = req.body;
    if (!pfxBase64 || !senha) return res.status(400).json({ erro: 'Campos obrigatórios' });
    const cnpjFinal = (cnpj || '44686412000100').replace(/[^\d]/g,'');
    const resultado = await distribuicaoDFe(pfxBase64, senha, cnpjFinal, ultNSU || '000000000000000', ambiente || 'prod');
    res.json({ sucesso: true, xml: resultado });
  } catch (e) {
    res.status(500).json({ sucesso: false, erro: e.message });
  }
});

// ─── Emitir NFC-e ───────────────────────────────────────────
app.post('/api/nfce/emitir', autenticar, async (req, res) => {
  try {
    const { pfxBase64, senha, itens, pagamentos, total, nNF, serie, csc, cscId, cpfCliente, ambiente } = req.body;
    
    // Validações
    if (!pfxBase64 || !senha || !itens?.length || !pagamentos?.length) {
      return res.status(400).json({ erro: 'Campos obrigatórios: pfxBase64, senha, itens, pagamentos' });
    }
    if (!csc || !cscId) {
      return res.status(400).json({ erro: 'CSC e cscId obrigatórios para NFC-e. Consulte seu contador.' });
    }

    // Carrega certificado
    const { certPem, keyPem } = carregarCertificado(pfxBase64, senha);

    // Gera número aleatório para cNF
    const cNF = String(Math.floor(Math.random() * 99999999)).padStart(8, '0');
    
    // Data/hora atual no formato SEFAZ (yyyy-MM-ddTHH:mm:ss-03:00)
    const agora = new Date();
    const offset = '-03:00';
    const dhEmis = agora.getFullYear() + '-' +
      String(agora.getMonth()+1).padStart(2,'0') + '-' +
      String(agora.getDate()).padStart(2,'0') + 'T' +
      String(agora.getHours()).padStart(2,'0') + ':' +
      String(agora.getMinutes()).padStart(2,'0') + ':' +
      String(agora.getSeconds()).padStart(2,'0') + offset;

    // Monta o XML
    const { xml, chave } = montarXMLNFCe({
      itens, pagamentos, total, nNF: String(nNF), serie: String(serie || '001'),
      cNF, dhEmis, certPem, keyPem, cpfCliente, csc, cscId, ambiente: ambiente || 'prod'
    });

    // Envia para SEFAZ
    const { enviarSOAP } = require('./sefaz');
    const wsUrl = (ambiente || 'prod') === 'prod' 
      ? 'https://nfce.fazenda.mg.gov.br/nfce/services/NFeAutorizacao4'
      : 'https://hnfce.fazenda.mg.gov.br/nfce/services/NFeAutorizacao4';

    const xmlEnvio = `<nfeAutorizacaoLote xmlns="http://www.portalfiscal.inf.br/nfe">
      <enviNFe versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
        <idLote>${Date.now()}</idLote>
        <indSinc>1</indSinc>
        ${xml}
      </enviNFe>
    </nfeAutorizacaoLote>`;

    const resposta = await enviarSOAP(wsUrl, xmlEnvio, certPem, keyPem);
    
    res.json({
      sucesso: true,
      chave,
      dhEmis,
      xmlRetorno: resposta,
      danfeUrl: `https://nfce.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml?p=${chave}|2|${(ambiente||'prod')==='prod'?'1':'2'}|1|`
    });

  } catch (e) {
    res.status(500).json({ sucesso: false, erro: e.message });
  }
});

// ─── Cancelar NFC-e ─────────────────────────────────────────
app.post('/api/nfce/cancelar', autenticar, async (req, res) => {
  try {
    const { pfxBase64, senha, chave, justificativa, dhEvento, ambiente } = req.body;
    if (!pfxBase64 || !senha || !chave || !justificativa) {
      return res.status(400).json({ erro: 'Campos obrigatórios' });
    }
    if (justificativa.length < 15) {
      return res.status(400).json({ erro: 'Justificativa deve ter no mínimo 15 caracteres' });
    }

    const { certPem, keyPem } = carregarCertificado(pfxBase64, senha);
    const nSeqEvento = '1';
    const agora = dhEvento || new Date().toISOString().replace('Z','-03:00');

    const xmlEvento = `<envEvento versao="1.00" xmlns="http://www.portalfiscal.inf.br/nfe">
      <idLote>${Date.now()}</idLote>
      <evento versao="1.00">
        <infEvento Id="ID11012${chave}${nSeqEvento.padStart(2,'0')}">
          <cOrgao>31</cOrgao>
          <tpAmb>${(ambiente||'prod')==='prod'?'1':'2'}</tpAmb>
          <CNPJ>${CNPJ_EMITENTE}</CNPJ>
          <chNFe>${chave}</chNFe>
          <dhEvento>${agora}</dhEvento>
          <tpEvento>110111</tpEvento>
          <nSeqEvento>${nSeqEvento}</nSeqEvento>
          <verEvento>1.00</verEvento>
          <detEvento versao="1.00">
            <descEvento>Cancelamento</descEvento>
            <nProt></nProt>
            <xJust>${justificativa}</xJust>
          </detEvento>
        </infEvento>
      </evento>
    </envEvento>`;

    const wsUrl = (ambiente||'prod')==='prod'
      ? 'https://nfce.fazenda.mg.gov.br/nfce/services/RecepcaoEvento4'
      : 'https://hnfce.fazenda.mg.gov.br/nfce/services/RecepcaoEvento4';

    const { enviarSOAP } = require('./sefaz');
    const resposta = await enviarSOAP(wsUrl, xmlEvento, certPem, keyPem);
    res.json({ sucesso: true, xml: resposta });
  } catch (e) {
    res.status(500).json({ sucesso: false, erro: e.message });
  }
});

// Inicia servidor (para teste local)
const PORT = process.env.PORT || 3001;
if (require.main === module) {
  app.listen(PORT, () => console.log(`GestaoERP API rodando na porta ${PORT}`));
}

module.exports = app;
