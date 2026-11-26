// Launch Day bookings: emails the booking to Cyclone's ops team (with the importer file attached)
// and sends the client a confirmation. Runs on Vercel as /api/launch-booking.
//
// Settings in Vercel (Project > Settings > Environment Variables):
//   RESEND_API_KEY   required: the key from resend.com
//   LAUNCH_DAY_TO    optional: who bookings go to (default joepleass@cyclone.ie)
//   LAUNCH_DAY_CC    optional: who is copied in (default ops@cyclone.ie); several addresses can be
//                    separated by commas
//   LAUNCH_DAY_FROM  optional: the sender, once cyclone.ie is verified in Resend,
//                    e.g. "Cyclone Launch Day <launchday@cyclone.ie>"
//                    (until then Resend's test sender is used, which can only email
//                    the address the Resend account was opened with, so the copy to ops
//                    is held back until the domain is verified)

const list = (v) => String(v || '').split(',').map((a) => a.trim()).filter(Boolean);
const TO = list(process.env.LAUNCH_DAY_TO || 'joepleass@cyclone.ie');
const CC = list(process.env.LAUNCH_DAY_CC || 'ops@cyclone.ie');
const FROM = process.env.LAUNCH_DAY_FROM || 'Cyclone Launch Day <onboarding@resend.dev>';
const DOMAIN_VERIFIED = !!process.env.LAUNCH_DAY_FROM;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const euro = (n) => '€' + Number(n || 0).toFixed(2);

