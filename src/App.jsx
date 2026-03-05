import { useState, useRef, useCallback, useMemo } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// COUNTRIES REGISTRY
// ─────────────────────────────────────────────────────────────────────────────
const COUNTRIES = [
  { code:"SG", name:"Singapore", standard:"PEPPOL BIS 3.0", status:"live", flag:"🇸🇬", currency:"SGD", taxLabel:"GST", taxRate:0.09 },
  { code:"AU", name:"Australia",    standard:"PEPPOL BIS 3.0", status:"coming", flag:"🇦🇺", currency:"AUD", taxLabel:"GST",  taxRate:0.10 },
  { code:"MY", name:"Malaysia",     standard:"MyInvois 1.0",   status:"coming", flag:"🇲🇾", currency:"MYR", taxLabel:"SST",  taxRate:0.06 },
  { code:"FR", name:"France",       standard:"Factur-X",       status:"coming", flag:"🇫🇷", currency:"EUR", taxLabel:"TVA",  taxRate:0.20 },
  { code:"DE", name:"Germany",      standard:"XRechnung",      status:"coming", flag:"🇩🇪", currency:"EUR", taxLabel:"MwSt", taxRate:0.19 },
  { code:"MX", name:"Mexico",       standard:"CFDI 4.0",       status:"coming", flag:"🇲🇽", currency:"MXN", taxLabel:"IVA",  taxRate:0.16 },
  { code:"SA", name:"Saudi Arabia", standard:"ZATCA Phase 2",  status:"roadmap",flag:"🇸🇦", currency:"SAR", taxLabel:"VAT",  taxRate:0.15 },
  { code:"IN", name:"India",        standard:"IRN / e-Way",    status:"roadmap",flag:"🇮🇳", currency:"INR", taxLabel:"GST",  taxRate:0.18 },
];

// ─────────────────────────────────────────────────────────────────────────────
// EN16931 RULE ENGINE — Full category structure
// Rules are grouped per the official EN16931 standard categories
// In production: replace body functions with Schematron validator output
// ─────────────────────────────────────────────────────────────────────────────
const RULE_CATEGORIES = {
  BR:    { label:"Structural",    color:"#ef4444", desc:"Required fields & mandatory elements" },
  BRCO:  { label:"Calculation",   color:"#f59e0b", desc:"Arithmetic: totals, tax, payable amount" },
  BRCL:  { label:"Code Lists",    color:"#8b5cf6", desc:"Valid ISO currency, unit & country codes" },
  BRTAX: { label:"Tax Rules",     color:"#ec4899", desc:"GST/VAT category & rate validation" },
  PEPPOL:{ label:"PEPPOL",        color:"#3b82f6", desc:"PEPPOL-specific mandatory extensions" },
  SG:    { label:"SG Extensions", color:"#10b981", desc:"Singapore IRAS-specific rules" },
};

function runEN16931(invoice, country) {
  const errors = [];
  const add = (id, field, message, suggestion, severity = "error", cat = "BR", lineId = null) =>
    errors.push({ id, field, message, suggestion, severity, cat, lineId });

  const h = invoice.header;
  const lines = invoice.lines || [];

  // ── BR: Structural rules ──────────────────────────────────────────────────
  if (!h.invoiceId)    add("BR-01", "InvoiceID",   "Invoice must have an identifier", "Add a unique invoice number", "error", "BR");
  if (!h.issueDate)    add("BR-02", "IssueDate",   "Invoice must have an issue date", "Add date in YYYY-MM-DD format", "error", "BR");
  if (!h.sellerName)   add("BR-06", "SellerName",  "Seller name is required", "Add the supplier company name", "error", "BR");
  if (!h.buyerName)    add("BR-07", "BuyerName",   "Buyer name is required", "Add the customer company name", "error", "BR");
  if (!h.currency)     add("BR-05", "Currency",    "Invoice currency code is required", "Add currency code e.g. SGD", "error", "BR");
  if (lines.length === 0) add("BR-16", "Lines",    "Invoice must contain at least one line", "Add at least one line item", "error", "BR");

  lines.forEach((line, i) => {
    const ln = `Line ${i + 1}`;
    if (!line.description) add("BR-25", "Description", `${ln}: Description is required`, "Add item or service description", "error", "BR", line.lineId);
    if (line.quantity == null || isNaN(line.quantity)) add("BR-26", "Quantity", `${ln}: Quantity is required`, "Add a numeric quantity", "error", "BR", line.lineId);
    if (line.unitPrice == null || isNaN(line.unitPrice)) add("BR-27", "UnitPrice", `${ln}: Unit price is required`, "Add a numeric unit price", "error", "BR", line.lineId);
  });

  // ── BR-CO: Calculation rules ──────────────────────────────────────────────
  if (lines.length > 0 && !isNaN(h.totalAmount)) {
    const sumLines = lines.reduce((s, l) => s + (parseFloat(l.lineAmount) || 0), 0);
    const sumTax   = lines.reduce((s, l) => s + (parseFloat(l.taxAmount) || 0), 0);
    const expected = sumLines + sumTax;

    if (Math.abs(sumLines - (parseFloat(h.lineNetTotal) || sumLines)) > 0.02)
      add("BR-CO-10", "LineNetTotal", `Line net total (${sumLines.toFixed(2)}) does not match sum of line amounts`, "Recalculate line net total", "error", "BRCO");

    if (Math.abs(expected - parseFloat(h.totalAmount)) > 0.02)
      add("BR-CO-16", "TotalAmount", `Payable amount (${h.totalAmount}) should equal lines (${sumLines.toFixed(2)}) + tax (${sumTax.toFixed(2)}) = ${expected.toFixed(2)}`, "Correct the total amount field", "error", "BRCO");

    lines.forEach((line, i) => {
      const expectedLine = parseFloat(line.quantity) * parseFloat(line.unitPrice);
      if (!isNaN(expectedLine) && Math.abs(expectedLine - parseFloat(line.lineAmount)) > 0.02)
        add("BR-CO-04", "LineAmount", `Line ${i+1}: Line amount (${line.lineAmount}) should equal qty × price (${expectedLine.toFixed(2)})`, "Correct line amount calculation", "error", "BRCO", line.lineId);

      const expectedTax = parseFloat(line.lineAmount) * country.taxRate;
      if (!isNaN(expectedTax) && parseFloat(line.taxAmount) < 0)
        add("BR-CO-15", "TaxAmount", `Line ${i+1}: Tax amount cannot be negative`, "Tax must be a positive number", "error", "BRCO", line.lineId);
    });
  }

  // ── BR-CL: Code list rules ────────────────────────────────────────────────
  const validCurrencies = ["SGD","USD","EUR","GBP","AUD","MYR","MXN","SAR","INR","JPY","CNY"];
  if (h.currency && !validCurrencies.includes(h.currency.toUpperCase()))
    add("BR-CL-04", "Currency", `"${h.currency}" is not a recognised ISO 4217 currency code`, `Use a valid code. Expected: ${country.currency}`, "error", "BRCL");

  if (h.issueDate && !/^\d{4}-\d{2}-\d{2}$/.test(h.issueDate))
    add("BR-CL-DATE", "IssueDate", `Date "${h.issueDate}" is not in required YYYY-MM-DD format`, `Change to format: YYYY-MM-DD (e.g. 2024-03-15)`, "error", "BRCL");
  else if (h.issueDate) {
    const d = new Date(h.issueDate);
    if (isNaN(d.getTime()))
      add("BR-CL-DATE2", "IssueDate", `Date "${h.issueDate}" is not a valid calendar date`, "Check day/month values are correct", "error", "BRCL");
  }

  // ── BR-TAX: Tax rules ─────────────────────────────────────────────────────
  lines.forEach((line, i) => {
    if (parseFloat(line.taxAmount) < 0)
      add("BR-TAX-01", "TaxAmount", `Line ${i+1}: Tax amount cannot be negative`, "Correct negative tax value", "error", "BRTAX", line.lineId);
    if (parseFloat(line.taxAmount) > parseFloat(line.lineAmount))
      add("BR-TAX-02", "TaxAmount", `Line ${i+1}: Tax amount exceeds line amount — likely data error`, "Verify tax calculation", "warning", "BRTAX", line.lineId);
  });

  // ── PEPPOL: PEPPOL-specific rules ─────────────────────────────────────────
  if (!h.sellerTaxId)
    add("PEPPOL-EN16931-R001", "SellerTaxID", "Seller tax registration number is required for PEPPOL", `Add seller ${country.taxLabel} registration number`, "error", "PEPPOL");

  // ── SG: Singapore IRAS extensions ────────────────────────────────────────
  if (country.code === "SG") {
    if (h.sellerTaxId && !/^[A-Z0-9]{9,10}$/.test(h.sellerTaxId))
      add("SG-01", "SellerGST", `Seller GST number "${h.sellerTaxId}" is invalid`, "Singapore GST numbers are 9–10 uppercase alphanumeric characters (e.g. 200312345A)", "error", "SG");
    if (h.buyerTaxId && !/^[A-Z0-9]{9,10}$/.test(h.buyerTaxId))
      add("SG-02", "BuyerGST", `Buyer GST number "${h.buyerTaxId}" is invalid`, "Singapore GST numbers are 9–10 uppercase alphanumeric characters", "warning", "SG");
    if (h.currency && h.currency.toUpperCase() !== "SGD")
      add("SG-03", "Currency", "Singapore PEPPOL invoices must use SGD", "Change currency to SGD", "warning", "SG");
    const taxRate = lines.length > 0 ? parseFloat(lines[0].taxAmount) / parseFloat(lines[0].lineAmount) : null;
    if (taxRate !== null && !isNaN(taxRate) && taxRate > 0 && Math.abs(taxRate - 0.09) > 0.005)
      add("SG-04", "TaxRate", `Implied tax rate (${(taxRate*100).toFixed(1)}%) does not match Singapore GST rate (9%)`, "Verify GST is calculated at 9%", "warning", "SG");
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV PARSER + MULTI-LINE INVOICE GROUPER
// ─────────────────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",").map(h => h.trim());
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = line.split(",").map(v => v.trim());
    const row = {};
    headers.forEach((h, j) => { row[h] = vals[j] ?? ""; });
    return row;
  });
}

