'use strict';

const PDFDocument = require('pdfkit');

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 10);

  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d);
}

function formatTimestamp(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);

  return new Intl.DateTimeFormat('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

function groupLinesByCategory(lines = []) {
  const groups = [];
  const map = new Map();

  for (const line of lines) {
    const key = line.category && String(line.category).trim()
      ? String(line.category).trim()
      : 'Ohne Kategorie';

    if (!map.has(key)) {
      const group = { category: key, lines: [] };
      map.set(key, group);
      groups.push(group);
    }

    map.get(key).lines.push(line);
  }

  return groups;
}

function createBaseDoc(title = 'BUNCA Bakery PDF') {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 42,
    bufferPages: true,
    info: {
      Title: title,
      Author: 'BUNCA Bakery System',
      Subject: title,
    },
  });

  doc.registerFont('Helvetica', 'Helvetica');
  doc.registerFont('Helvetica-Bold', 'Helvetica-Bold');
  return doc;
}

function drawPageBackground(doc) {
  const { width, height } = doc.page;

  doc.save();
  doc.rect(0, 0, width, height).fill('#f6f1e8');
  doc.restore();

  doc.save();
  doc.roundedRect(24, 20, width - 48, height - 40, 22).fill('#fffaf3');
  doc.restore();
}

function drawHeader(doc, options = {}) {
  const {
    eyebrow = 'BUNCA BAKERY',
    title = '',
    subtitle = '',
    rightTop = '',
    rightBottom = '',
  } = options;

  const pageWidth = doc.page.width;
  const contentWidth = pageWidth - 84;

  doc.save();
  doc.roundedRect(42, 36, contentWidth, 82, 18).fill('#efe4d6');
  doc.restore();

  doc.fillColor('#8b5e3c')
    .font('Helvetica-Bold')
    .fontSize(10)
    .text(eyebrow, 58, 52, { width: 240 });

  doc.fillColor('#2f241c')
    .font('Helvetica-Bold')
    .fontSize(22)
    .text(title, 58, 66, { width: 340 });

  doc.fillColor('#6f5d4f')
    .font('Helvetica')
    .fontSize(10.5)
    .text(subtitle, 58, 93, { width: 360 });

  if (rightTop) {
    doc.fillColor('#8b5e3c')
      .font('Helvetica-Bold')
      .fontSize(10)
      .text(rightTop, pageWidth - 210, 58, {
        width: 150,
        align: 'right',
      });
  }

  if (rightBottom) {
    doc.fillColor('#6f5d4f')
      .font('Helvetica')
      .fontSize(10.5)
      .text(rightBottom, pageWidth - 210, 76, {
        width: 150,
        align: 'right',
      });
  }

  doc.moveTo(58, 128)
    .lineTo(pageWidth - 58, 128)
    .lineWidth(1)
    .strokeColor('#d9c6b3')
    .stroke();

  doc.y = 142;
}

function drawInfoCards(doc, cards = []) {
  const startX = 42;
  const gap = 12;
  const totalWidth = doc.page.width - 84;
  const cardWidth = (totalWidth - gap * (cards.length - 1)) / cards.length;
  const topY = doc.y;

  cards.forEach((card, index) => {
    const x = startX + index * (cardWidth + gap);

    doc.save();
    doc.roundedRect(x, topY, cardWidth, 56, 14).fill('#fbf6ef');
    doc.restore();

    doc.fillColor('#7a6858')
      .font('Helvetica-Bold')
      .fontSize(8.5)
      .text(card.label || '', x + 12, topY + 10, {
        width: cardWidth - 24,
      });

    doc.fillColor('#2f241c')
      .font('Helvetica-Bold')
      .fontSize(14)
      .text(String(card.value ?? ''), x + 12, topY + 25, {
        width: cardWidth - 24,
      });
  });

  doc.y = topY + 74;
}

function ensureSpace(doc, neededHeight = 80) {
  const bottomLimit = doc.page.height - 56;
  if (doc.y + neededHeight <= bottomLimit) return;

  doc.addPage();
  drawPageBackground(doc);
  doc.y = 42;
}

