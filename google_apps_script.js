// ── Google Apps Script — coller dans Extensions > Apps Script ──
// Après: Deploy > New deployment > Web app > Anyone > Deploy
// Copier l'URL et la mettre dans .env comme GOOGLE_SHEET_WEBHOOK

function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var data = JSON.parse(e.postData.contents);

  // Add headers if sheet is empty
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      "Date", "Time (UTC)", "Symbol", "Side", "Entry", "Exit",
      "SL", "TP", "Size USD", "PnL USD", "PnL %", "Reason", "Mode"
    ]);
    // Bold headers
    sheet.getRange(1, 1, 1, 13).setFontWeight("bold");
  }

  sheet.appendRow([
    data.date,
    data.time,
    data.symbol,
    data.side,
    data.entryPrice,
    data.exitPrice,
    data.sl,
    data.tp,
    data.size,
    data.pnlUSD,
    data.pnlPct,
    data.reason,
    data.mode,
  ]);

  // Color the PnL cell
  var lastRow = sheet.getLastRow();
  var pnlCell = sheet.getRange(lastRow, 10); // PnL USD column
  if (data.pnlUSD > 0) {
    pnlCell.setBackground("#d4edda"); // green
  } else if (data.pnlUSD < 0) {
    pnlCell.setBackground("#f8d7da"); // red
  }

  // Color the Reason cell
  var reasonCell = sheet.getRange(lastRow, 12);
  if (data.reason === "TP") reasonCell.setBackground("#d4edda");
  else if (data.reason === "SL") reasonCell.setBackground("#f8d7da");
  else if (data.reason === "ENTRY") reasonCell.setBackground("#cce5ff");

  return ContentService.createTextOutput(
    JSON.stringify({ status: "ok", row: lastRow })
  ).setMimeType(ContentService.MimeType.JSON);
}
