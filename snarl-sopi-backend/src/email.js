/**
 * Email service — sends transactional emails via SendGrid.
 *
 * Configured via environment variables (set in Railway):
 *   SENDGRID_API_KEY  — API key with Mail Send permissions
 *   EMAIL_FROM        — verified sender address (e.g. hallo@snarlogsopi.is)
 *   EMAIL_FROM_NAME   — display name (e.g. "Snarl & Sopi")
 *   APP_URL           — base URL for invite links (e.g. https://snarl-sopi-production.up.railway.app)
 *
 * If SENDGRID_API_KEY is missing, the service logs emails to console instead.
 * This lets local dev work without SendGrid set up.
 */

const FROM_EMAIL  = process.env.EMAIL_FROM      || 'hallo@snarlogsopi.is';
const FROM_NAME   = process.env.EMAIL_FROM_NAME || 'AG Vending';
// Operator-facing mail is branded AG Vending; end-customer mail (complaint
// replies) keeps the consumer brand, Snarl & Sopi.
const OPERATOR_BRAND = 'AG Vending';
const CONSUMER_BRAND = 'Snarl & Sopi';
const APP_URL     = process.env.APP_URL         || 'https://snarl-sopi-production.up.railway.app';
const API_KEY     = process.env.SENDGRID_API_KEY;

let sgMail = null;

// Try to load SendGrid only if API key is configured
if (API_KEY) {
  try {
    sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(API_KEY);
    console.log('[EMAIL] SendGrid configured, sender:', FROM_EMAIL);
  } catch (e) {
    console.warn('[EMAIL] @sendgrid/mail not installed — emails will log to console');
    console.warn('[EMAIL]   Run: npm install @sendgrid/mail');
  }
} else {
  console.log('[EMAIL] SENDGRID_API_KEY not set — emails will log to console (dev mode)');
}

/**
 * Send an email. Falls back to console.log if SendGrid is not configured,
 * so the rest of the app works in development without email setup.
 */
async function send({ to, subject, text, html, fromName }) {
  if (!sgMail) {
    console.log('\n──── [EMAIL DEV MODE] ────────────────────────');
    console.log('To:     ', to);
    console.log('From:   ', `${fromName || FROM_NAME} <${FROM_EMAIL}>`);
    console.log('Subject:', subject);
    console.log('Text:\n', text);
    console.log('──────────────────────────────────────────────\n');
    return { mocked: true };
  }
  try {
    const msg = {
      to,
      from: { email: FROM_EMAIL, name: fromName || FROM_NAME },
      subject, text, html,
    };
    // Never let a slow/hung SendGrid call hold a request open — cap it and surface a clear
    // error instead. Without this, a stalled email API keeps the HTTP request open until
    // the platform edge times out and returns a 502.
    const SEND_TIMEOUT_MS = 12000;
    const [response] = await Promise.race([
      sgMail.send(msg),
      new Promise((_, reject) => setTimeout(() => reject(new Error('email send timed out after ' + SEND_TIMEOUT_MS + 'ms')), SEND_TIMEOUT_MS)),
    ]);
    console.log(`[EMAIL] sent to ${to} — status ${response.statusCode}`);
    return { mocked: false, statusCode: response.statusCode };
  } catch (err) {
    console.error('[EMAIL] failed:', err.message);
    if (err.response) console.error('[EMAIL]', err.response.body);
    throw err;
  }
}

// ─── Templated emails ─────────────────────────────────────────────────────────

/**
 * Send an invitation email to a new user.
 */