function drawOrderTable(doc, groupedLines = []) {
  const tableX = 42;
  const tableWidth = doc.page.width - 84;
  const colWidths = {
    item: 220,
    soll: 68,
    ist: 68,
    suggested: 78,
    ordered: 78,
  };

  const drawTableHeader = () => {
    ensureSpace(doc, 50);

    const y = doc.y;

    doc.save();
    doc.roundedRect(tableX, y, tableWidth, 28, 10).fill('#efe4d6');
    doc.restore();

    doc.fillColor('#6c523e')
      .font('Helvetica-Bold')
      .fontSize(9);

    let x = tableX + 10;
    doc.text('Artikel', x, y + 9, { width: colWidths.item });
    x += colWidths.item;
    doc.text('SOLL', x, y + 9, { width: colWidths.soll, align: 'center' });
    x += colWidths.soll;
    doc.text('IST', x, y + 9, { width: colWidths.ist, align: 'center' });
    x += colWidths.ist;
    doc.text('Vorschlag', x, y + 9, { width: colWidths.suggested, align: 'center' });
    x += colWidths.suggested;
    doc.text('Bestellt', x, y + 9, { width: colWidths.ordered, align: 'center' });

    doc.y = y + 36;
  };

  drawTableHeader();

  groupedLines.forEach((group) => {
    ensureSpace(doc, 34);

    doc.save();
    doc.roundedRect(tableX, doc.y, tableWidth, 24, 8).fill('#f7efe5');
    doc.restore();

    doc.fillColor('#8b5e3c')
      .font('Helvetica-Bold')
      .fontSize(9.5)
      .text(group.category, tableX + 10, doc.y + 7, {
        width: tableWidth - 20,
      });

    doc.y += 30;

    group.lines.forEach((line) => {
      ensureSpace(doc, 34);

      const y = doc.y;
      let x = tableX + 10;

      doc.strokeColor('#eadccf')
        .lineWidth(1)
        .moveTo(tableX, y + 24)
        .lineTo(tableX + tableWidth, y + 24)
        .stroke();

      doc.fillColor('#2f241c')
        .font('Helvetica-Bold')
        .fontSize(9.5)
        .text(line.itemName || '', x, y, {
          width: colWidths.item - 8,
        });

      if (line.unit) {
        doc.fillColor('#7a6858')
          .font('Helvetica')
          .fontSize(8.2)
          .text(`Einheit: ${line.unit}`, x, y + 12, {
            width: colWidths.item - 8,
          });
      }

      x += colWidths.item;

      doc.fillColor('#2f241c')
        .font('Helvetica')
        .fontSize(9.5)
        .text(String(toNumber(line.sollBestand, 0)), x, y + 5, {
          width: colWidths.soll,
          align: 'center',
        });

      x += colWidths.soll;

      doc.text(String(toNumber(line.istBestand, 0)), x, y + 5, {
        width: colWidths.ist,
        align: 'center',
      });

      x += colWidths.ist;

      doc.text(String(toNumber(line.suggestedQty, 0)), x, y + 5, {
        width: colWidths.suggested,
        align: 'center',
      });

      x += colWidths.suggested;

      doc.font(line.manualOverride ? 'Helvetica-Bold' : 'Helvetica')
        .text(String(toNumber(line.orderedQty, 0)), x, y + 5, {
          width: colWidths.ordered,
          align: 'center',
        });

      doc.y = y + 28;
    });

    doc.y += 6;
  });
}

function drawProductionTable(doc, items = [], orderDate = '') {
  const tableX = 42;
  const tableWidth = doc.page.width - 84;
  const colWidths = {
    item: 190,
    total: 70,
    breakdown: tableWidth - 260,
  };

  const drawTableHeader = () => {
    ensureSpace(doc, 50);

    const y = doc.y;

    doc.save();
    doc.roundedRect(tableX, y, tableWidth, 28, 10).fill('#efe4d6');
    doc.restore();

    doc.fillColor('#6c523e')
      .font('Helvetica-Bold')
      .fontSize(9);

    let x = tableX + 10;
    doc.text('Artikel', x, y + 9, { width: colWidths.item });
    x += colWidths.item;
    doc.text('Gesamt', x, y + 9, { width: colWidths.total, align: 'center' });
    x += colWidths.total;
    doc.text(`Shops · ${formatDate(orderDate)}`, x, y + 9, {
      width: colWidths.breakdown,
    });

    doc.y = y + 36;
  };

  drawTableHeader();

  items.forEach((item) => {
    const breakdownHeight = Math.max(26, (item.shops || []).length * 18 + 6);
    ensureSpace(doc, breakdownHeight + 16);

    const y = doc.y;
    let x = tableX + 10;

    doc.strokeColor('#eadccf')
      .lineWidth(1)
      .moveTo(tableX, y + breakdownHeight)
      .lineTo(tableX + tableWidth, y + breakdownHeight)
      .stroke();

    doc.fillColor('#2f241c')
      .font('Helvetica-Bold')
      .fontSize(9.5)
      .text(item.itemName || '', x, y, {
        width: colWidths.item - 8,
      });

    doc.fillColor('#7a6858')
      .font('Helvetica')
      .fontSize(8.2)
      .text(
        `${item.category || 'Ohne Kategorie'} · ${item.unit || 'Stk'}`,
        x,
        y + 12,
        { width: colWidths.item - 8 }
      );

    x += colWidths.item;

    doc.fillColor('#2f241c')
      .font('Helvetica-Bold')
      .fontSize(10)
      .text(String(toNumber(item.totalOrderedQty, 0)), x, y + 5, {
        width: colWidths.total,
        align: 'center',
      });

    x += colWidths.total;

    let breakdownY = y;
    (item.shops || []).forEach((shop) => {
      doc.fillColor('#2f241c')
        .font('Helvetica-Bold')
        .fontSize(8.7)
        .text(shop.shopName || '', x, breakdownY, { width: 120 });

      doc.fillColor('#7a6858')
        .font('Helvetica')
        .fontSize(8.4)
        .text(
          `IST ${toNumber(shop.istBestand, 0)} · SOLL ${toNumber(shop.sollBestand, 0)} · Bestellt ${toNumber(shop.orderedQty, 0)}`,
          x + 126,
          breakdownY,
          { width: colWidths.breakdown - 130 }
        );

      breakdownY += 18;
    });

    doc.y = y + breakdownHeight + 6;
  });
}

