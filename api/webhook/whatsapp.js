// ============================================
// GestaoERP - Webhook WhatsApp
// Di Casa Laranjinha - Evolution API v2
// ============================================

const API_TOKEN = process.env.API_TOKEN || process.env.ANTHROPIC_API_KEY;
const EVOLUTION_URL = process.env.EVOLUTION_URL || 'https://evolution-api-latest-lrlv.onrender.com';
const EVOLUTION_KEY = process.env.EVOLUTION_KEY || 'dicasalaranjinha2024';
const INSTANCE = 'dicasalaranjinha';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-token');
}

async function enviarResposta(numero, mensagem) {
  try {
    await fetch(`${EVOLUTION_URL}/message/sendText/${INSTANCE}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': EVOLUTION_KEY
      },
      body: JSON.stringify({
        number: numero,
        text: mensagem
      })
    });
  } catch (e) {
    console.error('Erro ao enviar resposta:', e);
  }
}

async function analisarRecibo(base64Image, mediaType, numero) {
  try {
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
              source: {
                type: 'base64',
                media_type: mediaType || 'image/jpeg',
                data: base64Image
              }
            },
            {
              type: 'text',
              text: `Você é o assistente financeiro do restaurante Di Casa Laranjinha em Patos de Minas, MG.
              
Analise esta imagem e identifique se é um recibo/comprovante de pagamento, nota fiscal ou cupom fiscal.

Se for um documento financeiro, extraia:
- Tipo do documento (recibo, NF, cupom, comprovante PIX, etc)
- Fornecedor/Estabelecimento
- Data
- Valor total
- Forma de pagamento (se visível)
- Itens principais (se visível)

Responda em formato simples e direto, em português, como se fosse um assistente de caixa.
Se não for um documento financeiro, diga educadamente que só processo recibos e comprovantes.`
            }
          ]
        }]
      })
    });

    const data = await response.json();
    return data.content?.[0]?.text || 'Não consegui analisar o documento.';
  } catch (e) {
    console.error('Erro Claude:', e);
    return 'Erro ao analisar o documento. Tente novamente.';
  }
}

async function baixarMidia(messageId, instance) {
  try {
    const response = await fetch(`${EVOLUTION_URL}/chat/getBase64FromMediaMessage/${instance}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': EVOLUTION_KEY
      },
      body: JSON.stringify({ message: { key: { id: messageId } } })
    });
    const data = await response.json();
    return data;
  } catch (e) {
    console.error('Erro ao baixar mídia:', e);
    return null;
  }
}

export default async function handler(req, res) {
  cors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    return res.status(200).json({ status: 'Webhook WhatsApp ativo ✅', version: '1.0' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    const body = req.body;
    console.log('Webhook recebido:', JSON.stringify(body).substring(0, 200));

    // Ignorar eventos que não são mensagens
    if (body.event !== 'messages.upsert') {
      return res.status(200).json({ ok: true, ignorado: body.event });
    }

    const msg = body.data;
    if (!msg) return res.status(200).json({ ok: true });

    // Ignorar mensagens próprias
    if (msg.key?.fromMe) return res.status(200).json({ ok: true });

    const numero = msg.key?.remoteJid;
    const tipo = msg.messageType;

    console.log(`Mensagem de ${numero} - tipo: ${tipo}`);

    // Mensagem de texto
    if (tipo === 'conversation' || tipo === 'extendedTextMessage') {
      const texto = msg.message?.conversation || 
                    msg.message?.extendedTextMessage?.text || '';
      
      const textoBaixo = texto.toLowerCase();
      
      if (textoBaixo.includes('ajuda') || textoBaixo.includes('oi') || textoBaixo.includes('olá') || textoBaixo.includes('ola')) {
        await enviarResposta(numero, 
          `👋 Olá! Sou o assistente do *Di Casa Laranjinha* 🍕🍖\n\n` +
          `📸 Me mande uma *foto de recibo ou comprovante* que eu analiso na hora!\n\n` +
          `Posso identificar:\n` +
          `• Recibos e notas fiscais\n` +
          `• Comprovantes de PIX\n` +
          `• Cupons fiscais\n` +
          `• Comprovantes de cartão`
        );
      } else {
        await enviarResposta(numero,
          `📸 Para usar o assistente financeiro, envie uma *foto do recibo ou comprovante*.\n\n` +
          `Digite *ajuda* para mais informações.`
        );
      }
      return res.status(200).json({ ok: true });
    }

    // Mensagem com imagem
    if (tipo === 'imageMessage') {
      await enviarResposta(numero, '🔍 Analisando o documento... aguarde um momento.');

      const messageId = msg.key?.id;
      const midia = await baixarMidia(messageId, INSTANCE);

      if (!midia?.base64) {
        await enviarResposta(numero, '❌ Não consegui acessar a imagem. Tente enviar novamente.');
        return res.status(200).json({ ok: true });
      }

      const analise = await analisarRecibo(midia.base64, midia.mimetype, numero);
      
      await enviarResposta(numero, 
        `📋 *Análise do Documento*\n\n${analise}\n\n` +
        `_Registrado automaticamente no GestaoERP Di Casa Laranjinha_`
      );

      return res.status(200).json({ ok: true, analisado: true });
    }

    // Outros tipos
    return res.status(200).json({ ok: true, tipo });

  } catch (error) {
    console.error('Erro no webhook:', error);
    return res.status(500).json({ error: error.message });
  }
}
