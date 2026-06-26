const PDFDocument = require('pdfkit');

function brlFmt(v) {
  const n = Number(v||0);
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Remove emojis/simbolos que a fonte padrao do PDF nao renderiza, mantendo acentos
function limparEmoji(txt) {
  return String(txt||'').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, '').trim();
}

function gerarPdfFechamento({ diaBR, receita, custo, resultado, segTotais, catTotais, contasPagar, evolucaoMes, cmvPct, rhPct, metaCmv, metaRh, melhorDia, piorDia, diaMaiorCusto, mediaResultadoMes, canaisVenda }) {
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
      doc.fontSize(14).fillColor(item.cor).font('Helvetica-Bold').text('R$ ' + brlFmt(item.valor), x, yResumo + 12, { width: colW, align: 'center' });
    });
    doc.y = yResumo + 40;
    doc.moveDown(1);

    // ═══ KPIs (CMV / RH) com meta ═══
    if (cmvPct !== undefined) {
      const yKpi = doc.y;
      const kpis = [
        { label: 'CMV (Materia Prima)', val: cmvPct, meta: metaCmv||35 },
        { label: 'RH (Mao de Obra)', val: rhPct, meta: metaRh||30 }
      ];
      const kpiW = larguraPagina / 2;
      kpis.forEach((k, i) => {
        const x = 36 + kpiW * i;
        const dentroMeta = k.val <= k.meta;
        const cor = dentroMeta ? corVerde : corVermelho;
        doc.fontSize(8).fillColor(corCinza).font('Helvetica').text(k.label.toUpperCase() + ' (meta <=' + k.meta + '%)', x, yKpi, { width: kpiW - 10 });
        doc.fontSize(13).fillColor(cor).font('Helvetica-Bold').text(k.val.toFixed(1) + '%', x, yKpi + 11, { width: kpiW - 10 });
      });
      doc.y = yKpi + 32;
      doc.moveDown(1);
    }

    // ═══ Melhor dia / Pior dia do mes ═══
    if (melhorDia || piorDia) {
      const yMP = doc.y;
      const colMP = larguraPagina / 2;
      if (melhorDia) {
        doc.fontSize(8).fillColor(corCinza).font('Helvetica').text('MELHOR DIA EM VENDAS', 36, yMP, { width: colMP - 10 });
        doc.fontSize(12).fillColor(corVerde).font('Helvetica-Bold').text('Dia ' + String(melhorDia.dia).padStart(2,'0') + ' — R$ ' + brlFmt(melhorDia.receita), 36, yMP + 11, { width: colMP - 10 });
      }
      if (piorDia) {
        doc.fontSize(8).fillColor(corCinza).font('Helvetica').text('PIOR DIA EM VENDAS', 36 + colMP, yMP, { width: colMP - 10 });
        doc.fontSize(12).fillColor(corVermelho).font('Helvetica-Bold').text('Dia ' + String(piorDia.dia).padStart(2,'0') + ' — R$ ' + brlFmt(piorDia.receita), 36 + colMP, yMP + 11, { width: colMP - 10 });
      }
      doc.y = yMP + 32;
      if (diaMaiorCusto) {
        doc.fontSize(8).fillColor(corCinza).font('Helvetica').text('DIA DE MAIOR CUSTO', 36, doc.y, { width: colMP - 10 });
        doc.fontSize(12).fillColor(corVermelho).font('Helvetica-Bold').text('Dia ' + String(diaMaiorCusto.dia).padStart(2,'0') + ' — R$ ' + brlFmt(diaMaiorCusto.custo), 36, doc.y + 11, { width: colMP - 10 });
        doc.y = doc.y + 32;
      }
      if (mediaResultadoMes !== undefined) {
        doc.fontSize(8).fillColor(corCinza).font('Helvetica').text('Media diaria do mes: R$ ' + brlFmt(mediaResultadoMes) + ' | Hoje vs media: ' + (resultado >= mediaResultadoMes ? '+' : '') + 'R$ ' + brlFmt(resultado - mediaResultadoMes));
      }
      doc.moveDown(1);
    }

    // Funcao auxiliar pra desenhar tabela em colunas
    function desenharTabela(titulo, colunas, linhas, corPorCelula) {
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
        linhas.forEach((linha, li) => {
          // Se a linha nao cabe mais na pagina, quebra ANTES de desenhar (evita corromper o layout)
          if (doc.y > doc.page.height - 60) {
            doc.addPage();
            // Reimprime o cabecalho da tabela na pagina nova
            let xH = 36; const yH = doc.y;
            colunas.forEach((c, i) => {
              doc.fontSize(8).fillColor(corCinza).font('Helvetica-Bold').text(c.nome.toUpperCase(), xH, yH, { width: larguras[i], align: c.align || 'left' });
              xH += larguras[i];
            });
            doc.moveDown(0.4);
            doc.moveTo(36, doc.y).lineTo(36 + larguraPagina, doc.y).strokeColor(corLinha).stroke();
            doc.moveDown(0.2);
          }
          const yLinha = doc.y;
          x = 36;
          colunas.forEach((c, i) => {
            const cor = (corPorCelula && corPorCelula(linha, li, i)) || '#222';
            doc.fontSize(9).fillColor(cor).font('Helvetica').text(String(linha[i]), x, yLinha, { width: larguras[i], align: c.align || 'left' });
            x += larguras[i];
          });
          doc.moveDown(0.35);
        });
      }
      doc.moveDown(0.8);
    }

    // Vendas por Segmento
    const segLinhas = Object.values(segTotais || {}).sort((a, b) => b.valor - a.valor).map(s => [
      limparEmoji(s.icone) + ' ' + s.nome, 'R$ ' + brlFmt(s.valor), (receita > 0 ? (s.valor / receita * 100).toFixed(1) : '0') + '%'
    ]);
    desenharTabela('Vendas por Segmento', [
      { nome: 'Segmento', w: larguraPagina * 0.5 },
      { nome: 'Valor', w: larguraPagina * 0.3, align: 'right' },
      { nome: '%', w: larguraPagina * 0.2, align: 'right' }
    ], segLinhas);

    // Canais de Venda (STi3/iFood) - comparacao por loja
    if (canaisVenda && canaisVenda.length) {
      doc.fontSize(11).fillColor('#111').font('Helvetica-Bold').text('Canais de Venda');
      doc.moveDown(0.3);
      canaisVenda.forEach(ch => {
        const nomeExibir = ch.loja ? `${ch.nome} - ${ch.loja}` : ch.nome;
        doc.fontSize(9).fillColor('#333').font('Helvetica-Bold').text(nomeExibir);
        let linha = `  Vendas: ${brlFmt(ch.vendas)}`;
        if (ch.qtd > 0) linha += `  |  Pedidos: ${ch.qtd}  |  Ticket Medio: ${brlFmt(ch.ticketMedio)}`;
        if (ch.investimentoIfood > 0) linha += `  |  Investimento iFood: ${brlFmt(ch.investimentoIfood)}`;
        doc.fontSize(9).fillColor(corCinza).font('Helvetica').text(linha);
        doc.moveDown(0.2);
      });
      doc.moveDown(0.5);
    }

    // Custos por Categoria
    const catLinhas = Object.entries(catTotais || {}).sort((a, b) => b[1] - a[1]).map(([cat, v]) => [limparEmoji(cat), 'R$ ' + brlFmt(v)]);
    desenharTabela('Custos por Categoria', [
      { nome: 'Categoria', w: larguraPagina * 0.65 },
      { nome: 'Valor', w: larguraPagina * 0.35, align: 'right' }
    ], catLinhas);

    // Contas a Pagar
    const cpLinhas = (contasPagar || []).map(c => [c.fornecedor, c.vencimento, 'R$ ' + brlFmt(Number(c.valor))]);
    desenharTabela('Contas a Pagar (vencidas + hoje)', [
      { nome: 'Fornecedor', w: larguraPagina * 0.5 },
      { nome: 'Vencimento', w: larguraPagina * 0.25, align: 'center' },
      { nome: 'Valor', w: larguraPagina * 0.25, align: 'right' }
    ], cpLinhas);

    // Evolucao do mes (deixa o PDFKit decidir a quebra de pagina naturalmente)
    if (doc.y > doc.page.height - 100) doc.addPage();
    const evLinhas = (evolucaoMes || []).map(d => [
      String(d.dia).padStart(2, '0'), 'R$ ' + brlFmt(d.receita), 'R$ ' + brlFmt(d.custo),
      (d.resultado >= 0 ? '+' : '') + 'R$ ' + brlFmt(d.resultado)
    ]);
    desenharTabela('Evolucao Diaria do Mes', [
      { nome: 'Dia', w: larguraPagina * 0.15, align: 'center' },
      { nome: 'Receita', w: larguraPagina * 0.28, align: 'right' },
      { nome: 'Custo', w: larguraPagina * 0.28, align: 'right' },
      { nome: 'Resultado', w: larguraPagina * 0.29, align: 'right' }
    ], evLinhas, (linha, li, coluna) => {
      if (coluna === 3) return (evolucaoMes[li].resultado >= 0) ? corVerde : corVermelho;
      return null;
    });

    // ═══ Grafico aranha: comparativo entre segmentos (Receita / Ticket Medio / Qtd Pedidos) ═══
    const segsComVenda = Object.values(segTotais||{}).filter(s=>s.valor>0);
    if (segsComVenda.length >= 2) {
      if (doc.y > doc.page.height - 260 - (segsComVenda.length*13)) doc.addPage();
      doc.fontSize(11).fillColor('#111').font('Helvetica-Bold').text('Comparativo entre Segmentos');
      doc.moveDown(0.5);

      const eixosNomes = ['Receita','Ticket Medio','Qtd Pedidos'];
      const temPedidos = segsComVenda.some(s=>(s.qtdPedidos||0)>0);
      const segDados = segsComVenda.map(sg=>{
        const qtd = sg.qtdPedidos||0;
        return { ...sg, ticket: qtd>0 ? sg.valor/qtd : 0, qtd };
      });
      const maxReceita = Math.max(...segDados.map(s=>s.valor),1);
      const maxTicket = Math.max(...segDados.map(s=>s.ticket),1);
      const maxQtd = Math.max(...segDados.map(s=>s.qtd),1);

      const cx = 36 + larguraPagina/2, cyTop = doc.y, raio = 78;
      const cy = cyTop + raio + 12;
      const numEixos = eixosNomes.length;
      const angulo = i => (Math.PI*2*i/numEixos) - Math.PI/2;
      const ponto = (i, frac) => [cx + Math.cos(angulo(i))*raio*frac, cy + Math.sin(angulo(i))*raio*frac];

      // Grades de fundo (poligonos concentricos)
      [0.25,0.5,0.75,1].forEach(frac=>{
        doc.save();
        eixosNomes.forEach((_,i)=>{
          const [x,y] = ponto(i,frac);
          if (i===0) doc.moveTo(x,y); else doc.lineTo(x,y);
        });
        doc.closePath().strokeColor(corLinha).lineWidth(0.5).stroke();
        doc.restore();
      });
      // Eixos + labels
      eixosNomes.forEach((nome,i)=>{
        const [x,y] = ponto(i,1);
        doc.moveTo(cx,cy).lineTo(x,y).strokeColor(corLinha).lineWidth(0.5).stroke();
        const [lx,ly] = ponto(i,1.18);
        doc.fontSize(7).fillColor(corCinza).font('Helvetica').text(nome, lx-25, ly-4, {width:50, align:'center'});
      });

      const coresSeg = ['#0a9d56','#2563eb','#d97706','#db2777','#7c3aed'];
      segDados.sort((a,b)=>b.valor-a.valor).forEach((sg,idx)=>{
        const cor = coresSeg[idx % coresSeg.length];
        const fracs = [ sg.valor/maxReceita, temPedidos?(sg.ticket/maxTicket):0, temPedidos?(sg.qtd/maxQtd):0 ];
        doc.save();
        fracs.forEach((f,i)=>{
          const [x,y] = ponto(i,f);
          if (i===0) doc.moveTo(x,y); else doc.lineTo(x,y);
        });
        doc.closePath();
        doc.fillOpacity(0.15).fillColor(cor).fill();
        doc.fillOpacity(1).strokeColor(cor).lineWidth(1.5).stroke();
        doc.restore();
      });
      doc.y = cy + raio + 22;

      // Legenda
      segDados.forEach((sg,idx)=>{
        const cor = coresSeg[idx % coresSeg.length];
        const ly = doc.y + idx*13;
        doc.circle(40, ly+4, 3).fillColor(cor).fill();
        doc.fontSize(8).fillColor('#222').font('Helvetica').text(
          limparEmoji(sg.icone) + ' ' + sg.nome + ': R$ ' + brlFmt(sg.valor) + (temPedidos?' | Ticket R$ '+brlFmt(sg.ticket):''), 50, ly
        );
      });
      doc.y = doc.y + segDados.length*13 + 8;
      if (!temPedidos) {
        doc.fontSize(7).fillColor(corCinza).font('Helvetica').text('Ticket Medio e Qtd. Pedidos exigem informar a quantidade no lancamento manual.');
      }
    }

    doc.end();
  });
}

module.exports = { gerarPdfFechamento };
