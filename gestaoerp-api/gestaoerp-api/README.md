# GestaoERP API — Backend SEFAZ
**Di Casa Laranjinha — CNPJ: 44.686.412/0001-00**

## Rotas disponíveis

| Método | Rota | Função |
|--------|------|--------|
| GET  | `/` | Health check |
| POST | `/api/certificado/validar` | Valida certificado .pfx |
| POST | `/api/sefaz/status` | Status SEFAZ MG |
| POST | `/api/nfe/consultar` | Consulta NF-e pela chave |
| POST | `/api/nfe/distribuicao` | Baixa NF-e de fornecedores |
| POST | `/api/nfce/emitir` | Emite NFC-e |
| POST | `/api/nfce/cancelar` | Cancela NFC-e |

## Autenticação
Header: `x-api-token: gestaoerp_diCasa_44686412`

## Antes de usar em produção
1. Preencher no `nfce.js`: IE, CEP, Logradouro, Número, Bairro
2. Informar CSC e ID Token (pegar com contador)
3. Trocar o API_TOKEN nas variáveis de ambiente do Vercel

## Deploy no Vercel
```bash
npm i -g vercel
vercel --prod
```
