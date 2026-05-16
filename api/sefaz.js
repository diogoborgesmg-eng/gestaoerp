const https = require("https");
const { parseStringPromise } = require("xml2js");

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ erro: "Método não permitido" });
  }

  const { chave } = req.body;
  if (!chave || chave.replace(/\D/g, "").length !== 44) {
    return res.status(400).json({ erro: "Chave inválida — deve ter 44 dígitos" });
  }

  const chaveLimpa = chave.replace(/\D/g, "");

  // Monta envelope SOAP para consulta no WebService da SEFAZ Nacional
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <soapenv:Body>
    <nfeDadosMsg xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4">
      <consCad xmlns="http://www.portalfiscal.inf.br/nfe" versao="2.00">
        <tpAmb>1</tpAmb>
        <xServ>CONSULTAR</xServ>
        <chNFe>${chaveLimpa}</chNFe>
      </consCad>
    </nfeDadosMsg>
  </soapenv:Body>
</soapenv:Envelope>`;

  try {
    // Consulta o portal público da NF-e
    const xmlResposta = await consultarSEFAZ(chaveLimpa, envelope);
    const dados = await extrairDadosXML(xmlResposta);
    return res.status(200).json(dados);
  } catch (error) {
    // Fallback: tenta consulta via portal público
    try {
      const dadosPortal = await consultarPortalPublico(chaveLimpa);
      return res.status(200).json(dadosPortal);
    } catch (e2) {
      return res.status(500).json({
        erro: `Não foi possível consultar a SEFAZ: ${error.message}. Tente digitar os dados manualmente.`
      });
    }
  }
}

// Consulta o WebService SEFAZ Nacional (ambiente de produção)
function consultarSEFAZ(chave, envelope) {
  return new Promise((resolve, reject) => {
    // UF do emitente está nos dígitos 0-1 da chave
    const codUF = chave.substring(0, 2);
    const url = obterURLSEFAZ(codUF);

    const options = {
      hostname: url.hostname,
      path: url.path,
      method: "POST",
      headers: {
        "Content-Type": "text/xml;charset=UTF-8",
        "SOAPAction": "http://www.portalfiscal.inf.br/nfe/wsdl/NFeConsultaProtocolo4/nfeConsultaNF",
        "Content-Length": Buffer.byteLength(envelope)
      }
    };

    const req = https.request(options, (resp) => {
      let data = "";
      resp.on("data", chunk => data += chunk);
      resp.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("Timeout SEFAZ")); });
    req.write(envelope);
    req.end();
  });
}

// URLs dos WebServices SEFAZ por UF
function obterURLSEFAZ(codUF) {
  const urls = {
    "31": { hostname: "nfe.fazenda.mg.gov.br", path: "/nfe2/services/NFeConsultaProtocolo4" }, // MG
    "35": { hostname: "homologacao.nfe.fazenda.sp.gov.br", path: "/nfeWEB/services/NFeConsultaProtocolo4" }, // SP
    "41": { hostname: "nfe.sefa.pr.gov.br", path: "/nfe/NFeConsultaProtocolo4" }, // PR
    "43": { hostname: "nfe.sefaz.rs.gov.br", path: "/ws/NfeConsulta/NfeConsulta4.asmx" }, // RS
  };
  // Default: SEFAZ Nacional (SVAN) para demais UFs
  return urls[codUF] || { hostname: "nfe.fazenda.gov.br", path: "/NFeConsultaProtocolo4/NFeConsultaProtocolo4.asmx" };
}

// Extrai dados relevantes do XML retornado pela SEFAZ
async function extrairDadosXML(xml) {
  try {
    const parsed = await parseStringPromise(xml, { explicitArray: false });

    // Navega pela estrutura do XML da NF-e
    const body = parsed?.["soapenv:Envelope"]?.["soapenv:Body"] ||
                 parsed?.["soap:Envelope"]?.["soap:Body"] || {};
    const retorno = body?.retConsSitNFe || body?.["nfeConsultaNFResult"] || {};
    const procNFe = retorno?.procNFe || retorno?.nfeProc || {};
    const nfe = procNFe?.NFe || procNFe?.nfe || {};
    const infNFe = nfe?.infNFe || {};

    const emit = infNFe?.emit || {};
    const dest = infNFe?.dest || {};
    const ide = infNFe?.ide || {};
    const total = infNFe?.total?.ICMSTot || {};
    const cobr = infNFe?.cobr?.dup || null;

    // Extrai itens
    const dets = infNFe?.det || [];
    const itensArr = Array.isArray(dets) ? dets : [dets];
    const itens = itensArr.filter(Boolean).map(det => {
      const prod = det?.prod || {};
      const upc = extrairUPC(prod?.xProd || "");
      return {
        descricao: prod?.xProd || "",
        quantidade: parseFloat(prod?.qCom || 0),
        unidade: prod?.uCom || "un",
        unidades_por_cx: upc,
        valor_unitario: parseFloat(prod?.vUnCom || 0),
        valor_total: parseFloat(prod?.vProd || 0)
      };
    });

    // Vencimento da fatura
    let vencimento = "";
    if (cobr) {
      const dups = Array.isArray(cobr) ? cobr : [cobr];
      if (dups.length > 0) vencimento = formatarData(dups[0]?.dVenc || "");
    }

    return {
      fornecedor: emit?.xNome || emit?.xFant || "",
      cnpj: formatarCNPJ(emit?.CNPJ || ""),
      destinatario: dest?.xNome || "",
      numero: ide?.nNF || "",
      serie: ide?.serie || "",
      data: formatarData(ide?.dhEmi || ide?.dEmi || ""),
      vencimento,
      valor_total: parseFloat(total?.vNF || total?.vProd || 0),
      valor_produtos: parseFloat(total?.vProd || 0),
      itens,
      fonte: "sefaz_xml"
    };
  } catch (e) {
    throw new Error("Erro ao interpretar XML SEFAZ: " + e.message);
  }
}

// Consulta alternativa via portal público
async function consultarPortalPublico(chave) {
  return new Promise((resolve, reject) => {
    const url = `https://www.nfe.fazenda.gov.br/portal/consultaRecaptcha.aspx?tipoConsulta=completa&tipoConteudo=XmlAsDia==&nfe=${chave}`;
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (resp) => {
      let data = "";
      resp.on("data", chunk => data += chunk);
      resp.on("end", () => {
        if (data.includes("chaveAcesso") || data.includes("NFe")) {
          resolve({ fonte: "portal_publico", raw: data.slice(0, 500) });
        } else {
          reject(new Error("NF não encontrada no portal público"));
        }
      });
    }).on("error", reject);
  });
}

// Extrai unidades por caixa do formato NxM (ex: 12X1 → 12)
function extrairUPC(descricao) {
  const match = descricao.match(/(\d+)[xX]1\b/);
  return match ? parseInt(match[1]) : 1;
}

// Formata data ISO para DD/MM/AAAA
function formatarData(data) {
  if (!data) return "";
  const d = new Date(data);
  if (isNaN(d)) return data.slice(0, 10).split("-").reverse().join("/");
  return d.toLocaleDateString("pt-BR");
}

// Formata CNPJ
function formatarCNPJ(cnpj) {
  const c = cnpj.replace(/\D/g, "");
  if (c.length !== 14) return cnpj;
  return c.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
}