async function send(email) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(email),
  });
  if (!r.ok) throw new Error('Email service said ' + r.status + ': ' + (await r.text()).slice(0, 300));
  return r.json();
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Use POST' }); return; }
  if (!process.env.RESEND_API_KEY) { res.status(500).json({ ok: false, error: 'Email sending is not set up yet (RESEND_API_KEY missing).' }); return; }

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
  if (!b || typeof b !== 'object') { res.status(400).json({ ok: false, error: 'No booking received.' }); return; }
  // spam check: a real person takes minutes to fill in the form, a robot a second or two.
  // A suspicious booking still goes through, with a note in the subject, so nothing is ever lost.
  const flagged = typeof b.elapsed === 'number' && b.elapsed < 8000;

  const rows = Array.isArray(b.rows) ? b.rows.slice(0, 500) : [];
  const email = String(b.email || '').trim();
  if (!b.campaign || !rows.length || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ ok: false, error: 'The booking is missing the campaign name, the list, or a valid email address.' });
    return;
  }

  const product = b.product === 'christmas' ? 'Christmas gifts' : 'Launch Day';
  const ref = (b.product === 'christmas' ? 'XM-' : 'LD-') + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  const q = b.quote || {};
  const listRows = rows.map((r, i) =>
    `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${esc(r.company)}</td><td>${esc([r.a1, r.a2, r.town, r.county].filter(Boolean).join(', '))}</td><td>${esc(r.eircode)}</td><td>${esc(r.phone)}</td><td>${esc(r.area)}</td></tr>`
  ).join('');

  const opsHtml = `
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111">
    <h2 style="margin:0 0 4px">New ${product} booking: ${esc(b.campaign)}</h2>
    <p style="margin:0 0 16px;color:#555">Reference ${ref}. The importer file is attached.</p>
    <table cellpadding="4" style="border-collapse:collapse;margin-bottom:16px">
      <tr><td><b>Client</b></td><td>${esc(b.contactName)} &lt;${esc(email)}&gt;</td></tr>
      <tr><td><b>For their client</b></td><td>${esc(b.client || '—')}</td></tr>
      <tr><td><b>Launch day</b></td><td>${esc(b.dateText)}, ${esc(b.window)}</td></tr>
      <tr><td><b>Collect from</b></td><td>${esc(b.collect)}</td></tr>
      <tr><td><b>Deliveries</b></td><td>${rows.length} (${esc(q.dublin)} Dublin, ${esc(q.ireland)} elsewhere)</td></tr>
      <tr><td><b>Packages</b></td><td>${esc(b.pack)}, ${esc(b.perPerson)} per person</td></tr>
      <tr><td><b>What's inside</b></td><td>${esc(b.contents || 'Not given')}</td></tr>
      ${b.quoted ? `<tr><td><b>Number quoted</b></td><td>${esc(b.quoted)}${Number(b.quoted) !== rows.length ? ' (list has ' + rows.length + ')' : ''}</td></tr>` : ''}
      <tr><td><b>Price</b></td><td>${rows.length} × ${euro(q.perDelivery)} = ${euro(q.net)} + VAT ${euro(q.vat)} = <b>${euro(q.gross)}</b></td></tr>
      <tr><td><b>Packing agreed</b></td><td>${b.packingAgreed ? 'Yes: packed for transport and labelled' : 'No'}</td></tr>
    </table>
    <table cellpadding="5" style="border-collapse:collapse;font-size:13px" border="1" bordercolor="#ddd">
      <tr style="background:#f4f4f4"><th>#</th><th>Name</th><th>Company</th><th>Address</th><th>Eircode</th><th>Phone</th><th>Area</th></tr>
      ${listRows}
    </table>
  </div>`;

  const attachments = [];
  if (b.importerFile) attachments.push({ filename: `${b.product === 'christmas' ? 'christmas' : 'launch-day'}-${ref}.xlsx`, content: b.importerFile });
  if (b.photo && /^data:image\/(jpeg|png|webp);base64,/.test(b.photo)) {
    const ext = b.photo.slice(11, b.photo.indexOf(';')).replace('jpeg', 'jpg');
    attachments.push({ filename: `pack-photo-${ref}.${ext}`, content: b.photo.split(',')[1] });
  }

  try {
    await send({ from: FROM, to: TO, ...(DOMAIN_VERIFIED && CC.length ? { cc: CC } : {}), reply_to: email, subject: `${flagged ? '[Check: possible spam] ' : ''}${product} booking ${ref}: ${b.campaign} (${rows.length} deliveries, ${b.dateText})`, html: opsHtml, attachments });
  } catch (e) {
    res.status(502).json({ ok: false, error: 'Your booking could not be sent. Please call 01 475 7000.', detail: String(e.message || e) });
    return;
  }

  // the client's confirmation: only possible once the cyclone.ie sender is verified in Resend
  let confirmed = false;
  if (DOMAIN_VERIFIED) {
    const clientHtml = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#111;max-width:560px">
      <h2 style="margin:0 0 8px">${b.product === 'christmas' ? 'Your Christmas deliveries are booked' : 'Your launch is booked'}: ${esc(b.campaign)}</h2>
      <p>Thanks${b.contactName ? ' ' + esc(String(b.contactName).split(' ')[0]) : ''}. We’ve received your list of ${rows.length} and our team will be in touch to confirm the details.</p>
      <p><b>${b.product === 'christmas' ? 'Delivery day' : 'Launch day'}:</b> ${esc(b.dateText)}, ${esc(b.window)}<br><b>Collect from:</b> ${esc(b.collect)}<br><b>Price:</b> ${euro(q.gross)} including VAT<br><b>Your reference:</b> ${ref}</p>
      <p>Please make sure every pack is packed for transport and labelled with the recipient’s name and address.</p>
      <p>Questions? Reply to this email or call us on 01 475 7000.</p>
      <p style="color:#777;font-size:13px">${product} by Cyclone. Argus House, Blackpitts, Dublin 8.</p>
    </div>`;
    try { await send({ from: FROM, to: [email], reply_to: CC[0] || TO[0], subject: `${b.product === 'christmas' ? 'Your Christmas deliveries are booked' : 'Your launch is booked'}: ${b.campaign} (${ref})`, html: clientHtml }); confirmed = true; } catch (e) { /* the booking itself went through */ }
  }

  res.status(200).json({ ok: true, ref, confirmed });
};
