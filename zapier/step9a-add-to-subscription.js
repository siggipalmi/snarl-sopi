// Zap step 9a: Bæta við áskrift (Code by Zapier, JavaScript). Goes right BEFORE step 9.
//
// A returning customer (one active Payday subscription already) gets the new machine
// added to that subscription instead of a second one, re-based so every contract keeps
// its own vísitala:
//   - each existing line becomes its current indexed price: price × (new VNV ÷ base VNV)
//   - the new machine's lines are added at their contract price
//   - the subscription's vísitala moves to the new contract's VNV
// Indexing from then on gives the same total as indexing each contract separately.
//
// output.handled: "yes" when it added to an existing subscription (or would have, in a
// dry run); "no" for a new customer. Put a Filter between this step and step 9:
// "Only continue if 9a handled (Text) Exactly matches no".
//
// Inputs:
//   token      ← 6. PD API AUTH PROD (the token)
//   customerId ← 8. Customer Id
//   cpiValue   ← 1. vnv            (the new contract's VNV, e.g. 697.3)
//   cpiDate    ← 1. manudur        (the new contract's month, e.g. 2026M09)
//   upphaf     ← 1. upphaf_iso     (the new lease's start, e.g. 2026-12-01)
//   linesJson  ← 7. Lines Json     (the new machine's lines, as step 9 gets them)
//   apply      ← type yes to save the change in Payday. Anything else is a dry run:
//                nothing is written and output.plan shows what would happen.

const base = "https://api.payday.is";
const headers = { "Authorization": "Bearer " + inputData.token, "Api-Version": "alpha", "Content-Type": "application/json" };
const apply = String(inputData.apply || "").trim().toLowerCase() === "yes";
const customerId = String(inputData.customerId || "").trim();
if (!customerId) throw new Error("customerId vantar (8. Customer Id)");

async function call(method, path, body) {
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(method + " " + path + " → " + res.status + ": " + text.slice(0, 500));
  try { return JSON.parse(text); } catch (e) { return text; }
}
// Payday's list answers wrap the rows in an envelope whose key is not documented.
function rowsOf(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const k of ["recurringInvoices", "invoices", "items", "data", "results"]) if (Array.isArray(data[k])) return data[k];
    for (const v of Object.values(data)) if (Array.isArray(v)) return v;
  }
  return [];
}
// "2026M09" → "2026-09-01"; an ISO date passes through.
function monthDate(v) {
  const s = String(v || "").trim();
  const m = s.match(/^(\d{4})M(\d{2})$/);
  if (m) return m[1] + "-" + m[2] + "-01";
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  throw new Error("cpiDate er ekki á forminu 2026M09: '" + s + "'");
}
function num(v) { const n = Number(String(v).replace(",", ".")); return Number.isFinite(n) ? n : NaN; }

// 1. The customer's active subscriptions (no customer filter exists, so page through).
const subs = [];
for (let page = 1; page <= 50; page++) {
  const data = await call("GET", "/recurring/invoices?perpage=100&page=" + page + "&include=lines");
  const rows = rowsOf(data);
  subs.push(...rows);
  const pages = Number(data && data.pages);
  if (!rows.length || (pages && page >= pages) || (!pages && rows.length < 100)) break;
}
const mine = subs.filter(r => r && r.customer && String(r.customer.id) === customerId && r.active !== false);

