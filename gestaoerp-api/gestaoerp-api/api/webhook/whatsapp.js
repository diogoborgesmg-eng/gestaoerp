// ============================================
// GestaoERP - Webhook WhatsApp
// Di Casa Laranjinha - Evolution API v2
// Suporte a mensagens diretas e grupos
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
- Tipo (recibo, NF, PIX, cupom, cartão, etc)
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
  if (req.method === 'GET') return res.status(200).json({ status: 'Webhook WhatsApp ativo ✅', versao: '2.0' });
  if (req.method !== 'POST') return res.status(405).json({ erro: 'Método não permitido' });

  try {
    const body = req.body || {};

    if (body.event !== 'messages.upsert') {
      return res.status(200).json({ ok: true, ignorado: body.event });
    }

    const msg = body.data;
    if (!msg || msg.key?.fromMe) return res.status(200).json({ ok: true });

    const remoteJid = msg.key?.remoteJid || '';
    const isGrupo = remoteJid.endsWith('@g.us');
    const tipo = msg.messageType;

    console.log(`Msg de ${isGrupo ? 'GRUPO' : 'DIRETO'} | tipo: ${tipo} | jid: ${remoteJid}`);

    // Texto
    if (tipo === 'conversation' || tipo === 'extendedTextMessage') {
      const texto = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').toLowerCase();

      // Em grupo só responde se mencionar ajuda ou bot
      if (isGrupo && !texto.includes('ajuda') && !texto.includes('bot')) {
        return res.status(200).json({ ok: true });
      }

      await enviarResposta(remoteJid,
        `👋 Olá! Sou o assistente financeiro do *Di Casa Laranjinha* 🍕🍖\n\n` +
        `📸 Me mande uma *foto de recibo ou comprovante* que analiso na hora!\n\n` +
        `Identifico: recibos, notas fiscais, PIX, cupons e cartões.`
      );
      return res.status(200).json({ ok: true });
    }

    // Imagem — processa sempre (direto ou grupo)
    if (tipo === 'imageMessage') {
      await enviarResposta(remoteJid, '🔍 Analisando documento... um momento.');

      const base64 = msg.message?.imageMessage?.base64 ||
                     msg.message?.base64 ||
                     body.data?.message?.base64;

      if (!base64) {
        await enviarResposta(remoteJid, '❌ Não consegui acessar a imagem. Tente reenviar.');
        return res.status(200).json({ ok: true });
      }

      const analise = await analisarImagem(base64, 'image/jpeg');
      await enviarResposta(remoteJid,
        `📋 *Análise do Documento*\n\n${analise}\n\n_Di Casa Laranjinha - GestaoERP_ ✅`
      );
      return res.status(200).json({ ok: true, analisado: true });
    }

    return res.status(200).json({ ok: true, tipo });

  } catch (err) {
    console.error('Erro webhook:', err.message);
    return res.status(500).json({ erro: err.message });
  }
};