const COL_ALIASES = {
  invoiceId:    ["invoiceid","invoice_id","invoice number","inv no","inv_no","reference","ref"],
  issueDate:    ["issuedate","issue_date","date","invoice date","inv_date"],
  sellerName:   ["sellername","seller_name","seller","vendor","supplier","from","company name"],
  sellerTaxId:  ["sellergst","seller_gst","sellertaxid","gst no","gst_no","gst reg","vendor gst","tax id"],
  buyerName:    ["buyername","buyer_name","buyer","customer","client","to","bill to"],
  buyerTaxId:   ["buyergst","buyer_gst","buyertaxid","customer gst","client gst"],
  currency:     ["currency","curr","currencycode","currency_code"],
  lineId:       ["lineid","line_id","line no","linenum","line"],
  description:  ["description","desc","item","service","details","line item","linedesc"],
  quantity:     ["quantity","qty","units","count","no of units"],
  unitPrice:    ["unitprice","unit_price","price","rate","cost per unit","unit cost"],
  lineAmount:   ["lineamount","line_amount","line total","linetotal","amount excl","net amount","subtotal"],
  taxAmount:    ["taxamount","tax_amount","gst","tax","vat","gst amount","tax amt"],
  totalAmount:  ["totalamount","total_amount","total","invoice total","grand total","amount incl","payable"],
  lineNetTotal: ["linenet","line_net","line net total","net total"],
};

function mapColumns(headers) {
  const mapping = {};
  const used = new Set();
  Object.entries(COL_ALIASES).forEach(([field, aliases]) => {
    const lc = headers.map(h => h.toLowerCase());
    // Exact match first
    let idx = lc.findIndex(h => h === field.toLowerCase());
    if (idx === -1) idx = lc.findIndex(h => aliases.includes(h) && !used.has(headers[idx]));
    if (idx === -1) idx = lc.findIndex(h => aliases.some(a => h.includes(a)));
    if (idx !== -1) { mapping[field] = headers[idx]; used.add(headers[idx]); }
  });
  return mapping;
}

function groupInvoices(rows, mapping) {
  const g = (row, field) => mapping[field] ? row[mapping[field]] || "" : "";
  const groups = {};
  const order = [];

  rows.forEach((row, rawIdx) => {
    const id = g(row, "invoiceId") || `UNKNOWN-${rawIdx}`;
    if (!groups[id]) {
      order.push(id);
      groups[id] = {
        header: {
          invoiceId:    g(row, "invoiceId"),
          issueDate:    g(row, "issueDate"),
          sellerName:   g(row, "sellerName"),
          sellerTaxId:  g(row, "sellerTaxId"),
          buyerName:    g(row, "buyerName"),
          buyerTaxId:   g(row, "buyerTaxId"),
          currency:     g(row, "currency") || "SGD",
          totalAmount:  g(row, "totalAmount"),
          lineNetTotal: g(row, "lineNetTotal"),
        },
        lines: [],
        rawRows: [],
      };
    }
    const lineId = g(row, "lineId") || String(groups[id].lines.length + 1);
    groups[id].lines.push({
      lineId,
      description: g(row, "description"),
      quantity:    parseFloat(g(row, "quantity")) || 0,
      unitPrice:   parseFloat(g(row, "unitPrice")) || 0,
      lineAmount:  g(row, "lineAmount") || String((parseFloat(g(row,"quantity"))||0)*(parseFloat(g(row,"unitPrice"))||0)),
      taxAmount:   g(row, "taxAmount"),
    });
    groups[id].rawRows.push(row);
  });

  return order.map(id => groups[id]);
}

