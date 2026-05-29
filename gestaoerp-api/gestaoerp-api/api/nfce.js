// ═══════════════════════════════════════════════════════════
// NFC-e — Emissão de Nota Fiscal do Consumidor
// CNPJ: 44.686.412/0001-00 — Di Casa Laranjinha
// SEFAZ MG — cUF: 31
// ═══════════════════════════════════════════════════════════

const forge = require('node-forge');
const crypto = require('crypto');
const https = require('https');

const CNPJ_EMITENTE  = '44686412000100';
const RAZAO_SOCIAL   = 'DI CASA LARANJINHA RESTAURANTE E PIZZARIA';
const IE_EMITENTE    = ''; // preencher com IE da empresa
const MUNICIPIO_COD  = '3148004'; // Patos de Minas MG
const MUNICIPIO_NOME = 'Patos de Minas';
const UF             = 'MG';
const CEP            = '38700000'; // preencher
const LOGRADOURO     = '';         // preencher
const NUMERO         = '';
const BAIRRO         = '';

const WS_NFCE_PROD = 'https://nfce.fazenda.mg.gov.br/nfce/services/NFeAutorizacao4';
const WS_NFCE_HOM  = 'https://hnfce.fazenda.mg.gov.br/nfce/services/NFeAutorizacao4';

// Gera chave de acesso NFC-e (44 dígitos)
function gerarChaveAcesso(aamm, cnpj, mod, serie, nNF, tpEmis, cNF) {
  const cUF = '31'; // MG
  const chave = `${cUF}${aamm}${cnpj}${mod}${serie.padStart(3,'0')}${nNF.padStart(9,'0')}${tpEmis}${cNF.padStart(8,'0')}`;
  // Calcula dígito verificador (módulo 11)
  let soma = 0, mult = 2;
  for (let i = chave.length - 1; i >= 0; i--) {
    soma += parseInt(chave[i]) * mult;
    mult = mult === 9 ? 2 : mult + 1;
  }
  const resto = soma % 11;
  const cDV = resto < 2 ? 0 : 11 - resto;
  return chave + cDV;
}

