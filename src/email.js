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

module.exports = { send, sendInvitation };
