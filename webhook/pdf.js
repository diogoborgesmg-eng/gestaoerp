const PDFDocument = require('pdfkit');

// Remove emojis/simbolos que a fonte padrao do PDF nao renderiza, mantendo acentos
function limparEmoji(txt) {
  return String(txt||'').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '').trim();
}

function gerarPdfFechamento({ diaBR, receita, custo, resultado, segTotais, catTotais, contasPagar, evolucaoMes }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const corVerde = '#0a9d56', corVermelho = '#d3293a', corCinza = '#888', corLinha = '#e5e5e5';
    const larguraPagina = doc.page.width - 72;

    // Cabecalho
    doc.fontSize(16).fillColor('#111').font('Helvetica-Bold').text('DI CASA LARANJINHA', { align: 'center' });
    doc.fontSize(11).fillColor(corCinza).font('Helvetica').text('Relatorio Diario — ' + diaBR, { align: 'center' });
    doc.moveDown(1);

    // Resumo (3 colunas)
    const yResumo = doc.y;
    const colW = larguraPagina / 3;
    const resumoItens = [
      { label: 'RECEITA', valor: receita, cor: corVerde },
      { label: 'CUSTO', valor: custo, cor: corVermelho },
      { label: 'RESULTADO', valor: resultado, cor: resultado >= 0 ? corVerde : corVermelho }
    ];
    resumoItens.forEach((item, i) => {
      const x = 36 + colW * i;
      doc.fontSize(8).fillColor(corCinza).font('Helvetica').text(item.label, x, yResumo, { width: colW, align: 'center' });
      doc.fontSize(14).fillColor(item.cor).font('Helvetica-Bold').text('R$ ' + item.valor.toFixed(2), x, yResumo + 12, { width: colW, align: 'center' });
    });
    doc.y = yResumo + 40;
    doc.moveDown(1.5);

    // Funcao auxiliar pra desenhar tabela em colunas
    function desenharTabela(titulo, colunas, linhas) {
      doc.fontSize(11).fillColor('#111').font('Helvetica-Bold').text(titulo);
      doc.moveDown(0.3);
      const larguras = colunas.map(c => c.w);
      let x = 36;
      const yHead = doc.y;
      colunas.forEach((c, i) => {
        doc.fontSize(8).fillColor(corCinza).font('Helvetica-Bold').text(c.nome.toUpperCase(), x, yHead, { width: larguras[i], align: c.align || 'left' });
        x += larguras[i];
      });
      doc.moveDown(0.4);
      doc.moveTo(36, doc.y).lineTo(36 + larguraPagina, doc.y).strokeColor(corLinha).stroke();
      doc.moveDown(0.2);

      if (!linhas.length) {
        doc.fontSize(9).fillColor(corCinza).font('Helvetica').text('Nenhum dado.', { italics: true });
      } else {
        linhas.forEach(linha => {
          const yLinha = doc.y;
          x = 36;
          colunas.forEach((c, i) => {
            doc.fontSize(9).fillColor('#222').font('Helvetica').text(String(linha[i]), x, yLinha, { width: larguras[i], align: c.align || 'left' });
            x += larguras[i];
          });
          doc.moveDown(0.35);
        });
      }
      doc.moveDown(0.8);
    }

    // Vendas por Segmento
    const segLinhas = Object.values(segTotais || {}).sort((a, b) => b.valor - a.valor).map(s => [
      limparEmoji(s.icone) + ' ' + s.nome, 'R$ ' + s.valor.toFixed(2), (receita > 0 ? (s.valor / receita * 100).toFixed(1) : '0') + '%'
    ]);
    desenharTabela('Vendas por Segmento', [
      { nome: 'Segmento', w: larguraPagina * 0.5 },
      { nome: 'Valor', w: larguraPagina * 0.3, align: 'right' },
      { nome: '%', w: larguraPagina * 0.2, align: 'right' }
    ], segLinhas);

    // Custos por Categoria
    const catLinhas = Object.entries(catTotais || {}).sort((a, b) => b[1] - a[1]).map(([cat, v]) => [limparEmoji(cat), 'R$ ' + v.toFixed(2)]);
    desenharTabela('Custos por Categoria', [
      { nome: 'Categoria', w: larguraPagina * 0.65 },
      { nome: 'Valor', w: larguraPagina * 0.35, align: 'right' }
    ], catLinhas);

    // Contas a Pagar
    const cpLinhas = (contasPagar || []).map(c => [c.fornecedor, c.vencimento, 'R$ ' + Number(c.valor).toFixed(2)]);
    desenharTabela('Contas a Pagar (vencidas + hoje)', [
      { nome: 'Fornecedor', w: larguraPagina * 0.5 },
      { nome: 'Vencimento', w: larguraPagina * 0.25, align: 'center' },
      { nome: 'Valor', w: larguraPagina * 0.25, align: 'right' }
    ], cpLinhas);

    // Evolucao do mes
    if (doc.y > doc.page.height - 200) doc.addPage();
    const evLinhas = (evolucaoMes || []).map(d => [
      String(d.dia).padStart(2, '0'), 'R$ ' + d.receita.toFixed(2), 'R$ ' + d.custo.toFixed(2),
      (d.resultado >= 0 ? '+' : '') + 'R$ ' + d.resultado.toFixed(2)
    ]);
    desenharTabela('Evolucao Diaria do Mes', [
      { nome: 'Dia', w: larguraPagina * 0.15, align: 'center' },
      { nome: 'Receita', w: larguraPagina * 0.28, align: 'right' },
      { nome: 'Custo', w: larguraPagina * 0.28, align: 'right' },
      { nome: 'Resultado', w: larguraPagina * 0.29, align: 'right' }
    ], evLinhas);

    doc.end();
  });
}

module.exports = { gerarPdfFechamento };