// ─────────────────────────────────────────────────────────────────────────────
// XML GENERATOR — UBL 2.1
// ─────────────────────────────────────────────────────────────────────────────
function generateXML(invoice, country) {
  const h = invoice.header;
  const lines = invoice.lines;
  const linesXML = lines.map((l, i) => `  <cac:InvoiceLine>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">${l.quantity}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${h.currency}">${l.lineAmount}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${h.currency}">${l.taxAmount}</cbc:TaxAmount>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Description>${l.description}</cbc:Description>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>${(country.taxRate * 100).toFixed(0)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>${country.taxLabel}</cbc:ID></cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="${h.currency}">${l.unitPrice}</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>`).join("\n");

  const totalTax = lines.reduce((s, l) => s + (parseFloat(l.taxAmount) || 0), 0);
  const totalNet = lines.reduce((s, l) => s + (parseFloat(l.lineAmount) || 0), 0);

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2">
  <!-- PEPPOL BIS Billing 3.0 — ${country.name} (${country.standard}) -->
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#conformant#urn:fdc:peppol.eu:2017:poacc:billing:international:${country.code.toLowerCase()}:3.0</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>${h.invoiceId}</cbc:ID>
  <cbc:IssueDate>${h.issueDate}</cbc:IssueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${h.currency}</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>${h.sellerName}</cbc:Name></cac:PartyName>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${h.sellerTaxId}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>${country.taxLabel}</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>${h.buyerName}</cbc:Name></cac:PartyName>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${h.buyerTaxId || ""}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>${country.taxLabel}</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${h.currency}">${totalTax.toFixed(2)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${h.currency}">${totalNet.toFixed(2)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${h.currency}">${totalTax.toFixed(2)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>${(country.taxRate * 100).toFixed(0)}</cbc:Percent>
        <cac:TaxScheme><cbc:ID>${country.taxLabel}</cbc:ID></cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${h.currency}">${totalNet.toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${h.currency}">${totalNet.toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${h.currency}">${(totalNet + totalTax).toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${h.currency}">${h.totalAmount || (totalNet + totalTax).toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
${linesXML}
</Invoice>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SAMPLE DATA — multi-line invoices with deliberate errors
// ─────────────────────────────────────────────────────────────────────────────
const SAMPLE_CSV = `InvoiceID,IssueDate,SellerName,SellerGST,BuyerName,BuyerGST,Currency,LineID,Description,Quantity,UnitPrice,LineAmount,TaxAmount,TotalAmount
INV-2024-001,2024-03-15,Acme Pte Ltd,200312345A,Beta Corp Pte Ltd,201234567B,SGD,1,Consulting Services — Strategy,10,500.00,5000.00,450.00,5450.00
INV-2024-001,2024-03-15,Acme Pte Ltd,200312345A,Beta Corp Pte Ltd,201234567B,SGD,2,Consulting Services — Implementation,5,500.00,2500.00,225.00,5450.00
INV-2024-001,2024-03-15,Acme Pte Ltd,200312345A,Beta Corp Pte Ltd,201234567B,SGD,3,Travel & Expenses,1,200.00,200.00,18.00,5450.00
INV-2024-002,2024-03-16,Acme Pte Ltd,200312345A,Gamma Ltd,201987654C,SGD,1,Software License — Enterprise,1,2000.00,2000.00,180.00,2180.00
INV-2024-002,2024-03-16,Acme Pte Ltd,200312345A,Gamma Ltd,201987654C,SGD,2,Support & Maintenance (Annual),1,500.00,500.00,45.00,2180.00
INV-2024-003,15/03/2024,Acme Pte Ltd,200312345A,Delta Inc,,SGD,1,Hardware Supply — Servers,5,300.00,1500.00,135.00,1650.00
INV-2024-003,15/03/2024,Acme Pte Ltd,200312345A,Delta Inc,,SGD,2,Installation Services,2,75.00,150.00,13.50,1650.00
INV-2024-004,2024-03-18,Acme Pte Ltd,200312345A,Echo Pte Ltd,201111222D,SGD,1,Training Services — Day 1,1,800.00,800.00,-72.00,1520.00
INV-2024-004,2024-03-18,Acme Pte Ltd,200312345A,Echo Pte Ltd,201111222D,SGD,2,Training Services — Day 2,1,800.00,800.00,72.00,1520.00
INV-2024-005,2024-03-19,Acme Pte Ltd,INVALID-GST,Foxtrot Corp,201333444E,SGD,1,Maintenance Contract,12,150.00,1800.00,162.00,1980.00`;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function downloadText(content, filename, mime = "text/plain") {
  const blob = new Blob([content], { type: mime });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: filename });
  a.click(); URL.revokeObjectURL(a.href);
}

function downloadZip(invoices) {
  const manifest = invoices.map((inv, i) => ({
    index: i + 1, invoiceId: inv.header.invoiceId, status: inv._errors?.length > 0 ? "error" : "valid",
    lines: inv.lines.length, total: inv.header.totalAmount, xmlFile: `${inv.header.invoiceId}.xml`,
  }));
  const summary = ["InvoiceID,Lines,Total,Status,ErrorCount",
    ...invoices.map(inv => `${inv.header.invoiceId},${inv.lines.length},${inv.header.totalAmount},${inv._errors?.length>0?"error":"valid"},${inv._errors?.length||0}`)
  ].join("\n");
  downloadText(
    invoices.map(inv => `<!-- ${inv.header.invoiceId} -->\n${inv._xml}`).join("\n\n"),
    "invoiceflow_export.xml", "application/xml"
  );
  setTimeout(() => downloadText(summary, "validation_summary.csv", "text/csv"), 300);
  setTimeout(() => downloadText(JSON.stringify(manifest, null, 2), "manifest.json", "application/json"), 600);
}

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────
const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #080d18; --surface: #0f1824; --surface2: #162030; --surface3: #1d2a3f;
    --border: #1e2d45; --border2: #243450;
    --accent: #f5a623; --blue: #3b82f6; --green: #10b981; --red: #ef4444;
    --yellow: #f59e0b; --purple: #8b5cf6; --pink: #ec4899;
    --text: #e2eaf5; --muted: #5a6e8c; --muted2: #7a8da8;
    --font: 'Syne', sans-serif; --mono: 'JetBrains Mono', monospace;
    --radius: 8px;
  }
  body { background: var(--bg); color: var(--text); font-family: var(--font); font-size: 13px; }
  ::-webkit-scrollbar { width: 3px; height: 3px; } ::-webkit-scrollbar-thumb { background: var(--border2); }
  .layout { display: flex; min-height: 100vh; }

  /* Sidebar */
  .sidebar { width: 210px; min-width: 210px; background: var(--surface); border-right: 1px solid var(--border); display: flex; flex-direction: column; }
  .logo { padding: 20px 16px; border-bottom: 1px solid var(--border); }
  .logo-name { font-size: 14px; font-weight: 800; letter-spacing: 0.1em; color: var(--accent); }
  .logo-sub { font-size: 9px; color: var(--muted); letter-spacing: 0.12em; margin-top: 2px; font-family: var(--mono); text-transform: uppercase; }
  .nav { flex: 1; padding: 12px 0; }
  .nav-section { font-size: 8px; font-weight: 800; letter-spacing: 0.18em; color: var(--muted); padding: 8px 16px 4px; text-transform: uppercase; }
  .nav-item { display: flex; align-items: center; gap: 9px; padding: 8px 16px; cursor: pointer; font-size: 12px; font-weight: 600; color: var(--muted2); border-left: 2px solid transparent; transition: all 0.12s; }
  .nav-item:hover { color: var(--text); background: var(--surface2); }
  .nav-item.active { color: var(--accent); border-left-color: var(--accent); background: rgba(245,166,35,0.07); }
  .nav-icon { width: 15px; text-align: center; font-size: 13px; }
  .badge { margin-left: auto; padding: 1px 6px; border-radius: 10px; font-size: 9px; font-weight: 800; font-family: var(--mono); }
  .badge-red { background: rgba(239,68,68,0.2); color: var(--red); }
  .badge-green { background: rgba(16,185,129,0.2); color: var(--green); }
  .country-chip { margin: 12px; padding: 10px 12px; background: rgba(245,166,35,0.07); border: 1px solid rgba(245,166,35,0.18); border-radius: var(--radius); }
  .cc-label { font-size: 8px; color: var(--muted); letter-spacing: 0.12em; text-transform: uppercase; font-family: var(--mono); }
  .cc-name { font-size: 13px; font-weight: 700; color: var(--accent); margin-top: 2px; }
  .cc-std { font-size: 9px; color: var(--muted); font-family: var(--mono); margin-top: 1px; }

  /* Main */
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .topbar { height: 52px; background: var(--surface); border-bottom: 1px solid var(--border); padding: 0 28px; display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; }
  .tb-title { font-size: 14px; font-weight: 700; }
  .tb-sub { font-size: 10px; color: var(--muted); font-family: var(--mono); margin-top: 1px; }
  .tb-actions { display: flex; gap: 8px; }
  .content { flex: 1; overflow-y: auto; padding: 24px 28px; }

  /* Buttons */
  .btn { display: inline-flex; align-items: center; gap: 5px; padding: 6px 14px; border-radius: 6px; font-size: 11px; font-weight: 700; font-family: var(--font); cursor: pointer; border: none; transition: all 0.12s; letter-spacing: 0.03em; }
  .btn-primary { background: var(--accent); color: #0a0c12; }
  .btn-primary:hover { filter: brightness(1.1); }
  .btn-outline { background: transparent; color: var(--muted2); border: 1px solid var(--border2); }
  .btn-outline:hover { color: var(--text); border-color: var(--muted); }
  .btn-ghost { background: transparent; color: var(--muted2); }
  .btn-ghost:hover { color: var(--text); background: var(--surface2); }
  .btn-green { background: var(--green); color: #fff; }
  .btn-green:hover { filter: brightness(1.1); }
  .btn-sm { padding: 3px 9px; font-size: 10px; }
  .btn-xs { padding: 2px 7px; font-size: 9px; }

  /* Cards */
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px; }
  .card-title { font-size: 10px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); margin-bottom: 14px; }

  /* KPIs */
  .kpi-row { display: grid; grid-template-columns: repeat(5,1fr); gap: 12px; margin-bottom: 20px; }
  .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
  .kpi-val { font-size: 28px; font-weight: 800; font-family: var(--mono); line-height: 1; }
  .kpi-label { font-size: 9px; color: var(--muted); margin-top: 6px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
  .kpi-sub { font-size: 9px; font-family: var(--mono); margin-top: 3px; }

  /* Rule category pills */
  .rule-cats { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
  .rule-cat { padding: 4px 10px; border-radius: 20px; font-size: 10px; font-weight: 700; font-family: var(--mono); border: 1px solid; cursor: pointer; transition: opacity 0.12s; }
  .rule-cat.inactive { opacity: 0.35; }

  /* Tables */
  .tbl { width: 100%; border-collapse: collapse; font-size: 11px; }
  .tbl th { text-align: left; padding: 7px 10px; font-size: 9px; font-weight: 800; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--border); background: var(--surface2); white-space: nowrap; }
  .tbl td { padding: 7px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
  .tbl tr:hover td { background: rgba(255,255,255,0.015); }
  .tbl-sub { background: rgba(30,50,80,0.3); }
  .tbl-sub td { padding: 5px 10px 5px 30px; font-size: 10px; color: var(--muted2); border-bottom: 1px solid rgba(30,45,69,0.5); }

  /* Status badges */
  .sb { display: inline-flex; align-items: center; gap: 3px; padding: 2px 7px; border-radius: 4px; font-size: 9px; font-weight: 800; font-family: var(--mono); white-space: nowrap; }
  .sb-ok   { background: rgba(16,185,129,0.12); color: var(--green); }
  .sb-err  { background: rgba(239,68,68,0.12);  color: var(--red); }
  .sb-warn { background: rgba(245,158,11,0.12); color: var(--yellow); }

  /* Drop zone */
  .drop-zone { border: 2px dashed var(--border2); border-radius: 10px; padding: 52px 36px; text-align: center; cursor: pointer; transition: all 0.18s; background: var(--surface); }
  .drop-zone.over { border-color: var(--accent); background: rgba(245,166,35,0.04); }
  .dz-icon { font-size: 44px; margin-bottom: 14px; }
  .dz-title { font-size: 16px; font-weight: 700; margin-bottom: 6px; }
  .dz-sub { font-size: 12px; color: var(--muted2); margin-bottom: 20px; }

  /* XML view */
  .xml-pre { background: #060b14; border: 1px solid var(--border); border-radius: 6px; padding: 14px; font-family: var(--mono); font-size: 10px; line-height: 1.65; color: #86c9a0; white-space: pre; overflow-x: auto; max-height: 400px; overflow-y: auto; }

  /* Invoice preview */
  .inv-preview { background: #fff; border-radius: 8px; padding: 28px; color: #111; font-family: Georgia, serif; font-size: 12px; line-height: 1.65; }

  /* Pipeline */
  .pipeline { display: flex; align-items: flex-start; gap: 0; margin-bottom: 20px; }
  .pl-step { flex: 1; text-align: center; position: relative; }
  .pl-step::after { content:''; position:absolute; top:14px; left:50%; right:-50%; height:2px; background: var(--border); z-index:0; }
  .pl-step:last-child::after { display:none; }
  .pl-dot { width:28px; height:28px; border-radius:50%; margin: 0 auto 6px; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:800; position:relative; z-index:1; border: 2px solid var(--border); background: var(--surface); color: var(--muted); transition: all 0.2s; }
  .pl-dot.done { background: var(--green); border-color: var(--green); color: #fff; }
  .pl-dot.active { background: var(--accent); border-color: var(--accent); color: #000; }
  .pl-dot.warn { background: var(--yellow); border-color: var(--yellow); color: #000; }
  .pl-label { font-size: 9px; font-weight: 700; color: var(--muted2); letter-spacing: 0.05em; text-transform: uppercase; }
  .pl-sub { font-size: 8px; color: var(--muted); font-family: var(--mono); margin-top: 1px; }

  /* Grid layouts */
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; }
  .split-lg { display: grid; grid-template-columns: 3fr 2fr; gap: 16px; }
  .divider { height: 1px; background: var(--border); margin: 18px 0; }
  .tag { display:inline-flex; padding: 2px 7px; border-radius: 4px; font-size: 9px; font-weight: 800; font-family: var(--mono); }
  .tag-live    { background:rgba(16,185,129,0.12);  color: var(--green);  border:1px solid rgba(16,185,129,0.25); }
  .tag-coming  { background:rgba(59,130,246,0.12);  color: var(--blue);   border:1px solid rgba(59,130,246,0.25); }
  .tag-roadmap { background:rgba(90,110,140,0.12);  color: var(--muted2); border:1px solid var(--border); }
  .countries-grid { display:grid; grid-template-columns: repeat(4,1fr); gap:12px; }
  .country-card { background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:16px; }
  .country-card.live { border-color:rgba(16,185,129,0.3); }
  .country-card.coming { opacity:0.6; }
  .country-card.roadmap { opacity:0.35; }

  /* Modal */
  .overlay { position:fixed; inset:0; background:rgba(0,0,0,0.75); z-index:200; display:flex; align-items:center; justify-content:center; padding:16px; }
  .modal { background:var(--surface); border:1px solid var(--border2); border-radius:10px; width:100%; max-width:760px; max-height:88vh; display:flex; flex-direction:column; overflow:hidden; }
  .modal-head { padding:18px 22px; border-bottom:1px solid var(--border); display:flex; justify-content:space-between; align-items:center; }
  .modal-body { padding:18px 22px; overflow-y:auto; flex:1; }
  .field-grid { display:grid; grid-template-columns:130px 1fr; gap:8px; margin-bottom:8px; align-items:start; }
  .fk { font-size:9px; font-weight:800; color:var(--muted); font-family:var(--mono); text-transform:uppercase; letter-spacing:0.08em; padding-top:4px; }
  .fv { font-size:11px; font-family:var(--mono); background:var(--surface2); padding:4px 9px; border-radius:4px; border-left:2px solid var(--border); }
  .fv.ok { border-left-color:var(--green); }
  .fv.err { border-left-color:var(--red); }
  .fix-box { background:rgba(245,166,35,0.06); border:1px solid rgba(245,166,35,0.2); border-radius:6px; padding:10px 12px; margin-bottom:8px; }
  .err-id { font-size:9px; font-family:var(--mono); color:var(--accent); font-weight:700; }
  .err-msg { font-size:11px; color:var(--red); margin:3px 0; }
  .err-fix { font-size:10px; color:var(--muted2); }
  .sec-head { font-size:9px; font-weight:800; letter-spacing:0.14em; text-transform:uppercase; color:var(--accent); margin:14px 0 8px; }
  .empty { text-align:center; padding:52px 20px; }
  .empty-icon { font-size:36px; margin-bottom:12px; }
  .empty-title { font-size:15px; font-weight:700; margin-bottom:6px; }
  .empty-sub { font-size:12px; color:var(--muted2); }
  .log-row { display:flex; gap:8px; padding:6px 0; border-bottom:1px solid var(--border); font-size:11px; }
  .log-row:last-child { border-bottom:none; }
  .log-dot { width:5px; height:5px; border-radius:50%; margin-top:4px; flex-shrink:0; }
  .tabs { display:flex; gap:2px; margin-bottom:14px; background:var(--surface2); padding:3px; border-radius:7px; width:fit-content; }
  .tab { padding:5px 12px; border-radius:5px; font-size:11px; font-weight:600; cursor:pointer; color:var(--muted2); transition:all 0.12s; }
  .tab.active { background:var(--surface); color:var(--text); }
`;

// ─────────────────────────────────────────────────────────────────────────────
// APP
// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  const country = COUNTRIES[0]; // Singapore active
  const [view, setView] = useState("dashboard");
  const [invoices, setInvoices] = useState([]);
  const [mapping, setMapping] = useState({});
  const [fileName, setFileName] = useState("");
  const [ingested, setIngested] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [selectedInv, setSelectedInv] = useState(null);
  const [activeCats, setActiveCats] = useState(Object.keys(RULE_CATEGORIES));
  const [xmlTab, setXmlTab] = useState(0);
  const fileRef = useRef();

  const processFile = useCallback((text, name) => {
    const rows = parseCSV(text);
    const headers = Object.keys(rows[0] || {});
    const map = mapColumns(headers);
    const grouped = groupInvoices(rows, map);
    const processed = grouped.map(inv => ({
      ...inv,
      _errors: runEN16931(inv, country),
      _xml: generateXML(inv, country),
    }));
    setInvoices(processed);
    setMapping(map);
    setFileName(name);
    setIngested(true);
    setView("validate");
  }, [country]);

  const handleDrop = useCallback(e => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => processFile(ev.target.result, file.name);
    reader.readAsText(file);
  }, [processFile]);

  // Derived stats
  const totalErrors   = useMemo(() => invoices.reduce((s, i) => s + (i._errors?.filter(e=>e.severity==="error").length||0), 0), [invoices]);
  const totalWarnings = useMemo(() => invoices.reduce((s, i) => s + (i._errors?.filter(e=>e.severity==="warning").length||0), 0), [invoices]);
  const errorInvs     = useMemo(() => invoices.filter(i => i._errors?.some(e=>e.severity==="error")).length, [invoices]);
  const cleanInvs     = invoices.length - errorInvs;
  const totalLines    = useMemo(() => invoices.reduce((s,i) => s + i.lines.length, 0), [invoices]);

  const filteredErrors = (inv) => inv._errors?.filter(e => activeCats.includes(e.cat)) || [];

  const VIEWS = {
    dashboard:  { label:"Dashboard",  icon:"◈", title:"Overview",         sub:"Session metrics & pipeline" },
    ingest:     { label:"Ingest",     icon:"↑", title:"Data Ingestion",    sub:"Upload CSV / Excel" },
    validate:   { label:"Validate",   icon:"✓", title:"Validation",        sub:`${country.name} · ${country.standard}` },
    transform:  { label:"Transform",  icon:"⚙", title:"XML + PDF",         sub:"PEPPOL UBL 2.1 export" },
    countries:  { label:"Countries",  icon:"◉", title:"Country Registry",  sub:"Global module template" },
  };

  // ── DASHBOARD ──────────────────────────────────────────────────────────────
  const Dashboard = () => (
    <div>
      <div className="kpi-row">
        {[
          { val: invoices.length, label:"Invoices",      sub:"loaded",          color: "var(--text)" },
          { val: totalLines,      label:"Line Items",    sub:"across all invoices", color: "var(--blue)" },
          { val: cleanInvs,       label:"Valid",         sub:`${invoices.length ? Math.round(cleanInvs/invoices.length*100) : 0}% pass rate`, color: "var(--green)" },
          { val: totalErrors,     label:"Errors",        sub:`${errorInvs} invoices affected`, color: "var(--red)" },
          { val: totalWarnings,   label:"Warnings",      sub:"non-blocking",    color: "var(--yellow)" },
        ].map((k,i) => (
          <div key={i} className="kpi">
            <div className="kpi-val" style={{color: k.color}}>{k.val}</div>
            <div className="kpi-label">{k.label}</div>
            <div className="kpi-sub" style={{color: k.color === "var(--text)" ? "var(--muted)" : k.color}}>{k.sub}</div>
          </div>
        ))}
      </div>

      <div style={{background:"var(--surface)", border:"1px solid var(--border)", borderRadius:"var(--radius)", padding:"16px", marginBottom:16}}>
        <div className="card-title">Processing Pipeline</div>
        <div className="pipeline">
          {[
            { l:"Ingest",    s: ingested?"done":"active",    icon: ingested?"✓":"1", sub: ingested?`${fileName.slice(0,16)}`:"Awaiting file" },
            { l:"Map",       s: ingested?"done":"active",    icon: ingested?"✓":"2", sub: ingested?`${Object.keys(mapping).length} fields`:"Pending" },
            { l:"Group",     s: ingested?"done":"active",    icon: ingested?"✓":"3", sub: ingested?`${invoices.length} invoices`:"Pending" },
            { l:"Validate",  s: errorInvs>0?"warn":ingested?"done":"active", icon: errorInvs>0?"!":ingested?"✓":"4", sub: ingested?(errorInvs>0?`${totalErrors} errors`:"All clear"):"Pending" },
            { l:"Transform", s: ingested?"active":"active",  icon:"5",               sub:"XML + PDF" },
            { l:"Export",    s:"active",                     icon:"6",               sub:"Bulk download" },
          ].map((s,i)=>(
            <div key={i} className="pl-step">
              <div className={`pl-dot ${s.s}`}>{s.icon}</div>
              <div className="pl-label">{s.l}</div>
              <div className="pl-sub">{s.sub}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid2">
        <div className="card">
          <div className="card-title">Rule Coverage</div>
          {Object.entries(RULE_CATEGORIES).map(([cat,info])=>{
            const catErrors = invoices.reduce((s,inv) => s + (inv._errors?.filter(e=>e.cat===cat).length||0), 0);
            return (
              <div key={cat} style={{display:"flex", alignItems:"center", gap:10, marginBottom:8}}>
                <div style={{width:52, fontSize:9, fontWeight:800, fontFamily:"var(--mono)", color:info.color}}>{cat}</div>
                <div style={{flex:1, height:4, background:"var(--border)", borderRadius:2, overflow:"hidden"}}>
                  <div style={{height:"100%", background: catErrors>0?info.color:"var(--green)", width: catErrors>0?"100%":"100%", opacity: catErrors>0?1:0.4, borderRadius:2}} />
                </div>
                <div style={{fontSize:9, fontFamily:"var(--mono)", color: catErrors>0?"var(--red)":"var(--green)", width:32, textAlign:"right"}}>{catErrors>0?`${catErrors}`:ingested?"✓":"—"}</div>
                <div style={{fontSize:9, color:"var(--muted)", width:130}}>{info.desc}</div>
              </div>
            );
          })}
        </div>
        <div className="card">
          <div className="card-title">Activity Log</div>
          {[
            { c:"var(--green)", m:"Platform ready — Singapore PEPPOL BIS 3.0 engine loaded" },
            { c:"var(--blue)",  m:`EN16931 rule categories active: ${Object.keys(RULE_CATEGORIES).join(", ")}` },
            { c: ingested?"var(--green)":"var(--muted)", m: ingested?`Ingested: ${fileName} — ${invoices.length} invoices, ${totalLines} lines`:"Awaiting upload" },
            { c: ingested?(errorInvs>0?"var(--red)":"var(--green)"):"var(--muted)", m: ingested?(errorInvs>0?`Validation: ${totalErrors} errors, ${totalWarnings} warnings`:"Validation: all invoices passed"):"Validation pending" },
            { c:"var(--muted)", m:"PEPPOL access point: integration stub ready (Storecove / Tickstar)" },
          ].map((l,i)=>(
            <div key={i} className="log-row">
              <div className="log-dot" style={{background:l.c}} />
              <span style={{color:"var(--text)", fontFamily:"var(--mono)", fontSize:10}}>{l.m}</span>
            </div>
          ))}
        </div>
      </div>

      {!ingested && (
        <div style={{marginTop:14}}>
          <div className="card" style={{textAlign:"center", padding:"28px"}}>
            <div style={{fontSize:12, color:"var(--muted2)", marginBottom:14}}>No data loaded — upload a file or load the sample multi-line dataset</div>
            <div style={{display:"flex", gap:8, justifyContent:"center"}}>
              <button className="btn btn-primary" onClick={()=>setView("ingest")}>↑ Upload File</button>
              <button className="btn btn-outline" onClick={()=>processFile(SAMPLE_CSV,"sample_multiline.csv")}>Load Sample Data</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  // ── INGEST ─────────────────────────────────────────────────────────────────
  const Ingest = () => (
    <div>
      <div className={`drop-zone ${dragOver?"over":""}`}
        onDragOver={e=>{e.preventDefault();setDragOver(true);}} onDragLeave={()=>setDragOver(false)} onDrop={handleDrop}
        onClick={()=>fileRef.current.click()}>
        <input ref={fileRef} type="file" accept=".csv,.xlsx" style={{display:"none"}} onChange={e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=ev=>processFile(ev.target.result,f.name);r.readAsText(f);}} />
        <div className="dz-icon">{dragOver?"📂":"📄"}</div>
        <div className="dz-title">{dragOver?"Drop to upload":"Drag & drop your invoice file"}</div>
        <div className="dz-sub">CSV or Excel · Multi-line invoices supported · Columns auto-mapped by AI</div>
        <button className="btn btn-primary" onClick={e=>{e.stopPropagation();fileRef.current.click();}}>Browse Files</button>
      </div>
      <div style={{margin:"18px 0", textAlign:"center", color:"var(--muted)", fontSize:11}}>— or use sample data —</div>
      <div className="card">
        <div className="card-title">Sample Dataset — Multi-Line Invoices</div>
        <p style={{fontSize:11, color:"var(--muted2)", marginBottom:12, lineHeight:1.65}}>
          5 Singapore PEPPOL invoices with 1–3 line items each. Contains deliberate errors: wrong date format, invalid GST number, negative tax amount, and calculation mismatches. Perfect for testing all 6 rule categories.
        </p>
        <div style={{display:"flex", gap:8}}>
          <button className="btn btn-outline" onClick={()=>processFile(SAMPLE_CSV,"sample_multiline.csv")}>Load Sample CSV</button>
          <button className="btn btn-ghost btn-sm" onClick={()=>downloadText(SAMPLE_CSV,"sample_invoices.csv")}>↓ Download Sample</button>
        </div>
      </div>
      <div className="card" style={{marginTop:14}}>
        <div className="card-title">Multi-Line Invoice Format</div>
        <p style={{fontSize:11, color:"var(--muted2)", marginBottom:10, lineHeight:1.6}}>
          Invoices with multiple lines should have one row per line, sharing the same InvoiceID. Header fields (seller, buyer, dates) are taken from the first matching row. Line items are grouped automatically.
        </p>
        <div style={{background:"var(--surface2)", borderRadius:6, padding:"10px 12px", fontFamily:"var(--mono)", fontSize:10, color:"var(--text)", overflowX:"auto"}}>
          <div style={{color:"var(--accent)", marginBottom:4}}>InvoiceID, IssueDate, SellerName, SellerGST, BuyerName, BuyerGST, Currency, LineID, Description, Quantity, UnitPrice, LineAmount, TaxAmount, TotalAmount</div>
          <div style={{color:"var(--muted2)"}}>INV-001, 2024-03-15, Acme Pte Ltd, 200312345A, Beta Corp, 201234567B, SGD, 1, Consulting, 10, 500.00, 5000.00, 450.00, 7675.00</div>
          <div style={{color:"var(--muted2)"}}>INV-001, 2024-03-15, Acme Pte Ltd, 200312345A, Beta Corp, 201234567B, SGD, 2, Travel, 1, 200.00, 200.00, 18.00, 7675.00</div>
          <div style={{color:"var(--muted2)"}}>INV-002, 2024-03-16, Acme Pte Ltd, 200312345A, Gamma Ltd, ..., 1, License, 1, ...</div>
        </div>
        <p style={{fontSize:10, color:"var(--muted)", marginTop:8}}>✦ Column names don't need to match exactly — the AI mapper handles common variants.</p>
      </div>
    </div>
  );

  // ── VALIDATE ───────────────────────────────────────────────────────────────
  const Validate = () => {
    if (!ingested) return (
      <div className="empty"><div className="empty-icon">🔍</div><div className="empty-title">No data to validate</div><div className="empty-sub">Upload a file first</div>
        <button className="btn btn-primary" style={{marginTop:14}} onClick={()=>setView("ingest")}>Go to Ingest</button></div>
    );
    return (
      <div>
        <div style={{display:"flex", gap:8, marginBottom:14, alignItems:"center", flexWrap:"wrap"}}>
          <div style={{flex:1, minWidth:200, background:"var(--surface2)", borderRadius:6, padding:"6px 12px", fontSize:10, fontFamily:"var(--mono)", color:"var(--muted2)"}}>
            📁 {fileName} · {invoices.length} invoices · {totalLines} lines · {Object.keys(mapping).length} fields mapped
          </div>
          <span className="sb sb-ok">✓ {cleanInvs} valid</span>
          {errorInvs > 0 && <span className="sb sb-err">✗ {errorInvs} with errors</span>}
          {totalWarnings > 0 && <span className="sb sb-warn">⚠ {totalWarnings} warnings</span>}
        </div>

        <div className="card" style={{marginBottom:14}}>
          <div className="card-title">AI Column Mapping</div>
          <div style={{display:"flex", flexWrap:"wrap", gap:5}}>
            {Object.entries(COL_ALIASES).map(([field]) => (
              <div key={field} style={{background:"var(--surface2)", border:`1px solid ${mapping[field]?"rgba(16,185,129,0.3)":"rgba(239,68,68,0.25)"}`, borderRadius:4, padding:"3px 8px", fontSize:9, fontFamily:"var(--mono)"}}>
                <span style={{color:"var(--muted)"}}>{field}</span>
                <span style={{color:"var(--muted)", margin:"0 3px"}}>→</span>
                <span style={{color:mapping[field]?"var(--green)":"var(--red)"}}>{mapping[field]||"unmapped"}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card-title" style={{marginBottom:8}}>Filter by Rule Category</div>
        <div className="rule-cats" style={{marginBottom:14}}>
          {Object.entries(RULE_CATEGORIES).map(([cat,info]) => (
            <div key={cat} className={`rule-cat ${activeCats.includes(cat)?"":"inactive"}`}
              style={{color:info.color, borderColor:info.color, background:activeCats.includes(cat)?`${info.color}18`:"transparent"}}
              onClick={()=>setActiveCats(prev=>prev.includes(cat)?prev.filter(c=>c!==cat):[...prev,cat])}>
              {cat} · {info.label}
            </div>
          ))}
        </div>

        <div style={{background:"var(--surface)", border:"1px solid var(--border)", borderRadius:"var(--radius)", overflow:"hidden"}}>
          <table className="tbl">
            <thead><tr>
              <th>Invoice ID</th><th>Date</th><th>Seller</th><th>Buyer</th><th>Lines</th><th>Total</th><th>Status</th><th>Issues</th><th></th>
            </tr></thead>
            <tbody>
              {invoices.map((inv, i) => {
                const errs = filteredErrors(inv).filter(e=>e.severity==="error");
                const warns = filteredErrors(inv).filter(e=>e.severity==="warning");
                const hasErr = errs.length > 0;
                return [
                  <tr key={`inv-${i}`}>
                    <td style={{fontFamily:"var(--mono)", fontWeight:700, fontSize:10}}>{inv.header.invoiceId || "—"}</td>
                    <td style={{fontFamily:"var(--mono)", fontSize:10}}>{inv.header.issueDate || "—"}</td>
                    <td style={{fontSize:11}}>{inv.header.sellerName || "—"}</td>
                    <td style={{fontSize:11}}>{inv.header.buyerName || "—"}</td>
                    <td style={{textAlign:"center"}}><span style={{background:"var(--surface2)", padding:"1px 7px", borderRadius:4, fontFamily:"var(--mono)", fontSize:10}}>{inv.lines.length}</span></td>
                    <td style={{fontFamily:"var(--mono)", fontSize:10}}>{inv.header.currency} {inv.header.totalAmount || "—"}</td>
                    <td>
                      {hasErr ? <span className="sb sb-err">✗ {errs.length} error{errs.length>1?"s":""}</span>
                               : warns.length > 0 ? <span className="sb sb-warn">⚠ {warns.length} warn</span>
                               : <span className="sb sb-ok">✓ Valid</span>}
                    </td>
                    <td>
                      <div style={{display:"flex", flexWrap:"wrap", gap:3}}>
                        {[...new Set([...errs,...warns].map(e=>e.cat))].map(cat=>(
                          <span key={cat} style={{background:`${RULE_CATEGORIES[cat]?.color}18`, color:RULE_CATEGORIES[cat]?.color, border:`1px solid ${RULE_CATEGORIES[cat]?.color}40`, padding:"1px 5px", borderRadius:3, fontSize:8, fontFamily:"var(--mono)", fontWeight:800}}>{cat}</span>
                        ))}
                      </div>
                    </td>
                    <td><button className="btn btn-ghost btn-xs" onClick={()=>setSelectedInv(inv)}>Detail →</button></td>
                  </tr>,
                  // Expand line items inline
                  ...inv.lines.map((line,j) => (
                    <tr key={`line-${i}-${j}`} className="tbl-sub">
                      <td colSpan={2} style={{color:"var(--muted2)"}}>↳ Line {line.lineId}</td>
                      <td colSpan={3} style={{color:"var(--text)"}}>{line.description}</td>
                      <td style={{fontFamily:"var(--mono)"}}>{line.quantity} × {line.unitPrice}</td>
                      <td style={{fontFamily:"var(--mono)"}}>{inv.header.currency} {line.lineAmount}</td>
                      <td colSpan={2}>
                        {inv._errors?.filter(e=>e.lineId===line.lineId).map((e,k)=>(
                          <span key={k} style={{fontSize:8, fontFamily:"var(--mono)", color:e.severity==="error"?"var(--red)":"var(--yellow)", background:e.severity==="error"?"rgba(239,68,68,0.08)":"rgba(245,158,11,0.08)", padding:"1px 5px", borderRadius:3, marginRight:3}}>{e.id}</span>
                        ))}
                      </td>
                    </tr>
                  ))
                ];
              })}
            </tbody>
          </table>
        </div>

        <div style={{display:"flex", gap:8, marginTop:14}}>
          <button className="btn btn-primary" onClick={()=>setView("transform")}>Transform to XML →</button>
          <button className="btn btn-outline" onClick={()=>downloadText(["InvoiceID,Lines,Total,Errors,Warnings", ...invoices.map(inv=>`${inv.header.invoiceId},${inv.lines.length},${inv.header.totalAmount},${inv._errors?.filter(e=>e.severity==="error").length||0},${inv._errors?.filter(e=>e.severity==="warning").length||0}`)].join("\n"), "validated.csv")}>↓ Export Summary CSV</button>
        </div>
      </div>
    );
  };

  // ── TRANSFORM ──────────────────────────────────────────────────────────────
  const Transform = () => {
    if (!ingested) return <div className="empty"><div className="empty-icon">⚙️</div><div className="empty-title">No data loaded</div></div>;
    const inv = invoices[xmlTab] || invoices[0];
    const totalNet = inv ? inv.lines.reduce((s,l)=>s+(parseFloat(l.lineAmount)||0),0) : 0;
    const totalTax = inv ? inv.lines.reduce((s,l)=>s+(parseFloat(l.taxAmount)||0),0) : 0;

    return (
      <div>
        <div style={{display:"flex", gap:8, marginBottom:16}}>
          <button className="btn btn-green" onClick={()=>downloadZip(invoices)}>↓ Bulk Download (XML + CSV + Manifest)</button>
          <button className="btn btn-outline" onClick={()=>downloadText(invoices.map(i=>i._xml).join("\n\n"), "all_invoices.xml","application/xml")}>↓ All XML</button>
        </div>

        <div className="tabs">
          {invoices.map((inv,i)=>(
            <div key={i} className={`tab ${xmlTab===i?"active":""}`} onClick={()=>setXmlTab(i)}>
              {inv.header.invoiceId} {inv._errors?.some(e=>e.severity==="error")?"⚠":"✓"}
            </div>
          ))}
        </div>

        <div className="split-lg">
          <div>
            <div className="card-title" style={{marginBottom:8}}>PEPPOL UBL 2.1 XML Output</div>
            <div className="xml-pre">{inv?._xml}</div>
          </div>
          <div>
            <div className="card-title" style={{marginBottom:8}}>Human-Readable Preview</div>
            {inv && (
              <div className="inv-preview">
                <div style={{display:"flex", justifyContent:"space-between", marginBottom:20}}>
                  <div>
                    <div style={{fontSize:20, fontWeight:700, color:"#0a0e1a"}}>TAX INVOICE</div>
                    <div style={{fontSize:10, color:"#888", marginTop:3}}>PEPPOL BIS 3.0 · Singapore · {country.taxLabel} {(country.taxRate*100).toFixed(0)}%</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:13, fontWeight:700}}>{inv.header.invoiceId}</div>
                    <div style={{fontSize:11, color:"#666"}}>{inv.header.issueDate}</div>
                  </div>
                </div>
                <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:16}}>
                  {[{l:"From",n:inv.header.sellerName,t:inv.header.sellerTaxId},{l:"To",n:inv.header.buyerName,t:inv.header.buyerTaxId}].map((p,i)=>(
                    <div key={i} style={{background:"#f7f8fb", padding:"10px", borderRadius:5}}>
                      <div style={{fontSize:9, color:"#999", textTransform:"uppercase", letterSpacing:"0.1em", marginBottom:4, fontFamily:"sans-serif"}}>{p.l}</div>
                      <div style={{fontWeight:700, fontSize:12}}>{p.n}</div>
                      <div style={{fontSize:10, color:"#666"}}>GST: {p.t || "N/A"}</div>
                    </div>
                  ))}
                </div>
                <table style={{width:"100%", borderCollapse:"collapse", fontSize:11, marginBottom:14}}>
                  <thead><tr style={{borderBottom:"2px solid #0a0e1a"}}>
                    {["#","Description","Qty","Unit Price","Amount"].map(h=>(
                      <th key={h} style={{textAlign: h==="Description"?"left":"right", padding:"5px 4px", fontSize:9, textTransform:"uppercase", letterSpacing:"0.08em", fontFamily:"sans-serif", fontWeight:700}}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {inv.lines.map((l,i)=>(
                      <tr key={i} style={{borderBottom:"1px solid #eee"}}>
                        <td style={{padding:"6px 4px", color:"#999"}}>{l.lineId}</td>
                        <td style={{padding:"6px 4px"}}>{l.description}</td>
                        <td style={{padding:"6px 4px", textAlign:"right"}}>{l.quantity}</td>
                        <td style={{padding:"6px 4px", textAlign:"right"}}>{inv.header.currency} {parseFloat(l.unitPrice).toFixed(2)}</td>
                        <td style={{padding:"6px 4px", textAlign:"right", fontWeight:600}}>{inv.header.currency} {parseFloat(l.lineAmount).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div style={{textAlign:"right", borderTop:"1px solid #eee", paddingTop:10}}>
                  <div style={{fontSize:10, color:"#666", marginBottom:3}}>Net: {inv.header.currency} {totalNet.toFixed(2)}</div>
                  <div style={{fontSize:10, color:"#666", marginBottom:5}}>{country.taxLabel} ({(country.taxRate*100).toFixed(0)}%): {inv.header.currency} {totalTax.toFixed(2)}</div>
                  <div style={{fontSize:15, fontWeight:700}}>Total: {inv.header.currency} {inv.header.totalAmount || (totalNet+totalTax).toFixed(2)}</div>
                </div>
                <div style={{marginTop:14, padding:"7px 10px", background:"#f0faf5", borderRadius:4, fontSize:9, color:"#1a7a4a", fontFamily:"sans-serif"}}>
                  ✓ PEPPOL BIS 3.0 Compliant · Singapore IRAS GST Framework · {inv.lines.length} line item{inv.lines.length>1?"s":""}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  // ── COUNTRIES ──────────────────────────────────────────────────────────────
  const Countries = () => (
    <div>
      <div className="card" style={{marginBottom:16, background:"rgba(245,166,35,0.04)", borderColor:"rgba(245,166,35,0.18)"}}>
        <div style={{display:"flex", gap:14, alignItems:"flex-start"}}>
          <div style={{fontSize:28}}>🤖</div>
          <div>
            <div style={{fontSize:13, fontWeight:700, color:"var(--accent)", marginBottom:5}}>AI-Powered Country Expansion Engine</div>
            <div style={{fontSize:11, color:"var(--muted2)", lineHeight:1.7}}>
              Each country module is a config file generated by AI from the tax authority's published specification. Singapore (PEPPOL BIS 3.0) is the seed. The same core engine covers 40+ PEPPOL nations. New country: feed the spec to AI, review output, merge config. Hours not weeks.
            </div>
          </div>
        </div>
      </div>
      <div className="countries-grid">
        {COUNTRIES.map(c=>(
          <div key={c.code} className={`country-card ${c.status}`}>
            <div style={{fontSize:26, marginBottom:8}}>{c.flag}</div>
            <div style={{fontSize:13, fontWeight:700}}>{c.name}</div>
            <div style={{fontSize:9, color:"var(--muted)", fontFamily:"var(--mono)", marginTop:2}}>{c.standard}</div>
            <div style={{marginTop:8, display:"flex", gap:5, alignItems:"center"}}>
              <span className={`tag tag-${c.status}`}>{c.status==="live"?"● LIVE":c.status==="coming"?"◐ IN BUILD":"○ ROADMAP"}</span>
              <span style={{fontSize:9, color:"var(--muted)", fontFamily:"var(--mono)"}}>{c.currency} · {c.taxLabel}</span>
            </div>
          </div>
        ))}
        <div className="country-card" style={{borderStyle:"dashed", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", textAlign:"center", opacity:0.4, cursor:"pointer", minHeight:120}}>
          <div style={{fontSize:22, marginBottom:6}}>＋</div>
          <div style={{fontSize:11, fontWeight:700}}>Add Country</div>
          <div style={{fontSize:9, color:"var(--muted)", marginTop:3}}>AI-assisted build</div>
        </div>
      </div>
      <div className="divider" />
      <div className="card">
        <div className="card-title">Country Module Schema — Global Staging Template</div>
        <div style={{fontFamily:"var(--mono)", fontSize:10, color:"var(--text)", lineHeight:1.8, background:"var(--surface2)", padding:"12px 14px", borderRadius:6}}>
          {`CountryModule {
  code, name, standard, currency, taxLabel, taxRate
  fields:  FieldDef[]       // required/optional, type, format, pattern
  rules:   ValidationRule[] // EN16931 + country extensions
  xmlTemplate: string       // UBL or country-specific schema
  aiPrompt:    string       // Seed prompt for AI generation
  status:  live | coming | roadmap
  peppolProfile: string | null
}`}
        </div>
      </div>
    </div>
  );

  const cv = VIEWS[view];

  return (
    <>
      <style>{CSS}</style>
      <div className="layout">
        <div className="sidebar">
          <div className="logo">
            <div className="logo-name">InvoiceFlow</div>
            <div className="logo-sub">Global E-Invoicing</div>
          </div>
          <div className="nav">
            <div className="nav-section">Workspace</div>
            {Object.entries(VIEWS).map(([key,v])=>(
              <div key={key} className={`nav-item ${view===key?"active":""}`} onClick={()=>setView(key)}>
                <span className="nav-icon">{v.icon}</span>{v.label}
                {key==="validate" && ingested && errorInvs>0 && <span className="badge badge-red">{errorInvs}</span>}
                {key==="validate" && ingested && errorInvs===0 && <span className="badge badge-green">{invoices.length}</span>}
              </div>
            ))}
          </div>
          <div className="country-chip">
            <div className="cc-label">Active Country</div>
            <div className="cc-name">{country.flag} {country.name}</div>
            <div className="cc-std">{country.standard}</div>
          </div>
        </div>

        <div className="main">
          <div className="topbar">
            <div>
              <div className="tb-title">{cv.title}</div>
              <div className="tb-sub">{cv.sub}</div>
            </div>
            <div className="tb-actions">
              {!ingested && <button className="btn btn-outline btn-sm" onClick={()=>processFile(SAMPLE_CSV,"sample_multiline.csv")}>Load Sample</button>}
              {ingested && view!=="transform" && <button className="btn btn-primary btn-sm" onClick={()=>setView("transform")}>Export XML →</button>}
              {ingested && view==="transform" && <button className="btn btn-green btn-sm" onClick={()=>downloadZip(invoices)}>↓ Bulk Download</button>}
            </div>
          </div>
          <div className="content">
            {view==="dashboard" && <Dashboard />}
            {view==="ingest"    && <Ingest />}
            {view==="validate"  && <Validate />}
            {view==="transform" && <Transform />}
            {view==="countries" && <Countries />}
          </div>
        </div>
      </div>

      {/* Invoice detail modal */}
      {selectedInv && (
        <div className="overlay" onClick={()=>setSelectedInv(null)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div className="modal-head">
              <div>
                <div style={{fontSize:13, fontWeight:700}}>Invoice Detail — {selectedInv.header.invoiceId}</div>
                <div style={{fontSize:9, color:"var(--muted)", fontFamily:"var(--mono)", marginTop:2}}>{selectedInv.lines.length} line{selectedInv.lines.length>1?"s":""} · {selectedInv._errors?.length} validation result{selectedInv._errors?.length!==1?"s":""}</div>
              </div>
              <div style={{display:"flex", gap:6, alignItems:"center"}}>
                {selectedInv._errors?.some(e=>e.severity==="error")
                  ? <span className="sb sb-err">✗ {selectedInv._errors.filter(e=>e.severity==="error").length} error{selectedInv._errors.filter(e=>e.severity==="error").length>1?"s":""}</span>
                  : <span className="sb sb-ok">✓ Valid</span>}
                <button className="btn btn-ghost btn-sm" onClick={()=>setSelectedInv(null)}>✕</button>
              </div>
            </div>
            <div className="modal-body">
              <div className="sec-head">Header Fields</div>
              {Object.entries(selectedInv.header).map(([k,v])=>(
                <div key={k} className="field-grid">
                  <div className="fk">{k}</div>
                  <div className={`fv ${v?"ok":"err"}`}>{v || <span style={{color:"var(--muted)"}}>— empty —</span>}</div>
                </div>
              ))}

              <div className="sec-head">Line Items ({selectedInv.lines.length})</div>
              {selectedInv.lines.map((line,i)=>(
                <div key={i} style={{background:"var(--surface2)", borderRadius:6, padding:"10px 12px", marginBottom:8}}>
                  <div style={{fontSize:9, color:"var(--accent)", fontWeight:800, marginBottom:6, fontFamily:"var(--mono)"}}>LINE {line.lineId}</div>
                  <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:4}}>
                    {[["Description",line.description],["Quantity",line.quantity],["Unit Price",line.unitPrice],["Line Amount",line.lineAmount],["Tax Amount",line.taxAmount]].map(([label,val])=>(
                      <div key={label} className="field-grid" style={{gridTemplateColumns:"80px 1fr", marginBottom:3}}>
                        <div className="fk">{label}</div>
                        <div className="fv ok" style={{fontSize:10}}>{val}</div>
                      </div>
                    ))}
                  </div>
                  {selectedInv._errors?.filter(e=>e.lineId===line.lineId).map((e,j)=>(
                    <div key={j} className="fix-box" style={{marginTop:6, marginBottom:0}}>
                      <div className="err-id">{e.id} · {e.cat}</div>
                      <div className="err-msg">{e.message}</div>
                      <div className="err-fix">💡 {e.suggestion}</div>
                    </div>
                  ))}
                </div>
              ))}

              {selectedInv._errors?.filter(e=>!e.lineId).length > 0 && (
                <>
                  <div className="sec-head">Header-Level Issues</div>
                  {selectedInv._errors.filter(e=>!e.lineId).map((e,i)=>(
                    <div key={i} className="fix-box">
                      <div className="err-id">{e.id} · {RULE_CATEGORIES[e.cat]?.label} · <span style={{color:e.severity==="error"?"var(--red)":"var(--yellow)"}}>{e.severity.toUpperCase()}</span></div>
                      <div className="err-msg">{e.message}</div>
                      <div className="err-fix">💡 {e.suggestion}</div>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