async function sendInvitation({ to, name, inviterName, operatorName, role, inviteToken }) {
  const link    = `${APP_URL}/?invite=${inviteToken}`;
  const subject = `${inviterName} hefur boðið þér aðgang að AG Vending`;

  const text = `Hæ ${name},

${inviterName} hefur boðið þér aðgang að rekstri ${operatorName} hjá AG Vending.
Þú hefur fengið hlutverkið: ${roleLabel(role)}.

Til að virkja aðganginn þinn og setja lykilorð, smelltu á tengilinn:

${link}

Tengillinn er gildur í 7 daga.

Ef þú átt ekki von á þessum tölvupósti getur þú hunsað hann.

Bestu kveðjur,
${OPERATOR_BRAND}`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#E8DFD0;color:#1A1A1A;line-height:1.6;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#E8DFD0;padding:32px 16px;">
  <tr><td align="center">
    <table width="100%" style="max-width:520px;background:#FAF7F2;border:.5px solid #E8E2D8;border-radius:16px;padding:36px 32px;">
      <tr><td>
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-weight:700;font-size:26px;letter-spacing:-.5px;margin-bottom:4px;">AG Vending</div>
        <div style="font-family:monospace;font-size:9px;letter-spacing:1.4px;text-transform:uppercase;color:#8A8275;margin-bottom:28px;">Operator portal</div>

        <p style="margin:0 0 16px;">Hæ <strong>${escapeHtml(name)}</strong>,</p>
        <p style="margin:0 0 16px;"><strong>${escapeHtml(inviterName)}</strong> hefur boðið þér aðgang að rekstri <strong>${escapeHtml(operatorName)}</strong> hjá AG Vending.</p>
        <p style="margin:0 0 24px;">Þú hefur fengið hlutverkið: <span style="display:inline-block;padding:3px 10px;border-radius:999px;background:#F7F0E6;color:#8B6B3E;font-family:monospace;font-size:11px;">${escapeHtml(roleLabel(role))}</span></p>

        <table cellpadding="0" cellspacing="0" style="margin:24px 0;">
          <tr><td style="background:#1A1A1A;border-radius:999px;">
            <a href="${escapeHtml(link)}" style="display:inline-block;color:#FAF7F2;text-decoration:none;padding:12px 28px;font-size:14px;font-weight:500;">Virkja aðgang &nbsp;→</a>
          </td></tr>
        </table>

        <p style="margin:0 0 8px;font-size:13px;color:#6B6B6B;">Tengillinn er gildur í 7 daga.</p>
        <p style="margin:0 0 16px;font-size:11px;color:#8A8275;word-break:break-all;">${escapeHtml(link)}</p>

        <hr style="border:none;border-top:.5px solid #E8E2D8;margin:24px 0;">
        <p style="margin:0;font-size:11px;color:#8A8275;">Ef þú átt ekki von á þessum tölvupósti getur þú hunsað hann.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  return send({ to, subject, text, html, fromName: OPERATOR_BRAND });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function roleLabel(role) {
  return {
    ag_admin:         'AG Vending stjórnandi',
    operator_admin:   'Rekstrar stjórnandi',
    operator_manager: 'Rekstrar umsjónamaður',
    operator_viewer:  'Áhorfandi',
  }[role] || role;
}

// Fridge complaints have their own shape (reason + basket lines, no tradeNo/totalIsk) and, for a
// cooling fault, the operator's first question is "how cold is it right now?" — so we include the
// latest reported cabinet temperature and how old that reading is.
async function sendFridgeComplaintToOperator({ to, operatorName, machineName, deviceCode, complaint, temp, dashboardUrl }) {
  const REASON_IS = {
    not_taken: 'Vara kom ekki', wrong_quantity: 'Rangt magn', returned_but_charged: 'Skilað en rukkað',
    expired_product: 'Útrunnin vara', cooling_fault: 'Kæling ekki í lagi', other: 'Annað',
  };
  const reasonLabel = REASON_IS[complaint.reason] || complaint.reason;
  const isCooling = complaint.reason === 'cooling_fault';
  const subject = (isCooling ? 'ÁRÍÐANDI: ' : '') + `Kvörtun — ${machineName} — ${reasonLabel}`;
  const time = new Date(complaint.timestampMs).toLocaleString('is-IS', { timeZone: 'Atlantic/Reykjavik' });

  // Temperature spot reading
  let tempText = 'Engin hitamæling til staðar.';
  let tempHtml = '<div style="color:#8A8275">Engin hitamæling til staðar.</div>';
  if (temp && temp.tempC != null) {
    const ageMin = temp.atMs ? Math.round((Date.now() - temp.atMs) / 60000) : null;
    const ageTxt = ageMin == null ? 'óþekktur tími' : (ageMin < 1 ? 'rétt í þessu' : ageMin + ' mín gömul');
    const hot = temp.tempC > (temp.maxC != null ? temp.maxC : 8);
    tempText = `Hiti í skáp: ${temp.tempC}°C (mæling ${ageTxt}${temp.maxC != null ? `, hámark ${temp.maxC}°C` : ''})${hot ? ' — YFIR MÖRKUM' : ''}`;
    tempHtml = `<div style="font-family:monospace;font-size:22px;color:${hot ? '#B8471F' : '#4A7C59'}">${temp.tempC}°C${hot ? ' ⚠' : ''}</div>` +
      `<div style="font-size:12px;color:#8A8275;margin-top:2px">mæling ${escapeHtml(ageTxt)}${temp.maxC != null ? `, hámark ${temp.maxC}°C` : ''}</div>`;
  }

  const linesText = (complaint.lines || []).map(l =>
    `  • hólf ${l.cabinet ? l.cabinet + '/' : ''}${l.basket}${l.quantity != null ? ` — ${l.quantity} stk` : ''}${l.lineIsk != null ? ` — ${l.lineIsk} kr` : ''}`
  ).join('\n');
  const linesHtml = (complaint.lines || []).map(l =>
    `<tr><td style="padding:6px 0;border-bottom:.5px solid #E8E2D8">hólf ${escapeHtml(String((l.cabinet ? l.cabinet + '/' : '') + l.basket))}</td>` +
    `<td style="padding:6px 0;border-bottom:.5px solid #E8E2D8;text-align:right;font-family:monospace;font-size:12px">${l.lineIsk != null ? l.lineIsk + ' kr' : '—'}</td></tr>`
  ).join('');

  const text = `${isCooling ? 'ÁRÍÐANDI — kæling ekki í lagi\n\n' : ''}Kvörtun — ${operatorName}

Vél: ${machineName} (${deviceCode})
Ástæða: ${reasonLabel}
Tími: ${time}
Pöntun: ${complaint.orderId}
${complaint.customerEmail ? `Tölvupóstur viðskiptavinar: ${complaint.customerEmail}\n` : ''}
${tempText}

Hólf:
${linesText}

${complaint.note ? `Athugasemd viðskiptavinar:\n"${complaint.note}"\n\n` : ''}${isCooling ? 'Aðgerð: athugið hitastig skápsins og nýleg gögn strax. Íhugið að loka fyrir sölu þar til staðfest er.\n\n' : ''}Sjá kvörtunina:
${dashboardUrl}

— ${OPERATOR_BRAND}`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#E8DFD0;color:#1A1A1A;line-height:1.6;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#E8DFD0;padding:32px 16px;"><tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FAF7F2;border-radius:14px;padding:26px;">
  ${isCooling ? '<tr><td style="background:#B8471F;color:#fff;padding:10px 14px;border-radius:8px;font-weight:600;font-size:14px">ÁRÍÐANDI — kæling ekki í lagi</td></tr><tr><td style="height:16px"></td></tr>' : ''}
  <tr><td>
    <div style="font-size:20px;font-weight:600">${escapeHtml(reasonLabel)}</div>
    <div style="font-size:13px;color:#8A8275;margin-top:3px">${escapeHtml(machineName)} · ${escapeHtml(deviceCode)} · ${escapeHtml(time)}</div>
  </td></tr>
  <tr><td style="padding:18px 0 6px">
    <div style="background:#F0E8DA;border-radius:10px;padding:14px">
      <div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#8A8275;font-family:monospace">hiti í skáp núna</div>
      ${tempHtml}
    </div>
  </td></tr>
  <tr><td style="padding:10px 0 0">
    <table width="100%" cellpadding="0" cellspacing="0" style="font-size:13px">${linesHtml}</table>
  </td></tr>
  ${complaint.note ? `<tr><td style="padding:14px 0 0"><div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#8A8275;font-family:monospace">athugasemd</div><div style="font-style:italic">${escapeHtml(complaint.note)}</div></td></tr>` : ''}
  ${complaint.customerEmail ? `<tr><td style="padding:12px 0 0;font-size:12px;color:#8A8275">Viðskiptavinur: ${escapeHtml(complaint.customerEmail)}</td></tr>` : ''}
  <tr><td style="padding:20px 0 0">
    <a href="${dashboardUrl}" style="display:inline-block;background:#1A1A1A;color:#FAF7F2;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14px">Opna kvörtunina</a>
  </td></tr>
  <tr><td style="padding:20px 0 0;font-size:11px;color:#8A8275">— ${OPERATOR_BRAND}</td></tr>
</table></td></tr></table></body></html>`;

  return send({ to, subject, text, html });
}

// The kiosk tells the customer "we will reply by email", so when they leave an address we
// acknowledge it immediately. Deliberately makes no promise about timing or outcome — the
// operator's real reply follows via sendComplaintReplyToCustomer.
async function sendComplaintAckToCustomer({ to, operatorName, machineName, reason }) {
  const REASON_IS = {
    not_taken: 'vara kom ekki', wrong_quantity: 'rangt magn', returned_but_charged: 'skilað en rukkað',
    expired_product: 'útrunnin vara', cooling_fault: 'kæling ekki í lagi', other: 'annað',
  };
  const reasonLine = reason ? (REASON_IS[reason] || reason) : null;
  const subject = `Við höfum móttekið ábendingu þína — ${machineName}`;

  const text = `Hæ,

Takk fyrir að láta okkur vita. Við höfum móttekið ábendingu þína um ${machineName}${reasonLine ? ` (${reasonLine})` : ''} og skoðum málið.

Þú færð svar á þetta netfang.

Bestu kveðjur,
${operatorName}

— Snarl & Sopi`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#E8DFD0;color:#1A1A1A;line-height:1.65;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#E8DFD0;padding:32px 16px;">
  <tr><td align="center">
    <table width="100%" style="max-width:520px;background:#FAF7F2;border:.5px solid #E8E2D8;border-radius:16px;padding:32px 28px;">
      <tr><td>
        <div style="font-family:Georgia,serif;font-style:italic;font-weight:500;font-size:22px;letter-spacing:-.3px;margin-bottom:4px;">Snarl &amp; Sopi</div>
        <div style="font-family:monospace;font-size:9px;letter-spacing:1.4px;text-transform:uppercase;color:#8A8275;margin-bottom:24px;">ábending móttekin</div>
        <div style="font-size:15px">Takk fyrir að láta okkur vita.</div>
        <div style="font-size:15px;margin-top:10px">Við höfum móttekið ábendingu þína um <b>${escapeHtml(machineName)}</b>${reasonLine ? ` (${escapeHtml(reasonLine)})` : ''} og skoðum málið. Þú færð svar á þetta netfang.</div>
        <div style="margin-top:22px;padding-top:16px;border-top:.5px solid #E8E2D8;font-size:13px;color:#8A8275">Bestu kveðjur,<br>${escapeHtml(operatorName)}</div>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;

  return send({ to, subject, text, html });
}

// A plain operator-facing alert email, used for money-path signals (settlement mismatch and
// anything else where the operator needs to know now, not on next dashboard visit).
async function sendOperatorAlert({ to, operatorName, title, detail, dashboardUrl }) {
  const subject = `ÁRÍÐANDI: ${title}`;
  const text = `${title}

${detail}

${dashboardUrl}

— ${OPERATOR_BRAND}`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#E8DFD0;color:#1A1A1A;line-height:1.6;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#E8DFD0;padding:32px 16px;"><tr><td align="center">
<table width="100%" style="max-width:520px;background:#FAF7F2;border-radius:14px;padding:26px;">
  <tr><td style="background:#B8471F;color:#fff;padding:10px 14px;border-radius:8px;font-weight:600;font-size:14px">${escapeHtml(title)}</td></tr>
  <tr><td style="padding:18px 0 0;font-size:14px">${escapeHtml(detail)}</td></tr>
  <tr><td style="padding:20px 0 0"><a href="${dashboardUrl}" style="display:inline-block;background:#1A1A1A;color:#FAF7F2;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:14px">Opna í stjórnborði</a></td></tr>
  <tr><td style="padding:18px 0 0;font-size:11px;color:#8A8275">${escapeHtml(operatorName)} — ${OPERATOR_BRAND}</td></tr>
</table></td></tr></table></body></html>`;
  return send({ to, subject, text, html });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

module.exports = { send, sendInvitation, sendComplaintToOperator, sendFridgeComplaintToOperator, sendComplaintAckToCustomer, sendComplaintReplyToCustomer, sendOperatorAlert };

// ─── Complaint emails ─────────────────────────────────────────────────────────

/**
 * Notify the operator that a customer has filed a complaint.
 * Sent immediately when the kiosk submits a complaint.
 */
async function sendComplaintToOperator({ to, operatorName, machineName, deviceCode, complaint, dashboardUrl }) {
  const subject = `Ný kvörtun — ${machineName} (${complaint.items.length} ${complaint.items.length === 1 ? 'vara' : 'vörur'})`;

  const itemsText = complaint.items.map(i => `  • ${i.name} — ${i.priceIsk} kr`).join('\n');
  const itemsHtml = complaint.items.map(i =>
    `<tr><td style="padding:6px 0;border-bottom:.5px solid #E8E2D8">${escapeHtml(i.name)}</td>` +
    `<td style="padding:6px 0;border-bottom:.5px solid #E8E2D8;text-align:right;font-family:monospace;font-size:12px">${i.priceIsk} kr</td></tr>`
  ).join('');

  const time = new Date(complaint.timestampMs).toLocaleString('is-IS', { timeZone: 'Atlantic/Reykjavik' });

  const text = `Ný kvörtun — ${operatorName}

Vél: ${machineName} (${deviceCode})
Tími: ${time}
Færslunúmer: ${complaint.tradeNo}
Tölvupóstur viðskiptavinar: ${complaint.customerEmail}
Heildarupphæð: ${complaint.totalIsk} kr

Vörur sem komu ekki út:
${itemsText}

${complaint.note ? `Athugasemd viðskiptavinar:\n"${complaint.note}"\n\n` : ''}Til að sjá og svara kvörtuninni:
${dashboardUrl}

— ${OPERATOR_BRAND}`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#E8DFD0;color:#1A1A1A;line-height:1.6;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#E8DFD0;padding:32px 16px;">
  <tr><td align="center">
    <table width="100%" style="max-width:560px;background:#FAF7F2;border:.5px solid #E8E2D8;border-radius:16px;padding:32px 28px;">
      <tr><td>
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-weight:700;font-size:24px;letter-spacing:-.5px;margin-bottom:4px;">AG Vending</div>
        <div style="font-family:monospace;font-size:9px;letter-spacing:1.4px;text-transform:uppercase;color:#8A8275;margin-bottom:22px;">ný kvörtun</div>

        <div style="background:#FBF1E8;border-left:3px solid #B8471F;padding:12px 14px;border-radius:6px;margin-bottom:20px">
          <div style="font-size:13px;color:#8B6B3E;text-transform:uppercase;letter-spacing:.5px;margin-bottom:3px;font-family:monospace;font-size:10px">vél</div>
          <div style="font-size:16px;font-weight:600">${escapeHtml(machineName)}</div>
          <div style="font-family:monospace;font-size:11px;color:#8A8275;margin-top:2px">${escapeHtml(deviceCode)}</div>
        </div>

        <p style="margin:0 0 6px;font-size:13px;color:#6B6B6B">Vörur sem komu ekki út:</p>
        <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:16px;font-size:13px">
          ${itemsHtml}
          <tr><td style="padding-top:8px;font-weight:600">Heildarupphæð</td><td style="padding-top:8px;font-family:monospace;font-weight:600;text-align:right">${complaint.totalIsk} kr</td></tr>
        </table>

        ${complaint.note ? `
        <div style="background:#F7F0E6;padding:14px 16px;border-radius:8px;margin-bottom:20px">
          <div style="font-family:monospace;font-size:10px;color:#8A8275;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">athugasemd viðskiptavinar</div>
          <div style="font-style:italic;font-size:14px">"${escapeHtml(complaint.note)}"</div>
        </div>` : ''}

        <table style="width:100%;font-size:12px;color:#6B6B6B;margin-bottom:24px">
          <tr><td style="padding:4px 0;width:40%">Tími</td><td style="padding:4px 0;font-family:monospace">${escapeHtml(time)}</td></tr>
          <tr><td style="padding:4px 0">Færslunúmer</td><td style="padding:4px 0;font-family:monospace;font-size:11px">${escapeHtml(complaint.tradeNo)}</td></tr>
          <tr><td style="padding:4px 0">Viðskiptavinur</td><td style="padding:4px 0"><a href="mailto:${escapeHtml(complaint.customerEmail)}" style="color:#8B6B3E;text-decoration:none">${escapeHtml(complaint.customerEmail)}</a></td></tr>
        </table>

        <table cellpadding="0" cellspacing="0">
          <tr><td style="background:#1A1A1A;border-radius:999px;">
            <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;color:#FAF7F2;text-decoration:none;padding:11px 26px;font-size:13px;font-weight:500;">Sjá og svara &nbsp;→</a>
          </td></tr>
        </table>

        <hr style="border:none;border-top:.5px solid #E8E2D8;margin:24px 0;">
        <p style="margin:0;font-size:11px;color:#8A8275">Þú getur svarað viðskiptavininum beint úr stjórnborðinu og/eða endurgreitt færsluna.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  return send({ to, subject, text, html, fromName: OPERATOR_BRAND });
}

/**
 * Send the operator's reply to the customer.
 */
async function sendComplaintReplyToCustomer({ to, operatorName, machineName, replyText, refundedAmount }) {
  const subject = `Svar við kvörtun þinni — ${machineName}`;

  const refundLine = refundedAmount
    ? `\n${refundedAmount} kr hafa verið endurgreiddir á kortið þitt.\n`
    : '';

  const text = `Hæ,

${replyText}
${refundLine}
Bestu kveðjur,
${operatorName}

— Þetta er svar í gegnum Snarl & Sopi`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#E8DFD0;color:#1A1A1A;line-height:1.65;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#E8DFD0;padding:32px 16px;">
  <tr><td align="center">
    <table width="100%" style="max-width:520px;background:#FAF7F2;border:.5px solid #E8E2D8;border-radius:16px;padding:32px 28px;">
      <tr><td>
        <div style="font-family:Georgia,serif;font-style:italic;font-weight:500;font-size:22px;letter-spacing:-.3px;margin-bottom:4px;">Snarl &amp; Sopi</div>
        <div style="font-family:monospace;font-size:9px;letter-spacing:1.4px;text-transform:uppercase;color:#8A8275;margin-bottom:24px;">svar frá rekstraraðila</div>

        <p style="margin:0 0 16px;white-space:pre-wrap;font-size:14px">${escapeHtml(replyText)}</p>

        ${refundedAmount ? `
        <div style="background:#EFF4E8;border-left:3px solid #4A6B2E;padding:12px 14px;border-radius:6px;margin:16px 0;font-size:13px">
          <strong>${refundedAmount} kr</strong> hafa verið endurgreiddir á kortið þitt.
        </div>` : ''}

        <hr style="border:none;border-top:.5px solid #E8E2D8;margin:24px 0;">
        <p style="margin:0;font-size:12px;color:#6B6B6B">Bestu kveðjur,<br><strong>${escapeHtml(operatorName)}</strong></p>
        <p style="margin:12px 0 0;font-size:10px;color:#8A8275">Þetta er svar við kvörtun um vél: ${escapeHtml(machineName)}</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  return send({ to, subject, text, html, fromName: CONSUMER_BRAND });
}
