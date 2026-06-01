// ============================================
// GestaoERP - Webhook WhatsApp
// Di Casa Laranjinha - Evolution API v2
// ============================================

const API_TOKEN = process.env.ANTHROPIC_API_KEY || process.env.API_TOKEN;
const EVOLUTION_URL = 'https://evolution-api-latest-lrlv.onrender.com';
const EVOLUTION_KEY = 'dicasalaranjinha2024';
const INSTANCE = 'dicasalaranjinha';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function enviarResposta(numero, mensagem) {
  try {
    await fetch(`${EVOLUTION_URL}/message/sendText/${INSTANCE}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY },
      body: JSON.stringify({ number: numero, text: mensagem })
    });
  } catch (e) {
    console.error('Erro ao enviar:', e.message);
  }
}

async function analisarImagem(base64, mimetype) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_TOKEN,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimetype || 'image/jpeg', data: base64 }
          },
          {
            type: 'text',
            text: `Você é o assistente financeiro do Di Casa Laranjinha em Patos de Minas MG.
Analise este documento e extraia:
- Tipo (recibo, NF, PIX, cupom, etc)
- Fornecedor/Estabelecimento
- Data
- Valor total
- Forma de pagamento
- Itens principais se visível

Responda de forma clara e direta em português. Se não for documento financeiro, informe educadamente.`
          }
        ]
      }]
    })
  });
  const data = await response.json();
  return data.content?.[0]?.text || 'Não consegui analisar.';
}

module.exports = async function handler(req, res) {
  cors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({ status: 'Webhook WhatsApp ativo ✅', versao: '1.0' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ erro: 'Método não permitido' });
  }

  try {
    const body = req.body || {};
    console.log('Evento:', body.event, '| De:', body.data?.key?.remoteJid);

    // Só processa mensagens recebidas
    if (body.event !== 'messages.upsert') {
      return res.status(200).json({ ok: true, ignorado: body.event });
    }

    const msg = body.data;
    if (!msg || msg.key?.fromMe) return res.status(200).json({ ok: true });

    const numero = msg.key?.remoteJid;
    const tipo = msg.messageType;

    // Texto
    if (tipo === 'conversation' || tipo === 'extendedTextMessage') {
      const texto = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').toLowerCase();

      if (texto.includes('oi') || texto.includes('olá') || texto.includes('ola') || texto.includes('ajuda')) {
        await enviarResposta(numero,
          `👋 Olá! Sou o assistente do *Di Casa Laranjinha* 🍕🍖\n\n` +
          `📸 Me mande uma *foto de recibo ou comprovante* que analiso na hora!\n\n` +
          `Identifico: recibos, notas fiscais, PIX, cupons e comprovantes de cartão.`
        );
      } else {
        await enviarResposta(numero,
          `📸 Envie uma *foto do recibo ou comprovante* para eu analisar.\n\nDigite *oi* para mais informações.`
        );
      }
      return res.status(200).json({ ok: true });
    }

    // Imagem
    if (tipo === 'imageMessage') {
      await enviarResposta(numero, '🔍 Analisando documento... um momento.');

      // Tenta pegar base64 direto do webhook (Webhook Base64 ativado)
      const base64 = body.data?.message?.imageMessage?.jpegThumbnail ||
                     body.data?.message?.base64 ||
                     msg.message?.imageMessage?.base64;

      if (!base64) {
        await enviarResposta(numero, '❌ Não consegui acessar a imagem. Tente reenviar.');
        return res.status(200).json({ ok: true });
      }

      const analise = await analisarImagem(base64, 'image/jpeg');
      await enviarResposta(numero,
        `📋 *Análise do Documento*\n\n${analise}\n\n_Di Casa Laranjinha - GestaoERP_`
      );
      return res.status(200).json({ ok: true, analisado: true });
    }

    return res.status(200).json({ ok: true, tipo });

  } catch (err) {
    console.error('Erro webhook:', err.message);
    return res.status(500).json({ erro: err.message });
  }
};
