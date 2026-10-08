// Zap step 8: Stofna viðskiptavin (Code by Zapier, JavaScript)
// Inputs: token ← 6. PD API AUTH PROD, ssn ← 1. kennitala, name ← 1. Nafn_Leigutaka,
//         email1 ← 1. Netfang_Reikninga, email2 ← 1. netfang
// Reuses the Payday customer with this kennitala if there is one; creates it otherwise.
const base = "https://api.payday.is";
const headers = { "Authorization": "Bearer " + inputData.token, "Api-Version": "alpha", "Content-Type": "application/json" };
const ssn = String(inputData.ssn || "").replace(/\D/g, "");
const name = String(inputData.name || "").trim();
const seen = new Set();
const email = [inputData.email1, inputData.email2]
  .map(e => String(e || "").trim())
  .filter(e => e !== "" && !seen.has(e.toLowerCase()) && seen.add(e.toLowerCase()))
  .join(",");
if (ssn.length !== 10) throw new Error("Kennitala vantar eða er ógild: '" + inputData.ssn + "'");

// 1. Existing customer? Payday has no kennitala filter, so page through the list.
let existing = null;
for (let page = 1, pages = 1; page <= pages && page <= 60 && !existing; page++) {
  const res = await fetch(base + "/customers?page=" + page, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error("Customer lookup failed (" + res.status + "): " + text);
  const data = JSON.parse(text);
  const rows = data.customers || [];
  existing = rows.find(c => String(c.ssn || "").replace(/\D/g, "") === ssn) || null;
  pages = Number(data.pages || 1);
  if (!rows.length) break;
}
if (existing) {
  output = {
    customerId: existing.id,
    customerName: existing.name,
    customerEmail: existing.email || email,
    eInvoiceEnabled: existing.sendElectronicInvoices === true,
    existingCustomer: true,
  };
} else {
  // 2. New customer: try e-invoices first, fall back if the company cannot receive them.
  async function createCustomer(withEInvoice) {
    const body = { ssn, name, email, language: "is" };
    if (withEInvoice) body.sendElectronicInvoices = true;
    const res = await fetch(base + "/customers", { method: "POST", headers, body: JSON.stringify(body) });
    return { ok: res.ok, status: res.status, text: await res.text() };
  }
  let result = await createCustomer(true);
  let eInvoiceEnabled = true;
  if (!result.ok && (result.text.includes("21018") || result.text.toLowerCase().includes("does not accept electronic invoices"))) {
    eInvoiceEnabled = false;
    result = await createCustomer(false);
  }
  if (!result.ok) throw new Error("Customer create failed (" + result.status + "): " + result.text);
  const data = JSON.parse(result.text);
  output = { customerId: data.id, customerName: data.name, customerEmail: email, eInvoiceEnabled, existingCustomer: false };
}
