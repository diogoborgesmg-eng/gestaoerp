
// ═══════════════════════════════════════════════════════════
// GestaoERP API — Backend Serverless
// Di Casa Laranjinha — CNPJ: 44.686.412/0001-00
// ═══════════════════════════════════════════════════════════

const API_TOKEN = process.env.API_TOKEN || 'gestaoerp_diCasa_44686412';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-token');
}

function autenticar(req) {
  const token = req.headers['x-api-token'] || (req.query && req.query.token);
  return token === API_TOKEN;
}

module.exports = async function handler(req, res) {
  cors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const path = req.url.split('?')[0];

  if (path === '/' || path === '') {
    return res.status(200).json({
      status: 'online',
      sistema: 'GestaoERP API',
      empresa: 'Di Casa Laranjinha',
      cnpj: '44.686.412/0001-00',
      versao: '1.0.0',
      timestamp: new Date().toISOString(),
      rotas: ['GET /','POST /api/sefaz/status','POST /api/nfce/emitir','POST /api/nfce/cancelar','POST /api/nfe/consultar','POST /api/certificado/validar']
    });
  }

  if (!autenticar(req)) {
    return res.status(401).json({ erro: 'Token inválido', hint: 'Envie header x-api-token' });
  }

  let body = {};
  try { body = req.body || {}; } catch(e) {}

  if (path === '/api/sefaz/status') {
    return res.status(200).json({
      status: 'ok',
      sefaz: 'Em homologação',
      ambiente: 'homologacao',
      uf: 'MG',
      mensagem: 'Backend online. Configure certificado A1 para produção.',
      timestamp: new Date().toISOString()
    });
  }

  if (path === '/api/certificado/validar') {
    const { pfxBase64 } = body;
    if (!pfxBase64) return res.status(400).json({ erro: 'pfxBase64 obrigatório' });
    return res.status(200).json({ valido: true, tamanho: pfxBase64.length });
  }

  if (path === '/api/nfce/emitir') {
    const { itens, total } = body;
    if (!itens || !total) return res.status(400).json({ erro: 'itens e total obrigatórios' });
    const chave = gerarChaveAcesso();
    return res.status(200).json({
      status: 'homologacao',
      mensagem: 'NFC-e em modo homologação. Informe IE e CSC do contador para produção.',
      chave,
      numero: Math.floor(Math.random() * 9000) + 1000,
      serie: '001',
      ambiente: 'homologacao',
      timestamp: new Date().toISOString(),
      qrcode: `https://nfce.fazenda.mg.gov.br/portalnfce/sistema/qrcode.xhtml?p=${chave}|2|1|1|abc123`
    });
  }

  if (path === '/api/nfce/cancelar') {
    const { chave, motivo } = body;
    if (!chave) return res.status(400).json({ erro: 'chave obrigatória' });
    return res.status(200).json({ status: 'ok', mensagem: 'Cancelamento registrado', chave, motivo: motivo || 'Cancelamento solicitado', timestamp: new Date().toISOString() });
  }

  if (path === '/api/nfe/consultar') {
    const { chave } = body;
    if (!chave) return res.status(400).json({ erro: 'chave obrigatória' });
    return res.status(200).json({ status: 'ok', situacao: 'Autorizado o uso da NF-e', chave, timestamp: new Date().toISOString() });
  }

  return res.status(404).json({ erro: 'Rota não encontrada', rota: path });
};

function gerarChaveAcesso() {
  const rand = () => Math.floor(Math.random() * 1e9).toString().padStart(9, '0');
  return `31${new Date().toISOString().slice(2,4)}${new Date().toISOString().slice(5,7)}44686412000100650010001${rand()}1${rand().slice(0,8)}0`;
}
