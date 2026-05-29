// ═══════════════════════════════════════════════════════════
// SEFAZ MG — Módulo de comunicação
// CNPJ: 44.686.412/0001-00 — Di Casa Laranjinha
// ═══════════════════════════════════════════════════════════

const forge = require('node-forge');
const https = require('https');
const { create } = require('xmlbuilder2');

// WebServices SEFAZ MG
const WS = {
  prod: {
    nfce_autorizacao:    'https://nfce.fazenda.mg.gov.br/nfce/services/NFeAutorizacao4',
    nfce_retautorizacao: 'https://nfce.fazenda.mg.gov.br/nfce/services/NFeRetAutorizacao4',
    nfce_consulta:       'https://nfce.fazenda.mg.gov.br/nfce/services/NFeConsultaProtocolo4',
    nfce_status:         'https://nfce.fazenda.mg.gov.br/nfce/services/NFeStatusServico4',
    nfce_cancelamento:   'https://nfce.fazenda.mg.gov.br/nfce/services/RecepcaoEvento4',
    nfe_distribuicao:    'https://www1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
  },
  hom: {
    nfce_autorizacao:    'https://hnfce.fazenda.mg.gov.br/nfce/services/NFeAutorizacao4',
    nfce_retautorizacao: 'https://hnfce.fazenda.mg.gov.br/nfce/services/NFeRetAutorizacao4',
    nfce_consulta:       'https://hnfce.fazenda.mg.gov.br/nfce/services/NFeConsultaProtocolo4',
    nfce_status:         'https://hnfce.fazenda.mg.gov.br/nfce/services/NFeStatusServico4',
    nfce_cancelamento:   'https://hnfce.fazenda.mg.gov.br/nfce/services/RecepcaoEvento4',
    nfe_distribuicao:    'https://hom1.nfe.fazenda.gov.br/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx',
  }
};

// Carrega certificado PFX de Base64
function carregarCertificado(pfxBase64, senha) {
  const pfxDer = forge.util.decode64(pfxBase64);
  const pfxAsn1 = forge.asn1.fromDer(pfxDer);
  const pfx = forge.pkcs12.pkcs12FromAsn1(pfxAsn1, senha);
  
  let cert = null, key = null;
  for (const safeContent of pfx.safeContents) {
    for (const safeBag of safeContent.safeBags) {
      if (safeBag.type === forge.pki.oids.certBag) {
        cert = safeBag.cert;
      } else if (safeBag.type === forge.pki.oids.pkcs8ShroudedKeyBag ||
                 safeBag.type === forge.pki.oids.keyBag) {
        key = safeBag.key;
      }
    }
  }
  
  if (!cert || !key) throw new Error('Certificado ou chave não encontrados no .pfx');
  
  const certPem = forge.pki.certificateToPem(cert);
  const keyPem  = forge.pki.privateKeyToPem(key);
  const validade = cert.validity.notAfter;
  const cnpj = cert.subject.getField('CN')?.value || '';
  
  return { certPem, keyPem, validade, cnpj };
}

// Assina XML com o certificado
function assinarXML(xml, certPem, keyPem) {
  // Usa xmlsec via forge para assinatura canônica
  // Implementação simplificada — usa node-forge para RSA-SHA1
  const md = forge.md.sha1.create();
  md.update(xml, 'utf8');
  const privateKey = forge.pki.privateKeyFromPem(keyPem);
  const signature = forge.util.encode64(privateKey.sign(md));
  return { xml, signature };
}

// Envia SOAP para a SEFAZ
async function enviarSOAP(url, xml, certPem, keyPem, acao) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const soapEnvelope = `<?xml version="1.0" encoding="UTF-8"?>
<soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soap12="http://www.w3.org/2003/05/soap-envelope">
  <soap12:Header>
    <nfeCabecMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeStatusServico4">
      <cUF>31</cUF>
      <versaoDados>4.00</versaoDados>
    </nfeCabecMsg>
  </soap12:Header>
  <soap12:Body>${xml}</soap12:Body>
</soap12:Envelope>`;

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/soap+xml; charset=utf-8',
        'SOAPAction': acao || '',
        'Content-Length': Buffer.byteLength(soapEnvelope),
      },
      cert: certPem,
      key: keyPem,
      rejectUnauthorized: false,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout SEFAZ')); });
    req.write(soapEnvelope);
    req.end();
  });
}

// Consulta status do serviço SEFAZ MG
async function consultarStatus(pfxBase64, senha, ambiente = 'prod') {
  const { certPem, keyPem } = carregarCertificado(pfxBase64, senha);
  const xml = `<nfeStatusServicoNF xmlns="http://www.portalfiscal.inf.br/nfe">
    <consStatServ versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
      <tpAmb>${ambiente === 'prod' ? '1' : '2'}</tpAmb>
      <cUF>31</cUF>
      <xServ>STATUS</xServ>
    </consStatServ>
  </nfeStatusServicoNF>`;
  const url = WS[ambiente].nfce_status;
  const resp = await enviarSOAP(url, xml, certPem, keyPem);
  return resp;
}

// Consulta NF-e pela chave de acesso
async function consultarNFe(chave, pfxBase64, senha, ambiente = 'prod') {
  const { certPem, keyPem } = carregarCertificado(pfxBase64, senha);
  const xml = `<nfeConsultaNF xmlns="http://www.portalfiscal.inf.br/nfe">
    <consSitNFe versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
      <tpAmb>${ambiente === 'prod' ? '1' : '2'}</tpAmb>
      <xServ>CONSULTAR</xServ>
      <chNFe>${chave}</chNFe>
    </consSitNFe>
  </nfeConsultaNF>`;
  const url = WS[ambiente].nfce_consulta;
  const resp = await enviarSOAP(url, xml, certPem, keyPem);
  return resp;
}

// Distribuição DFe — baixa NF-e emitidas CONTRA o CNPJ (entrada)
async function distribuicaoDFe(pfxBase64, senha, cnpj, ultNSU = '000000000000000', ambiente = 'prod') {
  const { certPem, keyPem } = carregarCertificado(pfxBase64, senha);
  const cnpjLimpo = cnpj.replace(/[^\d]/g, '');
  const xml = `<distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe">
    <distDFeInt versao="1.01" xmlns="http://www.portalfiscal.inf.br/nfe">
      <tpAmb>${ambiente === 'prod' ? '1' : '2'}</tpAmb>
      <cUFAutor>31</cUFAutor>
      <CNPJ>${cnpjLimpo}</CNPJ>
      <distNSU>
        <ultNSU>${ultNSU}</ultNSU>
      </distNSU>
    </distDFeInt>
  </distDFeInt>`;
  const url = WS[ambiente].nfe_distribuicao;
  const resp = await enviarSOAP(url, xml, certPem, keyPem, 'http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe/nfeDistDFeInteresse');
  return resp;
}

module.exports = { carregarCertificado, consultarStatus, consultarNFe, distribuicaoDFe };