// Monta XML da NFC-e
function montarXMLNFCe(dados) {
  const { itens, pagamentos, total, nNF, serie, cNF, dhEmis, certPem, cpfCliente, csc, cscId, ambiente } = dados;
  const tpAmb = ambiente === 'prod' ? '1' : '2';
  const aamm  = dhEmis.substring(2, 6); // AAMM
  const chave = gerarChaveAcesso(aamm, CNPJ_EMITENTE, '65', serie, nNF, '1', cNF);

  const vTotNF  = total.toFixed(2);
  const vProd   = itens.reduce((a, i) => a + i.vProd, 0).toFixed(2);
  const vICMS   = '0.00';
  const vPIS    = '0.00';
  const vCOFINS = '0.00';

  // Monta detalhamento dos itens
  const detXML = itens.map((item, idx) => `
    <det nItem="${idx + 1}">
      <prod>
        <cProd>${String(idx + 1).padStart(4, '0')}</cProd>
        <cEAN>SEM GTIN</cEAN>
        <xProd>${item.xProd.substring(0, 120)}</xProd>
        <NCM>21069090</NCM>
        <CFOP>5102</CFOP>
        <uCom>UN</uCom>
        <qCom>${item.qCom.toFixed(4)}</qCom>
        <vUnCom>${item.vUnCom.toFixed(4)}</vUnCom>
        <vProd>${item.vProd.toFixed(2)}</vProd>
        <cEANTrib>SEM GTIN</cEANTrib>
        <uTrib>UN</uTrib>
        <qTrib>${item.qCom.toFixed(4)}</qTrib>
        <vUnTrib>${item.vUnCom.toFixed(4)}</vUnTrib>
        <indTot>1</indTot>
      </prod>
      <imposto>
        <ICMS>
          <ICMSSN102>
            <orig>0</orig>
            <CSOSN>102</CSOSN>
          </ICMSSN102>
        </ICMS>
        <PIS><PISOutr><CST>07</CST><vBC>0.00</vBC><pPIS>0.00</pPIS><vPIS>0.00</vPIS></PISOutr></PIS>
        <COFINS><COFINSOutr><CST>07</CST><vBC>0.00</vBC><pCOFINS>0.00</pCOFINS><vCOFINS>0.00</vCOFINS></COFINSOutr></COFINS>
      </imposto>
    </det>`).join('');

  // Monta pagamentos
  const pagXML = pagamentos.map(p => `
    <detPag>
      <tPag>${p.tPag}</tPag>
      <vPag>${p.vPag.toFixed(2)}</vPag>
      ${p.tPag === '03' || p.tPag === '04' ? `<card><tpIntegra>2</tpIntegra></card>` : ''}
    </detPag>`).join('');

  const cpfXML = cpfCliente ? `<dest><CPF>${cpfCliente.replace(/[^\d]/g,'')}</CPF></dest>` : '';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe">
<NFe xmlns="http://www.portalfiscal.inf.br/nfe">
<infNFe versao="4.00" Id="NFe${chave}">
  <ide>
    <cUF>31</cUF>
    <cNF>${cNF.padStart(8,'0')}</cNF>
    <natOp>VENDA</natOp>
    <mod>65</mod>
    <serie>${serie.padStart(3,'0')}</serie>
    <nNF>${nNF.padStart(9,'0')}</nNF>
    <dhEmi>${dhEmis}</dhEmi>
    <tpNF>1</tpNF>
    <idDest>1</idDest>
    <cMunFG>${MUNICIPIO_COD}</cMunFG>
    <tpImp>4</tpImp>
    <tpEmis>1</tpEmis>
    <cDV>${chave.slice(-1)}</cDV>
    <tpAmb>${tpAmb}</tpAmb>
    <finNFe>1</finNFe>
    <indFinal>1</indFinal>
    <indPres>1</indPres>
    <procEmi>0</procEmi>
    <verProc>GestaoERP-1.0</verProc>
  </ide>
  <emit>
    <CNPJ>${CNPJ_EMITENTE}</CNPJ>
    <xNome>${RAZAO_SOCIAL}</xNome>
    <enderEmit>
      <xLgr>${LOGRADOURO}</xLgr>
      <nro>${NUMERO}</nro>
      <xBairro>${BAIRRO}</xBairro>
      <cMun>${MUNICIPIO_COD}</cMun>
      <xMun>${MUNICIPIO_NOME}</xMun>
      <UF>${UF}</UF>
      <CEP>${CEP}</CEP>
      <cPais>1058</cPais>
      <xPais>Brasil</xPais>
    </enderEmit>
    <IE>${IE_EMITENTE}</IE>
    <CRT>1</CRT>
  </emit>
  ${cpfXML}
  ${detXML}
  <total>
    <ICMSTot>
      <vBC>0.00</vBC><vICMS>${vICMS}</vICMS><vICMSDeson>0.00</vICMSDeson>
      <vFCP>0.00</vFCP><vBCST>0.00</vBCST><vST>0.00</vST><vFCPST>0.00</vFCPST>
      <vFCPSTRet>0.00</vFCPSTRet><vProd>${vProd}</vProd><vFrete>0.00</vFrete>
      <vSeg>0.00</vSeg><vDesc>0.00</vDesc><vII>0.00</vII><vIPI>0.00</vIPI>
      <vIPIDevol>0.00</vIPIDevol><vPIS>${vPIS}</vPIS><vCOFINS>${vCOFINS}</vCOFINS>
      <vOutro>0.00</vOutro><vNF>${vTotNF}</vNF>
    </ICMSTot>
  </total>
  <transp><modFrete>9</modFrete></transp>
  <pag>${pagXML}<vTroco>0.00</vTroco></pag>
  <infAdic>
    <infCpl>Di Casa Laranjinha - ${MUNICIPIO_NOME}/${UF}</infCpl>
  </infAdic>
  <infNFeSupl>
    <qrCode>${gerarQRCode(chave, tpAmb, dhEmis, vTotNF, csc, cscId)}</qrCode>
    <urlChave>https://nfce.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml?p=${chave}|2|${tpAmb}|1|</urlChave>
  </infNFeSupl>
</infNFe>
</NFe>
</nfeProc>`;

  return { xml, chave };
}

// Gera QR Code NFC-e MG
function gerarQRCode(chave, tpAmb, dhEmi, vNF, csc, cscId) {
  const dhEmiFormatted = dhEmi.replace('T', '').replace(/[-:]/g, '').substring(0, 12);
  const digVal = crypto.createHash('sha1').update(chave).digest('hex').substring(0, 8);
  const params = `${chave}|2|${tpAmb}|1|${dhEmiFormatted}|${parseFloat(vNF).toFixed(2)}|${digVal}|${cscId}`;
  const hash = crypto.createHash('sha1').update(params + csc).digest('hex');
  return `https://nfce.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml?p=${params}|${hash}`;
}

module.exports = { montarXMLNFCe, gerarChaveAcesso, gerarQRCode };