if (mine.length === 0) {
  output = { handled: "no", note: "Nýr viðskiptavinur: engin virk áskrift, skref 9 stofnar hana." };
} else if (mine.length > 1) {
  throw new Error("Viðskiptavinur er með " + mine.length + " virkar áskriftir (" + mine.map(r => r.id).join(", ") +
    "). Ekkert var gert; sameinið þær eða bætið vélinni við handvirkt.");
} else {
  let sub = mine[0];
  if (!Array.isArray(sub.lines)) sub = await call("GET", "/recurring/invoices/" + sub.id + "?include=lines");

  // 2. Old and new vísitala, checked before anything changes.
  if (sub.followsConsumerPriceIndex !== true) throw new Error("Áskrift " + sub.id + " fylgir ekki vísitölu. Ekkert var gert.");
  const oldCpi = num(sub.consumerPriceIndexValue);
  const newCpi = num(inputData.cpiValue);
  const newCpiDate = monthDate(inputData.cpiDate);
  if (!(oldCpi > 0)) throw new Error("Áskrift " + sub.id + " hefur enga grunnvísitölu (consumerPriceIndexValue). Ekkert var gert.");
  if (!(newCpi > 0)) throw new Error("cpiValue vantar eða er ógilt: '" + inputData.cpiValue + "'");

  // Payday's own figure for the new month must agree with the contract, or it would index from another number.
  const cpiAnswer = await call("GET", "/general/cpi/" + newCpiDate);
  const paydayCpi = typeof cpiAnswer === "number" ? cpiAnswer
    : num((cpiAnswer && (cpiAnswer.value ?? cpiAnswer.consumerPriceIndex ?? cpiAnswer.index ?? cpiAnswer.cpi)) ??
          (cpiAnswer && Object.values(cpiAnswer).find(v => typeof v === "number")));
  if (!(paydayCpi > 0)) throw new Error("Óvænt svar frá Payday fyrir vísitölu " + newCpiDate + ": " + JSON.stringify(cpiAnswer).slice(0, 300) + ". Ekkert var gert.");
  if (Math.abs(paydayCpi - newCpi) > 0.05) {
    throw new Error("Vísitala í samningi (" + newCpi + ") og hjá Payday fyrir " + newCpiDate + " (" + paydayCpi + ") passa ekki saman. Ekkert var gert.");
  }

  // 3. The new machine must not be invoiced before its lease starts.
  const upphaf = String(inputData.upphaf || "").slice(0, 10);
  if (upphaf && sub.nextInvoiceDate && String(sub.nextInvoiceDate).slice(0, 10) < upphaf) {
    throw new Error("Næsti reikningur áskriftar (" + String(sub.nextInvoiceDate).slice(0, 10) + ") er á undan upphafi nýju leigunnar (" +
      upphaf + "). Ekkert var gert; bætið vélinni við eftir þann reikning.");
  }

  // 4. Re-based lines.
  const ratio = newCpi / oldCpi;
  const kept = (sub.lines || []).map(l => {
    const ex = l.unitPriceExcludingVat != null && l.unitPriceExcludingVat !== "" ? num(l.unitPriceExcludingVat) : NaN;
    const out = {
      id: l.id, recurringInvoiceId: l.recurringInvoiceId, position: l.position, description: l.description,
      quantity: num(l.quantity), vatPercentage: num(l.vatPercentage), discountPercentage: num(l.discountPercentage || 0),
    };
    if (l.sku) out.sku = l.sku;
    if (l.productId) out.productId = l.productId;
    if (Number.isFinite(ex)) out.unitPriceExcludingVat = Math.round(ex * ratio);
    else out.unitPriceIncludingVat = Math.round(num(l.unitPriceIncludingVat) * ratio);
    return { line: out, before: Number.isFinite(ex) ? ex : num(l.unitPriceIncludingVat) };
  });
  let added;
  try { added = JSON.parse(inputData.linesJson || "[]"); } catch (e) { throw new Error("linesJson er ekki gilt JSON: " + e.message); }
  if (!Array.isArray(added) || !added.length) throw new Error("Engar línur fyrir nýju vélina (linesJson).");
  let pos = Math.max(0, ...kept.map(k => Number(k.line.position) || 0));
  const newLines = added.map(l => ({ ...l, position: ++pos }));

  const body = {
    active: true,
    customer: { id: sub.customer.id },
    intervalType: sub.intervalType,
    numberOfOccurrencesLeft: sub.numberOfOccurrencesLeft ?? null,
    nextInvoiceDate: String(sub.nextInvoiceDate).slice(0, 10),
    dueDateDaysAfter: sub.dueDateDaysAfter,
    dueDateType: sub.dueDateType,
    finalDueDateDaysAfter: sub.finalDueDateDaysAfter,
    finalDueDateType: sub.finalDueDateType,
    reference: sub.reference,
    description: sub.description,
    sendEmail: sub.sendEmail,
    currencyCode: sub.currencyCode || "ISK",
    createClaim: sub.createClaim,
    followsConsumerPriceIndex: true,
    consumerPriceIndexValue: newCpi,
    consumerPriceIndexDate: newCpiDate,
    createElectronicInvoice: sub.createElectronicInvoice,
    electronicInvoicePartyId: sub.electronicInvoicePartyId,
    accountingCost: sub.accountingCost,
    lines: [...kept.map(k => k.line), ...newLines],
  };
  const plan = {
    subscriptionId: sub.id,
    vnv: { before: oldCpi + " (" + String(sub.consumerPriceIndexDate || "").slice(0, 10) + ")", after: newCpi + " (" + newCpiDate + ")" },
    existingLines: kept.map(k => k.line.description + ": " + k.before + " → " + (k.line.unitPriceExcludingVat ?? k.line.unitPriceIncludingVat)),
    addedLines: newLines.map(l => l.description + " × " + l.quantity + ": " + (l.unitPriceExcludingVat ?? l.unitPriceIncludingVat)),
    nextInvoiceDate: body.nextInvoiceDate,
  };

  if (!apply) {
    output = { handled: "yes", dryRun: "yes", plan: JSON.stringify(plan, null, 2), body: JSON.stringify(body) };
  } else {
    await call("PUT", "/recurring/invoices/" + sub.id, body);
    const after = await call("GET", "/recurring/invoices/" + sub.id + "?include=lines");
    output = {
      handled: "yes", dryRun: "no", subscriptionId: sub.id, plan: JSON.stringify(plan, null, 2),
      savedCpi: String(after.consumerPriceIndexValue) + " (" + String(after.consumerPriceIndexDate || "").slice(0, 10) + ")",
      savedLines: (after.lines || []).map(l => l.description + ": " + (l.unitPriceExcludingVat ?? l.unitPriceIncludingVat)).join("\n"),
    };
  }
}
