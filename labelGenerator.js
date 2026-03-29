/**
 * Label Generator — Port of sku-to-labels.py to Node.js
 *
 * Generates printable PDF labels with barcodes (EAN/UPC/Code128) and formatted prices.
 * Default profile: Avery 6460 Mini Address Labels (custom tuned).
 *
 * Uses pdf-lib for PDF generation and bwip-js for barcode rendering.
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import bwipjs from 'bwip-js';
import QRCode from 'qrcode';

// Letter page size in points (8.5" x 11")
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const INCH = 72; // 1 inch = 72 PDF points

/**
 * Generate a label PDF from product data.
 *
 * @param {Array<{name: string, barcode: string, price: number}>} products
 * @param {object} profileConfig - Label profile dimensions
 * @param {object} options - { mode: 'barcode'|'sku', offset: number, fontScale: number, barcodeScale: number }
 * @returns {Promise<Buffer>} PDF file as a buffer
 */
export async function generateLabelPDF(products, profileConfig, options = {}) {
  const {
    mode = 'barcode',
    offset = 0,
    fontScale = 0.85,
    barcodeScale = 0.9,
  } = options;

  const {
    label_width,
    label_height,
    labels_per_row,
    labels_per_col,
    page_margin_left,
    page_margin_top,
    label_margin,
  } = profileConfig;

  const labelWidthPts = label_width * INCH;
  const labelHeightPts = label_height * INCH;

  const pdfDoc = await PDFDocument.create();
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let currentLabel = offset;

  for (const product of products) {
    if (!product) continue;

    const row = Math.floor(currentLabel / labels_per_row);
    const col = currentLabel % labels_per_row;

    // New page if needed
    if (row >= labels_per_col) {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      currentLabel = 0;
    }

    const recalcRow = Math.floor(currentLabel / labels_per_row);
    const recalcCol = currentLabel % labels_per_row;

    // Calculate label position (PDF origin is bottom-left)
    const x = page_margin_left * INCH + recalcCol * (labelWidthPts + label_margin * INCH);
    const y = PAGE_HEIGHT - (page_margin_top * INCH + (recalcRow + 1) * (labelHeightPts + label_margin * INCH));

    await drawLabel(page, pdfDoc, x, y, labelWidthPts, labelHeightPts, product, {
      mode,
      fontScale,
      barcodeScale,
      helvetica,
      helveticaBold,
    });

    currentLabel++;
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}

/**
 * Draw a single label on the page.
 */
async function drawLabel(page, pdfDoc, x, y, width, height, product, opts) {
  const { mode, fontScale, barcodeScale, helvetica, helveticaBold } = opts;
  const hasBarcode = product.barcode && String(product.barcode).trim();

  if (!hasBarcode) {
    // Price-only label (no barcode)
    await drawPriceOnlyLabel(page, x, y, width, height, product, opts);
    return;
  }

  if (mode === 'barcode') {
    await drawBarcodeLabel(page, pdfDoc, x, y, width, height, product, opts);
  } else {
    await drawQRLabel(page, pdfDoc, x, y, width, height, product, opts);
  }
}

/**
 * Price-only label (no barcode/QR) — giant centered price with tiny product name.
 */
async function drawPriceOnlyLabel(page, x, y, width, height, product, opts) {
  const { fontScale, helvetica, helveticaBold } = opts;
  const price = product.price;

  // Giant price centered
  const fontSize = Math.min(48 * fontScale, height * 0.8 * 0.875) * 1.1;
  const priceText = price.toFixed(2);
  const dollarFontSize = fontSize * 0.5;

  const dollarWidth = helveticaBold.widthOfTextAtSize('$', dollarFontSize);
  const numberWidth = helveticaBold.widthOfTextAtSize(priceText, fontSize);
  const totalWidth = dollarWidth + numberWidth;

  const priceX = x + (width - totalWidth) / 2;
  const priceY = y + height * 0.62 - fontSize / 2;

  // Dollar sign (superscript)
  page.drawText('$', {
    x: priceX,
    y: priceY + fontSize * 0.3,
    size: dollarFontSize,
    font: helveticaBold,
    color: rgb(0, 0, 0),
  });

  // Price numbers
  page.drawText(priceText, {
    x: priceX + dollarWidth,
    y: priceY,
    size: fontSize,
    font: helveticaBold,
    color: rgb(0, 0, 0),
  });

  // Tiny product name at bottom
  if (product.name) {
    const nameSize = 6 * fontScale;
    let name = product.name;
    const maxChars = Math.floor(width / 3);
    if (name.length > maxChars) name = name.substring(0, maxChars - 3) + '...';
    const nameWidth = helvetica.widthOfTextAtSize(name, nameSize);
    page.drawText(name, {
      x: x + (width - nameWidth) / 2,
      y: y + 12,
      size: nameSize,
      font: helvetica,
      color: rgb(0, 0, 0),
    });
  }
}

/**
 * Barcode label — barcode across top, tiny name, giant price below.
 * Matches the Python sku-to-labels.py barcode mode layout exactly.
 */
async function drawBarcodeLabel(page, pdfDoc, x, y, width, height, product, opts) {
  const { fontScale, barcodeScale, helvetica, helveticaBold } = opts;
  const barcodeMargin = 5;

  // Generate barcode image
  let barcodeImg;
  try {
    barcodeImg = await generateBarcodeImage(product.barcode);
  } catch (err) {
    console.error(`Barcode generation failed for ${product.barcode}: ${err.message}`);
    // Fall back to price-only
    await drawPriceOnlyLabel(page, x, y, width, height, product, opts);
    return;
  }

  const embeddedImg = await pdfDoc.embedPng(barcodeImg);

  // Barcode dimensions and position (full width across top)
  const barcodeWidth = (width - 2 * barcodeMargin) * barcodeScale;
  const barcodeHeight = (height * 0.42) * barcodeScale;
  const barcodeX = x + barcodeMargin + ((width - 2 * barcodeMargin) - barcodeWidth) / 2;
  const barcodeY = y + height - barcodeHeight - 2;

  page.drawImage(embeddedImg, {
    x: barcodeX,
    y: barcodeY,
    width: barcodeWidth,
    height: barcodeHeight,
  });

  // Product name in tiny font (just below barcode) — center aligned
  const nameSize = 5 * fontScale;
  const barcodeToTitleSpacing = 3;
  const nameY = barcodeY - barcodeToTitleSpacing - nameSize;

  let name = product.name;
  const maxChars = Math.floor(barcodeWidth / 3);
  if (name.length > maxChars) name = name.substring(0, maxChars - 3) + '...';

  const nameWidth = helvetica.widthOfTextAtSize(name, nameSize);
  const nameX = x + (width - nameWidth) / 2;

  page.drawText(name, {
    x: nameX,
    y: nameY,
    size: nameSize,
    font: helvetica,
    color: rgb(0, 0, 0),
  });

  // Giant price taking up remaining space — center aligned with superscript dollar
  const titleToPriceSpacing = -15;
  const remainingHeight = nameY - y - titleToPriceSpacing;
  const baseFontSize = Math.min(36 * fontScale, remainingHeight * 0.875);

  // Try font options (matching Python logic)
  const fontOptions = [
    { font: helveticaBold, size: baseFontSize * 1.1 },
    { font: helvetica, size: baseFontSize * 1.175 },
    { font: helveticaBold, size: baseFontSize },
  ];

  const price = product.price;
  const priceText = price.toFixed(2);

  for (const opt of fontOptions) {
    const dollarSize = opt.size * 0.5;
    const dollarW = opt.font.widthOfTextAtSize('$', dollarSize);
    const numberW = opt.font.widthOfTextAtSize(priceText, opt.size);
    const totalW = dollarW + numberW;

    if (totalW <= width - (2 * barcodeMargin + 10)) {
      const priceX = x + (width - totalW) / 2;
      const priceY = y + (remainingHeight - opt.size) / 2;

      // Superscript dollar sign
      page.drawText('$', {
        x: priceX,
        y: priceY + opt.size * 0.3,
        size: dollarSize,
        font: opt.font,
        color: rgb(0, 0, 0),
      });

      // Price numbers
      page.drawText(priceText, {
        x: priceX + dollarW,
        y: priceY,
        size: opt.size,
        font: opt.font,
        color: rgb(0, 0, 0),
      });
      break;
    }
  }
}

/**
 * QR code label — QR on left, text on right (SKU mode).
 */
async function drawQRLabel(page, pdfDoc, x, y, width, height, product, opts) {
  const { fontScale, helvetica, helveticaBold } = opts;

  // Generate QR code image
  let qrImg;
  try {
    const qrDataUrl = await QRCode.toDataURL(String(product.barcode), {
      width: 200,
      margin: 1,
      errorCorrectionLevel: 'L',
    });
    const qrBase64 = qrDataUrl.replace(/^data:image\/png;base64,/, '');
    qrImg = await pdfDoc.embedPng(Buffer.from(qrBase64, 'base64'));
  } catch (err) {
    console.error(`QR generation failed for ${product.barcode}: ${err.message}`);
    await drawPriceOnlyLabel(page, x, y, width, height, product, opts);
    return;
  }

  // QR code dimensions and position (left side of label)
  const codeSize = Math.min(height * 0.8, width * 0.4);
  const codeX = x + 5;
  const codeY = y + (height - codeSize) / 2;

  page.drawImage(qrImg, { x: codeX, y: codeY, width: codeSize, height: codeSize });

  // Text area (right side of label)
  const codeAreaWidth = width * 0.45 + 10;
  const textX = x + codeAreaWidth + 5;

  // Product name (2 lines max)
  const nameFontSize = 7 * fontScale;
  const lineHeight = 9 * fontScale;
  const nameYStart = y + height * 0.65;

  const words = product.name.split(' ');
  const lines = [];
  let currentLine = '';
  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (testLine.length <= 20) {
      currentLine = testLine;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);

  for (let i = 0; i < Math.min(lines.length, 2); i++) {
    let line = lines[i];
    if (i === 1 && lines.length > 2 && line.length > 17) {
      line = line.substring(0, 17) + '...';
    }
    page.drawText(line, {
      x: textX,
      y: nameYStart - i * lineHeight,
      size: nameFontSize,
      font: helveticaBold,
      color: rgb(0, 0, 0),
    });
  }

  // Price
  const priceFontSize = 20 * fontScale;
  const priceY = y + height * 0.15;
  const priceText = `$${product.price.toFixed(2)}`;

  page.drawText(priceText, {
    x: textX,
    y: priceY,
    size: priceFontSize,
    font: helveticaBold,
    color: rgb(0, 0, 0),
  });
}

/**
 * Generate a barcode image (PNG buffer) using bwip-js.
 */
async function generateBarcodeImage(code) {
  const codeStr = String(code).replace(/\D/g, '');

  let bcid;
  let text = codeStr;

  if (codeStr.length === 12) {
    bcid = 'upca';
  } else if (codeStr.length === 13) {
    bcid = 'ean13';
  } else {
    bcid = 'code128';
    text = String(code); // Allow non-numeric for Code128
  }

  try {
    const png = await bwipjs.toBuffer({
      bcid,
      text,
      scale: 3,
      height: 10,
      includetext: false,
      padding: 2,
    });
    return png;
  } catch (err) {
    // Fallback to Code128 if EAN/UPC validation fails
    if (bcid !== 'code128') {
      const png = await bwipjs.toBuffer({
        bcid: 'code128',
        text: codeStr,
        scale: 3,
        height: 10,
        includetext: false,
        padding: 2,
      });
      return png;
    }
    throw err;
  }
}

/**
 * Generate a test/alignment PDF with bordered labels.
 */
export async function generateAlignmentTestPDF(profileConfig, mode = 'barcode') {
  const testProducts = [];
  for (let i = 0; i < 30; i++) {
    testProducts.push({
      name: `Test Label ${i + 1}`,
      barcode: mode === 'barcode' ? `${590000000000 + i}` : `TEST${String(i + 1).padStart(3, '0')}`,
      price: 1.23 + i * 0.11,
    });
  }

  // Generate with borders visible (we'll draw them manually)
  const {
    label_width, label_height, labels_per_row, labels_per_col,
    page_margin_left, page_margin_top, label_margin,
  } = profileConfig;

  const labelWidthPts = label_width * INCH;
  const labelHeightPts = label_height * INCH;

  const pdfDoc = await PDFDocument.create();
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let currentLabel = 0;

  for (const product of testProducts) {
    const row = Math.floor(currentLabel / labels_per_row);
    const col = currentLabel % labels_per_row;

    if (row >= labels_per_col) {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      currentLabel = 0;
    }

    const recalcRow = Math.floor(currentLabel / labels_per_row);
    const recalcCol = currentLabel % labels_per_row;

    const x = page_margin_left * INCH + recalcCol * (labelWidthPts + label_margin * INCH);
    const y = PAGE_HEIGHT - (page_margin_top * INCH + (recalcRow + 1) * (labelHeightPts + label_margin * INCH));

    // Draw border
    page.drawRectangle({
      x, y, width: labelWidthPts, height: labelHeightPts,
      borderColor: rgb(0, 0, 0), borderWidth: 0.5, color: undefined,
    });

    await drawLabel(page, pdfDoc, x, y, labelWidthPts, labelHeightPts, product, {
      mode,
      fontScale: 0.85,
      barcodeScale: 0.9,
      helvetica,
      helveticaBold,
    });

    currentLabel++;
  }

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}
