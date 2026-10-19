// skattur-company-lookup — Skatturinn (fyrirtækjaskrá) lookup for the lease forms.
//
// The live Worker is edited in the Cloudflare dashboard (Workers & Pages →
// skattur-company-lookup → Edit code), which keeps its cache binding and the
// SKATTUR_API_KEY secret. This file is the full code to paste there.
//
// Same as the earlier version, plus `signers`: everyone who can sign for the
// company (framkvæmdastjóri and prókúruhafar), and a new cache key (company-v5)
// so cached answers without `signers` are not reused.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return jsonResponse({
        ok: true,
        service: "Skatturinn company lookup Worker",
        usage: "/company?nationalId=1234567890",
        debugUsage: "/company?nationalId=1234567890&debug=true",
        noCacheUsage: "/company?nationalId=1234567890&nocache=true",
        encodingTest: "/encoding-test"
      });
    }

    if (url.pathname === "/encoding-test") {
      const input = "ÃžingholtsstrÃ¦ti 27, ReykjavÃ­k, SigurÃ°ur PÃ¡lmi";
      return jsonResponse({
        input,
        fixed: fixIcelandicText(input),
        expected: "Þingholtsstræti 27, Reykjavík, Sigurður Pálmi"
      });
    }

    if (url.pathname === "/company") {
      const nationalId = normalizeNationalId(url.searchParams.get("nationalId"));
      const debug = url.searchParams.get("debug") === "true";
      const noCache = url.searchParams.get("nocache") === "true";

      if (!nationalId) {
        return jsonResponse({ error: "Missing nationalId" }, 400);
      }

      if (!/^\d{10}$/.test(nationalId)) {
        return jsonResponse(
          { error: "Invalid nationalId format. Use 10 digits, with or without dash." },
          400
        );
      }

      try {
        const result = await getCompanyData(nationalId, env, debug, noCache);
        return jsonResponse(result);
      } catch (error) {
        return jsonResponse(
          {
            error: "Company lookup failed",
            details: error.message
          },
          500
        );
      }
    }

    return jsonResponse({ error: "Not found" }, 404);
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store"
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: corsHeaders()
  });
}

function normalizeNationalId(value) {
  return String(value || "")
    .replace(/\D/g, "")
    .trim();
}

async function getCompanyData(nationalId, env, debug = false, noCache = false) {
  /*
    v5: answers now carry `signers`. A new key means older cached answers
    (without it) are ignored automatically.
  */
  const cacheKey = `company-v5/${nationalId}.json`;

  if (!debug && !noCache && env.COMPANY_CACHE) {
    const cached = await env.COMPANY_CACHE.get(cacheKey);

    if (cached) {
      const cachedText = await cached.text();
      const cachedData = JSON.parse(cachedText);
      const cachedString = JSON.stringify(cachedData);

      const cacheLooksValid =
        cachedData &&
        (
          cachedData.companyName ||
          cachedData.companyNationalId ||
          cachedData.address ||
          cachedData.managerName
        ) &&
        !cachedString.includes("Ã") &&
        !cachedString.includes("Â") &&
        !cachedString.includes("�");

      if (cacheLooksValid) {
        return {
          ...cachedData,
          cached: true
        };
      }

      console.warn("Ignoring invalid/empty/bad-encoding cached company data:", cacheKey);
    }
  }

  const skatturUrl = `https://api.skattur.cloud/legalentities/v2.1/${nationalId}?language=is`;

  const response = await fetch(skatturUrl, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Ocp-Apim-Subscription-Key": env.SKATTUR_API_KEY
    }
  });

  const responseText = await response.text();

  let rawData;

  try {
    rawData = JSON.parse(responseText);
  } catch (error) {
    rawData = responseText;
  }

  rawData = fixAllStrings(rawData);

  if (debug) {
    return {
      debug: true,
      requestUrl: skatturUrl,
      status: response.status,
      ok: response.ok,
      originalResponsePreview: responseText.slice(0, 1000),
      responseBody: rawData
    };
  }

  if (!response.ok) {
    throw new Error(
      `Skatturinn returned ${response.status}: ${responseText.slice(0, 500)}`
    );
  }

  if (!rawData || typeof rawData !== "object") {
    throw new Error("Skatturinn response was not a JSON object");
  }

  const cleaned = cleanCompanyResponse(rawData);

  const finalResult = fixAllStrings({
    ...cleaned,
    fetchedAt: new Date().toISOString(),
    cached: false
  });

  const shouldCache =
    finalResult.companyName ||
    finalResult.companyNationalId ||
    finalResult.address ||
    finalResult.managerName;

  if (!noCache && env.COMPANY_CACHE && shouldCache) {
    await env.COMPANY_CACHE.put(
      cacheKey,
      JSON.stringify(finalResult),
      {
        httpMetadata: {
          contentType: "application/json; charset=utf-8"
        }
      }
    );
  }

  return finalResult;
}

function getAny(obj, keys) {
  if (!obj) return "";

  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) {
      return obj[key];
    }
  }

  return "";
}

function fixAllStrings(value) {
  if (typeof value === "string") {
    return fixIcelandicText(value);
  }

  if (Array.isArray(value)) {
    return value.map(fixAllStrings);
  }

  if (value && typeof value === "object") {
    const fixed = {};

    for (const [key, val] of Object.entries(value)) {
      fixed[key] = fixAllStrings(val);
    }

    return fixed;
  }

  return value;
}

