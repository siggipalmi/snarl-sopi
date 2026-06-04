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
const FROM_NAME   = process.env.EMAIL_FROM_NAME || 'Snarl & Sopi';
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
async function send({ to, subject, text, html }) {
  if (!sgMail) {
    console.log('\n──── [EMAIL DEV MODE] ────────────────────────');
    console.log('To:     ', to);
    console.log('From:   ', FROM_EMAIL);
    console.log('Subject:', subject);
    console.log('Text:\n', text);
    console.log('──────────────────────────────────────────────\n');
    return { mocked: true };
  }
  try {
    const msg = {
      to,
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject, text, html,
    };
    const [response] = await sgMail.send(msg);
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
  const subject = `${inviterName} hefur boðið þér aðgang að Snarl & Sopi`;

  const text = `Hæ ${name},

${inviterName} hefur boðið þér aðgang að rekstri ${operatorName} hjá Snarl & Sopi.
Þú hefur fengið hlutverkið: ${roleLabel(role)}.

Til að virkja aðganginn þinn og setja lykilorð, smelltu á tengilinn:

${link}

Tengillinn er gildur í 7 daga.

Ef þú átt ekki von á þessum tölvupósti getur þú hunsað hann.

Bestu kveðjur,
${FROM_NAME}`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#E8DFD0;color:#1A1A1A;line-height:1.6;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#E8DFD0;padding:32px 16px;">
  <tr><td align="center">
    <table width="100%" style="max-width:520px;background:#FAF7F2;border:.5px solid #E8E2D8;border-radius:16px;padding:36px 32px;">
      <tr><td>
        <div style="font-family:Georgia,serif;font-style:italic;font-weight:500;font-size:26px;letter-spacing:-.3px;margin-bottom:4px;">Snarl &amp; Sopi</div>
        <div style="font-family:monospace;font-size:9px;letter-spacing:1.4px;text-transform:uppercase;color:#8A8275;margin-bottom:28px;">AG Vending · Operator</div>

        <p style="margin:0 0 16px;">Hæ <strong>${escapeHtml(name)}</strong>,</p>
        <p style="margin:0 0 16px;"><strong>${escapeHtml(inviterName)}</strong> hefur boðið þér aðgang að rekstri <strong>${escapeHtml(operatorName)}</strong> hjá Snarl &amp; Sopi.</p>
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

  return send({ to, subject, text, html });
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

module.exports = { send, sendInvitation, sendComplaintToOperator, sendComplaintReplyToCustomer };

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

— ${FROM_NAME}`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#E8DFD0;color:#1A1A1A;line-height:1.6;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#E8DFD0;padding:32px 16px;">
  <tr><td align="center">
    <table width="100%" style="max-width:560px;background:#FAF7F2;border:.5px solid #E8E2D8;border-radius:16px;padding:32px 28px;">
      <tr><td>
        <div style="font-family:Georgia,serif;font-style:italic;font-weight:500;font-size:24px;letter-spacing:-.3px;margin-bottom:4px;">Snarl &amp; Sopi</div>
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

  return send({ to, subject, text, html });
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

  return send({ to, subject, text, html, replyTo: undefined });
}
