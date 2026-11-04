/*
 * Cookie consent and the Meta Pixel, for agvending.is and skraning.agvending.is.
 *
 * ONE FILE, TWO COPIES: agvending-site/public/consent.js is the source;
 * skraning-site/public/consent.js must be byte-identical (copy it after any change).
 *
 * The rule this file exists to keep: NOTHING that tracks loads before the visitor says yes.
 * - The answer is a first-party cookie, ag_consent=granted|denied, on .agvending.is, so one
 *   answer covers both sites. It is the only cookie set without consent (it stores the
 *   consent itself, which is allowed). It lasts MAX_AGE_DAYS; then the banner asks again.
 *   Bump VERSION when a new tool is added, so everyone is asked again.
 * - Only "granted" loads Meta's script. "Hafna" never loads it, and a later "Hafna" revokes
 *   consent in the running pixel and deletes Meta's own cookies (_fbp, _fbc).
 * - Meta's <noscript> image tag is deliberately left out: it fires without asking.
 * - Pages fire events through window.agTrack(name, params), which does nothing without consent.
 * - Any element with data-consent-open (the footer's "Vafrakökur") shows the banner again.
 *
 * Banner text is Icelandic only, like the rest of the site.
 */
(function () {
  "use strict";
  var PIXEL_ID = "2152024368365405";
  var VERSION = "1";
  var MAX_AGE_DAYS = 182;
  var NAME = "ag_consent";
  var PRIVACY_URL = "https://agvending.is/personuvernd";

  var onAgDomain = /(^|\.)agvending\.is$/.test(location.hostname);
  var domainAttr = onAgDomain ? "; domain=.agvending.is" : "";

  function readConsent() {
    var m = document.cookie.match(new RegExp("(?:^|; )" + NAME + "=([^;]*)"));
    if (!m) return null;
    var parts = decodeURIComponent(m[1]).split(".");   // "granted.1"
    return parts[1] === VERSION && (parts[0] === "granted" || parts[0] === "denied") ? parts[0] : null;
  }
  function writeConsent(value) {
    document.cookie = NAME + "=" + value + "." + VERSION + "; max-age=" + MAX_AGE_DAYS * 86400 +
      "; path=/" + domainAttr + "; samesite=lax" + (location.protocol === "https:" ? "; secure" : "");
  }
  function deleteCookie(name) {
    var gone = name + "=; max-age=0; path=/";
    document.cookie = gone;
    if (onAgDomain) document.cookie = gone + "; domain=.agvending.is";
  }

  var pixelLoaded = false;
  function loadPixel() {
    if (pixelLoaded) { window.fbq("consent", "grant"); return; }
    pixelLoaded = true;
    /* Meta's own loader, unchanged apart from layout. */
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = "2.0"; n.queue = [];
      t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    }(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
    window.fbq("init", PIXEL_ID);
    window.fbq("track", "PageView");
  }

  window.agTrack = function (name, params) {
    if (readConsent() === "granted" && window.fbq) window.fbq("track", name, params || {});
  };

  var CSS =
    ".ag-consent{position:fixed;left:16px;right:16px;bottom:16px;z-index:1000;max-width:760px;margin:0 auto;" +
    "background:var(--paper,#fff);color:var(--ink,#111);border:3px solid var(--ink,#111);padding:24px;" +
    "font-family:inherit;font-size:15px;line-height:1.5;text-align:left}" +
    ".ag-consent[hidden]{display:none}" +
    ".ag-consent h2{font-family:inherit;font-size:20px;line-height:1.2;letter-spacing:-.2px;font-weight:900;margin:0 0 8px;" +
    "display:flex;gap:10px;align-items:center;text-transform:none}" +
    ".ag-consent h2::before{content:'';width:14px;height:14px;background:var(--accent,#FFC72C);flex:none}" +
    ".ag-consent p{margin:0 0 16px;color:var(--ink-soft,#555)}" +
    ".ag-consent p a{color:var(--ink,#111);font-weight:700;text-decoration:underline;text-decoration-color:var(--accent,#FFC72C);" +
    "text-decoration-thickness:3px;text-underline-offset:3px}" +
    ".ag-consent__actions{display:flex;flex-wrap:wrap;gap:12px}" +
    ".ag-consent button{min-width:150px;min-height:44px;padding:10px 20px;font-family:inherit;font-size:15px;font-weight:800;" +
    "border:2px solid var(--ink,#111);border-radius:0;cursor:pointer;background:var(--ink,#111);color:var(--paper,#fff)}" +
    ".ag-consent button.ag-consent__no{background:var(--paper,#fff);color:var(--ink,#111)}" +
    ".ag-consent button:hover{background:#333;border-color:#333;color:#fff}" +
    ".ag-consent button:focus-visible{outline:3px solid var(--accent,#FFC72C);outline-offset:2px}" +
    "@media (max-width:680px){.ag-consent{left:0;right:0;bottom:0;border-width:3px 0 0;padding:20px 16px}" +
    ".ag-consent button{flex:1 1 140px;min-width:0}}";

  var box;
  function showBanner() {
    if (!box) {
      var style = document.createElement("style");
      style.textContent = CSS;
      document.head.appendChild(style);
      box = document.createElement("section");
      box.className = "ag-consent";
      box.setAttribute("aria-label", "Vafrakökur");
      box.innerHTML =
        "<h2>Vafrakökur</h2>" +
        "<p>Við notum vafrakökur til að mæla umferð og birta auglýsingar frá Meta (Facebook og Instagram), " +
        "en aðeins ef þú samþykkir. Þú getur breytt valinu hvenær sem er neðst á síðunni. " +
        "<a href=\"" + PRIVACY_URL + "\">Persónuvernd</a></p>" +
        "<div class=\"ag-consent__actions\">" +
        "<button type=\"button\" class=\"ag-consent__yes\">Samþykkja</button>" +
        "<button type=\"button\" class=\"ag-consent__no\">Hafna</button></div>";
      box.querySelector(".ag-consent__yes").addEventListener("click", function () { decide("granted"); });
      box.querySelector(".ag-consent__no").addEventListener("click", function () { decide("denied"); });
      document.body.appendChild(box);
    }
    box.hidden = false;
  }

  function decide(value) {
    writeConsent(value);
    if (box) box.hidden = true;
    if (value === "granted") loadPixel();
    else {
      if (pixelLoaded && window.fbq) window.fbq("consent", "revoke");
      deleteCookie("_fbp"); deleteCookie("_fbc");
    }
  }

  function start() {
    var c = readConsent();
    if (c === "granted") loadPixel();
    else if (c === null) showBanner();
    document.addEventListener("click", function (e) {
      var t = e.target.closest && e.target.closest("[data-consent-open]");
      if (t) { e.preventDefault(); showBanner(); box.querySelector("button").focus(); }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
