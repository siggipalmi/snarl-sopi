# skattur-company-lookup: return every official signer

The live Worker's source is not in this repo; it is edited in the Cloudflare dashboard
(**Workers & Pages → skattur-company-lookup → Edit code**). Editing there keeps its
bindings (cache) and the `SKATTUR_API_KEY` secret. These three edits add a `signers`
list to `/company` and leave every existing field as it was.

## 1. New cache key

Cached answers have no `signers`, so start a fresh cache. In `getCompanyData`, change

```js
const cacheKey = `company-v4/${nationalId}.json`;
```

to

```js
const cacheKey = `company-v5/${nationalId}.json`;
```

## 2. Add `signers` to the answer

In `cleanCompanyResponse`, in the object it returns, add one line after
`rawRelationshipPosition: …`:

```js
    rawRelationshipPosition: fixIcelandicText(getAny(manager, ["position", "Position"])),
    signers: pickSigners(relationships)
```

(Mind the comma at the end of the `rawRelationshipPosition` line.)

## 3. Add this function at the end of the file

```js
/*
  Everyone who can sign for the company: the framkvæmdastjóri and any prókúruhafi.
  One person holding both roles appears once, with both roles. Framkvæmdastjóri first.
  [{ name, nationalId (10 digits), roles: ["Framkvæmdastjóri", "Prókúruhafi"] }]
*/
function pickSigners(relationships) {
  if (!Array.isArray(relationships)) return [];

  const roleOf = r => {
    const text = normalizeText(fixIcelandicText(
      `${getAny(r, ["type", "Type"])} ${getAny(r, ["position", "Position"])}`
    ));
    if (text.includes("framkvaemdastjori")) return "Framkvæmdastjóri";
    if (text.includes("prokur")) return "Prókúruhafi";
    return "";
  };

  const people = new Map();
  for (const r of relationships) {
    const role = roleOf(r);
    if (!role) continue;
    const name = fixIcelandicText(getAny(r, ["name", "Name"])).trim();
    if (!name) continue;
    const nationalId = String(getAny(r, ["nationalId", "NationalId"]) || "").replace(/\D/g, "");
    const key = nationalId || name.toLowerCase();
    const person = people.get(key) || { name, nationalId, roles: [] };
    if (!person.roles.includes(role)) person.roles.push(role);
    people.set(key, person);
  }

  const rank = p => (p.roles.includes("Framkvæmdastjóri") ? 0 : 1);
  return [...people.values()].sort((a, b) => rank(a) - rank(b));
}
```

## Check

Click **Deploy**, then open
`https://skattur-company-lookup.siggip.workers.dev/company?nationalId=<kennitala>&nocache=true`
for a company that has both a framkvæmdastjóri and a prókúruhafi. The answer should end
with a `signers` list holding both.

If a known prókúruhafi is missing, open the same address with `&debug=true` and look at
`responseBody.relationships`: the `type` and `position` texts there are what `roleOf`
matches on.