function fixIcelandicText(value) {
  if (value === null || value === undefined) return "";

  let text = String(value);

  /*
    Lightweight Icelandic mojibake repair: UTF-8 read as Windows-1252, e.g.
    "ÃžingholtsstrÃ¦ti" -> "Þingholtsstræti".
    Written as escapes because several of the broken forms contain invisible
    control characters that do not survive copy and paste.
    The two-character forms run before the lone "Â" removal.
  */

  const replacements = [
    ["Ã¡", "á"],
    ["Ã\u0081", "Á"],
    ["Ã©", "é"],
    ["Ã‰", "É"],
    ["Ã­", "í"],
    ["Ã\u008D", "Í"],
    ["Ã³", "ó"],
    ["Ã“", "Ó"],
    ["Ãº", "ú"],
    ["Ãš", "Ú"],
    ["Ã½", "ý"],
    ["Ã\u009D", "Ý"],
    ["Ã¦", "æ"],
    ["Ã†", "Æ"],
    ["Ã¶", "ö"],
    ["Ã–", "Ö"],
    ["Ã°", "ð"],
    ["Ã\u0090", "Ð"],
    ["Ã¾", "þ"],
    ["Ãž", "Þ"],
    ["Â", ""]
  ];

  for (const [bad, good] of replacements) {
    text = text.split(bad).join(good);
  }

  return text;
}

function cleanCompanyResponse(data) {
  const companyName = fixIcelandicText(getAny(data, ["name", "Name"]));
  const companyNationalId = getAny(data, ["nationalId", "NationalId"]);

  const addresses = getAny(data, ["addresses", "Addresses"]) || [];
  const relationships = getAny(data, ["relationships", "Relationships"]) || [];

  const address = pickBestAddress(addresses);
  const manager = pickManager(relationships);

  const managerName = fixIcelandicText(getAny(manager, ["name", "Name"]));
  const managerNameParts = splitName(managerName);

  return {
    companyName,
    companyNationalId,

    address: fixIcelandicText(getAny(address, ["addressName", "AddressName"])),
    postcode: String(getAny(address, ["postcode", "Postcode"]) || ""),
    city: fixIcelandicText(getAny(address, ["city", "City"])),

    managerName,
    managerFirstName: managerNameParts.firstName,
    managerLastName: managerNameParts.lastName,
    managerNationalId: getAny(manager, ["nationalId", "NationalId"]),
    managerPosition: fixIcelandicText(
      getAny(manager, ["position", "Position"]) ||
      getAny(manager, ["type", "Type"])
    ),
    managerStatus: fixIcelandicText(getAny(manager, ["status", "Status"])),

    rawRelationshipType: fixIcelandicText(getAny(manager, ["type", "Type"])),
    rawRelationshipPosition: fixIcelandicText(getAny(manager, ["position", "Position"])),

    signers: pickSigners(relationships)
  };
}

function pickBestAddress(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    return {};
  }

  const legalAddress = addresses.find(a => {
    const type = normalizeText(fixIcelandicText(getAny(a, ["type", "Type"])));
    const countryCode = String(getAny(a, ["countryCode", "CountryCode"]) || "").toUpperCase();
    const isPostbox = Boolean(getAny(a, ["isPostbox", "IsPostbox"]));

    return (
      !isPostbox &&
      countryCode === "IS" &&
      type.includes("logheimilisfang")
    );
  });

  if (legalAddress) return legalAddress;

  const icelandicNormalAddress = addresses.find(a => {
    const countryCode = String(getAny(a, ["countryCode", "CountryCode"]) || "").toUpperCase();
    const isPostbox = Boolean(getAny(a, ["isPostbox", "IsPostbox"]));

    return !isPostbox && countryCode === "IS";
  });

  if (icelandicNormalAddress) return icelandicNormalAddress;

  const normalAddress = addresses.find(a => !Boolean(getAny(a, ["isPostbox", "IsPostbox"])));

  if (normalAddress) return normalAddress;

  return addresses[0] || {};
}

function pickManager(relationships) {
  if (!Array.isArray(relationships) || relationships.length === 0) {
    return {};
  }

  const manager = relationships.find(r => {
    const type = normalizeText(fixIcelandicText(getAny(r, ["type", "Type"])));
    const position = normalizeText(fixIcelandicText(getAny(r, ["position", "Position"])));
    const combined = `${type} ${position}`;

    return (
      combined.includes("framkvaemdastjorn") ||
      combined.includes("framkvaemdastjori")
    );
  });

  if (manager) return manager;

  const procuration = relationships.find(r => {
    const type = normalizeText(fixIcelandicText(getAny(r, ["type", "Type"])));
    const position = normalizeText(fixIcelandicText(getAny(r, ["position", "Position"])));
    const combined = `${type} ${position}`;

    return combined.includes("prokura");
  });

  if (procuration) return procuration;

  const board = relationships.find(r => {
    const type = normalizeText(fixIcelandicText(getAny(r, ["type", "Type"])));
    const position = normalizeText(fixIcelandicText(getAny(r, ["position", "Position"])));
    const combined = `${type} ${position}`;

    return combined.includes("stjorn");
  });

  return board || relationships[0] || {};
}

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

function splitName(fullName) {
  const parts = String(fullName || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) {
    return {
      firstName: "",
      lastName: ""
    };
  }

  if (parts.length === 1) {
    return {
      firstName: parts[0],
      lastName: ""
    };
  }

  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" ")
  };
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[áàâä]/g, "a")
    .replace(/[éèêë]/g, "e")
    .replace(/[íìîï]/g, "i")
    .replace(/[óòôö]/g, "o")
    .replace(/[úùûü]/g, "u")
    .replace(/[ýÿ]/g, "y")
    .replace(/þ/g, "th")
    .replace(/ð/g, "d")
    .replace(/æ/g, "ae")
    .replace(/ö/g, "o")
    .replace(/\s+/g, " ")
    .trim();
}
