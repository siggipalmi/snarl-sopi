// ─── receipts.js ──────────────────────────────────────────────────────────────
// Receipt/invoice extraction → normalized per-single-unit NET cost lines.
//
// Feature A: operator uploads a supplier receipt (Bonus photo) or invoice
// (Innnes-style PDF). We call Claude vision to read it into a normalized line
// shape, then derive net-per-single-unit cost for each line. Every product in
// the catalog is sold as a SINGLE unit, so any pack quantity is always divided
// down to the single. Nothing is written to products here — extraction returns a
// draft the operator reviews and confirms.
//
// Feature B (later) reuses the stored receipt to push an expense/bill to Payday.
// This module intentionally captures full receipt detail even where A ignores it.

const API_KEY  = process.env.ANTHROPIC_API_KEY;
const API_URL  = 'https://api.anthropic.com/v1/messages';
const MODEL    = process.env.RECEIPT_VISION_MODEL || 'claude-opus-4-8';
const MAX_TOK  = 8000;

// ─── Extraction prompt ────────────────────────────────────────────────────────
// Encodes exactly the line shape we need. The model reads Icelandic supplier
// formats (Bonus retail receipts, Innnes-style wholesale invoices) and returns
// strict JSON. Key subtlety it must honour: on Bonus receipts the "stk" count is
// PACKS, and the packSize (e.g. 18x330) is units-per-pack — so a line
// "pepsi max dos 18x330 / 2 stk @ 2.059" is 2 packs of 18, price 2.059 per pack.
const EXTRACTION_PROMPT = `You are reading an Icelandic vending-supplier receipt or invoice. Extract every product line into strict JSON. Respond with ONLY the JSON object, no prose, no markdown fences.

Return this exact shape:
{
  "supplier": string,            // store/supplier name, e.g. "Bonus", "Innnes"
  "supplierKt": string|null,     // kennitala (Icelandic company id) if printed
  "date": string|null,           // ISO yyyy-mm-dd if determinable
  "number": string|null,         // receipt/invoice number if printed
  "sourceType": "photo"|"pdf",
  "priceBasis": "net"|"gross",   // are the unit prices net (invoice, VSK excluded) or gross (retail receipt, VSK included)?
  "netTotal": number|null,       // receipt net total (VSK excluded) if printed
  "vskTotal": number|null,       // total VSK if printed
  "grossTotal": number|null,     // receipt gross total if printed
  "lines": [
    {
      "description": string,     // exactly as printed (may be truncated by the till)
      "packSize": string|null,   // e.g. "18x330", "20x40g", "3 pk", or null if none
      "unitsPerPack": number,    // how many SELLABLE SINGLE units one purchased pack contains. 18 for "18x330"; 3 for "3 pk"; 1 if the line is already a single unit
      "qtyPacks": number,        // how many packs were purchased (the "stk" count on Bonus; the case/line count on invoices)
      "pricePerPack": number|null, // price of ONE pack as printed (Bonus "@" price). null if only a line total is shown
      "lineTotal": number|null,  // the line's total amount as printed
      "vatRate": 11|24,          // VSK rate for this line; Icelandic food/drink is 11, most else 24. Default 11 if unsure
      "barcode": string|null     // EAN/strikamerki if the line shows one (invoices often do; retail receipts usually don't)
    }
  ]
}

Rules:
- Icelandic number format: "." is the thousands separator and "," is the decimal. "2.059" = 2059, "140,27" = 140.27. Convert to plain numbers.
- Bonus receipts: the two-row line pattern is "<description> <packSize>" then "<qtyPacks> stk @ <pricePerPack>    <lineTotal>". The stk count is PACKS, not single units. Example: "pepsi max dos 18x330 / 2 stk @ 2.059  4.118" -> packSize "18x330", unitsPerPack 18, qtyPacks 2, pricePerPack 2059, lineTotal 4118. Retail receipts are priceBasis "gross".
- If a packSize like "18x330" or "20x40g" is present, unitsPerPack is the leading number (18, 20). A textual "3 pk" means unitsPerPack 3. No pack indication means unitsPerPack 1.
- Innnes-style invoices: columns give net unit price (Netto verd) and total units (Magn). There priceBasis is "net", unitsPerPack is 1 (Magn already counts single units), qtyPacks is the Magn count, pricePerPack is the Netto verd. Ignore any "Heildsoluverd" list price — it is NOT the cost.
- Never invent barcodes or numbers you cannot see. Use null.
- Include EVERY product line. Do not include subtotal/total/payment rows as lines.`;