function drawFooter(doc) {
  const range = doc.bufferedPageRange();

  for (let i = 0; i < range.count; i += 1) {
    doc.switchToPage(range.start + i);

    const pageNumber = i + 1;
    const text = `BUNCA Bakery · Seite ${pageNumber} von ${range.count}`;
    const printed = `Erstellt am ${formatTimestamp(new Date())}`;

    doc.strokeColor('#e1d4c8')
      .moveTo(42, doc.page.height - 38)
      .lineTo(doc.page.width - 42, doc.page.height - 38)
      .stroke();

    doc.fillColor('#8a7767')
      .font('Helvetica')
      .fontSize(8.5)
      .text(text, 42, doc.page.height - 28, {
        width: 220,
      });

    doc.text(printed, doc.page.width - 220, doc.page.height - 28, {
      width: 178,
      align: 'right',
    });
  }
}

function streamPdf(doc, res, filename) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  doc.pipe(res);
}

function buildOrderPdf(res, order) {
  const doc = createBaseDoc(`Bestellung ${order?.shopName || ''} ${order?.orderDate || ''}`);
  streamPdf(doc, res, `bakery-bestellung-${order?.shopCode || 'shop'}-${order?.orderDate || 'datum'}.pdf`);

  drawPageBackground(doc);

  drawHeader(doc, {
    eyebrow: 'BUNCA BAKERY',
    title: 'Bestellung',
    subtitle: 'Bestelldetails mit IST Bestand, SOLL Bestand und finaler Bestellmenge',
    rightTop: order?.shopName || '',
    rightBottom: formatDate(order?.orderDate),
  });

  const totalItems = (order?.lines || []).length;
  const totalSuggested = (order?.lines || []).reduce((sum, line) => sum + toNumber(line.suggestedQty, 0), 0);
  const totalOrdered = (order?.lines || []).reduce((sum, line) => sum + toNumber(line.orderedQty, 0), 0);

  drawInfoCards(doc, [
    { label: 'SHOP', value: order?.shopName || '—' },
    { label: 'STATUS', value: order?.status || '—' },
    { label: 'POSITIONEN', value: totalItems },
    { label: 'BESTELLMENGE', value: totalOrdered },
  ]);

  if (order?.note) {
    ensureSpace(doc, 70);

    doc.save();
    doc.roundedRect(42, doc.y, doc.page.width - 84, 46, 12).fill('#fbf6ef');
    doc.restore();

    doc.fillColor('#7a6858')
      .font('Helvetica-Bold')
      .fontSize(8.5)
      .text('NOTIZ', 54, doc.y + 9);

    doc.fillColor('#2f241c')
      .font('Helvetica')
      .fontSize(9.5)
      .text(order.note, 54, doc.y + 22, {
        width: doc.page.width - 108,
      });

    doc.y += 62;
  }

  doc.fillColor('#7a6858')
    .font('Helvetica')
    .fontSize(9)
    .text(
      `Vorschlag gesamt: ${totalSuggested} · Finale Bestellmenge: ${totalOrdered}`,
      42,
      doc.y,
      { width: doc.page.width - 84 }
    );

  doc.y += 18;

  drawOrderTable(doc, groupLinesByCategory(order?.lines || []));
  drawFooter(doc);
  doc.end();
}

function buildProductionPdf(res, productionReport, options = {}) {
  const orderDate = options.orderDate || productionReport?.orderDate || '';
  const doc = createBaseDoc(`Produktion ${orderDate}`);
  streamPdf(doc, res, `bakery-produktion-${orderDate || 'datum'}.pdf`);

  drawPageBackground(doc);

  drawHeader(doc, {
    eyebrow: 'BUNCA BAKERY',
    title: 'Produktionsbericht',
    subtitle: 'Summierte Mengen aller abgegebenen Bestellungen für einen Tag',
    rightTop: 'Produktion',
    rightBottom: formatDate(orderDate),
  });

  const items = productionReport?.items || [];
  const totalQty = items.reduce((sum, item) => sum + toNumber(item.totalOrderedQty, 0), 0);
  const totalLines = items.length;
  const totalShopRefs = items.reduce((sum, item) => sum + (item.shops || []).length, 0);

  drawInfoCards(doc, [
    { label: 'DATUM', value: formatDate(orderDate) || '—' },
    { label: 'ARTIKEL', value: totalLines },
    { label: 'GESAMTMENGE', value: totalQty },
    { label: 'SHOP EINTRÄGE', value: totalShopRefs },
  ]);

  drawProductionTable(doc, items, orderDate);
  drawFooter(doc);
  doc.end();
}

module.exports = {
  buildOrderPdf,
  buildProductionPdf,
};