// ─── Vision call ──────────────────────────────────────────────────────────────
// mediaType e.g. 'image/jpeg', 'image/png', or 'application/pdf'.
// dataB64 is the base64 file body (no data: prefix).
async function callVision(dataB64, mediaType) {
  if (!API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const isPdf = mediaType === 'application/pdf';
  const source = { type: 'base64', media_type: mediaType, data: dataB64 };
  const fileBlock = isPdf
    ? { type: 'document', source }
    : { type: 'image', source };

  const body = {
    model: MODEL,
    max_tokens: MAX_TOK,
    messages: [{
      role: 'user',
      content: [ fileBlock, { type: 'text', text: EXTRACTION_PROMPT } ],
    }],
  };

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`vision api ${resp.status}: ${t.slice(0, 300)}`);
  }
  const data = await resp.json();
  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
  return text;
}

// Strip accidental ```json fences and parse.
function parseModelJson(text) {
  const clean = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  return JSON.parse(clean);
}

// ─── Normalization ────────────────────────────────────────────────────────────
// Derive net cost per SINGLE sellable unit from one extracted line.
// grossOrNetPerUnit = pricePerPack / unitsPerPack   (or lineTotal / (qtyPacks*unitsPerPack))
// netUnit           = basis 'net' ? that : that / (1 + vatRate/100)
function deriveNetUnit(line) {
  const upp   = Math.max(1, Number(line.unitsPerPack) || 1);
  const qty   = Math.max(0, Number(line.qtyPacks) || 0);
  const rate  = (Number(line.vatRate) === 24) ? 24 : 11;
  const basis = line.priceBasis === 'net' ? 'net' : (line.priceBasis === 'gross' ? 'gross' : null);

  let perPackPrice = (line.pricePerPack != null) ? Number(line.pricePerPack) : null;
  const lineTotal  = (line.lineTotal   != null) ? Number(line.lineTotal)   : null;

  // Fall back to line total / packs when no per-pack price is printed.
  if (perPackPrice == null && lineTotal != null && qty > 0) {
    perPackPrice = lineTotal / qty;
  }
  if (perPackPrice == null || !isFinite(perPackPrice)) {
    return { netUnitCostIsk: null, unitsPerPack: upp, note: 'no price' };
  }

  const perUnit = perPackPrice / upp;
  // priceBasis is set at the receipt level and copied onto each line by the caller.
  const netUnit = (basis === 'net') ? perUnit : perUnit / (1 + rate / 100);

  return {
    netUnitCostIsk: Math.round(netUnit),
    unitsPerPack: upp,
    grossUnitIsk: (basis === 'gross') ? Math.round(perUnit) : null,
    note: null,
  };
}

// Turn the raw model JSON into a normalized draft receipt: receipt-level fields
// plus per-line derived netUnitCostIsk. No DB, no matching yet.
function normalize(raw, sourceType) {
  const basis = raw.priceBasis === 'net' ? 'net' : 'gross';
  const lines = (Array.isArray(raw.lines) ? raw.lines : []).map((l, i) => {
    const line = { ...l, priceBasis: l.priceBasis || basis };
    const d = deriveNetUnit(line);
    return {
      idx: i,
      description:    String(l.description || '').trim(),
      packSize:       l.packSize || null,
      unitsPerPack:   d.unitsPerPack,
      qtyPacks:       Number(l.qtyPacks) || 0,
      barcode:        l.barcode || null,
      priceBasis:     line.priceBasis,
      pricePerPackIsk: l.pricePerPack != null ? Math.round(Number(l.pricePerPack)) : null,
      lineTotalIsk:   l.lineTotal   != null ? Math.round(Number(l.lineTotal))   : null,
      vatRate:        (Number(l.vatRate) === 24) ? 24 : 11,
      netUnitCostIsk: d.netUnitCostIsk,
      grossUnitIsk:   d.grossUnitIsk,
      note:           d.note,
    };
  });

  return {
    supplier:    raw.supplier || null,
    supplierKt:  raw.supplierKt || null,
    date:        raw.date || null,
    number:      raw.number || null,
    sourceType:  sourceType || raw.sourceType || 'photo',
    priceBasis:  basis,
    netTotalIsk:   raw.netTotal   != null ? Math.round(Number(raw.netTotal))   : null,
    vskTotalIsk:   raw.vskTotal   != null ? Math.round(Number(raw.vskTotal))   : null,
    grossTotalIsk: raw.grossTotal != null ? Math.round(Number(raw.grossTotal)) : null,
    lines,
  };
}

// Full extract: file bytes → normalized draft receipt.
async function extract(dataB64, mediaType) {
  const sourceType = (mediaType === 'application/pdf') ? 'pdf' : 'photo';
  const text = await callVision(dataB64, mediaType);
  const raw  = parseModelJson(text);
  return normalize(raw, sourceType);
}

module.exports = { extract, normalize, deriveNetUnit, parseModelJson, callVision };
