// Vercel serverless function — Solar Business Scan
// 1. Creates contact in GHL via Contacts API (reliable, no Cloudflare issues)
// 2. Adds a note to the contact with full scan results + scores
// 3. Tags contact as solar-scan-lead (trigger your GHL workflow on this tag)
// 4. Sends full report email via Resend
//
// Required env vars in Vercel:
//   GHL_API_KEY      — GHL → Settings → Integrations → API Keys
//   GHL_LOCATION_ID  — segment after /location/ in your GHL dashboard URL
//   RESEND_API_KEY   — resend.com → verify flowbuildai.ie → API Keys

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;
const RESEND_API_KEY  = process.env.RESEND_API_KEY;
const BOOKING_URL     = 'https://links.flowbuildai.ie/widget/bookings/flowbuild-ai-strategy-session';

const CAT_LABELS = {
  speed:   'Speed to Lead',
  quote:   'Quote Follow-Up',
  booking: 'Survey Booking',
  calls:   'Missed Call Coverage',
  reviews: 'Reviews & Pipeline',
};

const CAT_ORDER = ['speed', 'quote', 'booking', 'calls', 'reviews'];

const NARRATIVES = {
  speed: {
    major:    "You're losing enquiries before your competitors even finish their morning coffee. Most Irish homeowners book with the first installer to respond — hours of delay is handing installs away.",
    moderate: "Your response time is inconsistent. On a good day you're quick, but evenings and weekends create gaps that competitors fill.",
    strong:   "Your speed to lead is solid. Small optimisations here could close the remaining gap entirely.",
  },
  quote: {
    major:    "Most of your sent quotes are going cold. Without a systematic follow-up process, you're leaving the majority of your pipeline to chance.",
    moderate: "You're following up, but not consistently or persistently enough. Research shows 5+ touchpoints recovers the majority of cold quotes.",
    strong:   "Your quote follow-up is working well. Automating it would free up time without losing effectiveness.",
  },
  booking: {
    major:    "Homeowners can't self-book instantly and no-shows are costing you site visits. Every scheduling friction loses you a potential install.",
    moderate: "Your booking process works but relies on back-and-forth. Automated self-booking and reminders would cut no-shows significantly.",
    strong:   "Survey booking is running smoothly. Reminders and confirmations could tighten it further.",
  },
  calls: {
    major:    "Missed calls after hours and on weekends are your biggest blind spot. You're invisible to homeowners at exactly the moments they decide to enquire.",
    moderate: "You're catching most calls, but evening and weekend gaps mean some enquiries go unanswered when intent is highest.",
    strong:   "Call coverage is good. 24/7 AI backup would eliminate the remaining missed opportunities.",
  },
  reviews: {
    major:    "You have no systematic process for Google reviews or pipeline visibility. You're invisible online and flying blind on your own data.",
    moderate: "You're getting some reviews but leaving most post-install opportunities on the table. A triggered review request would 3x your collection rate.",
    strong:   "Reviews and pipeline are tracking well. Full automation would make this consistent without any manual effort.",
  },
};

const CALLOUTS = {
  speed:   '→ AI Lead Response System — every enquiry contacted in under 60 seconds, 24/7',
  quote:   '→ Quote Recovery Engine — 5-touch automated follow-up on every cold quote',
  booking: '→ Admin Reduction System — self-book calendar link, automated confirmations & reminders',
  calls:   '→ 24/7 AI Receptionist — answers missed calls, qualifies homeowners, books surveys',
  reviews: '→ Review & Referral Automation — triggered review request on every completed install',
};

function getSeverityLevel(score) {
  if (score >= 4) return 'major';
  if (score >= 2) return 'moderate';
  return 'strong';
}

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Vercel should auto-parse JSON bodies; fall back to manual stream reading if not
  let p = req.body;
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      p = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    } catch { p = {}; }
  }
  p = p || {};
  console.log('[submit] body keys:', Object.keys(p).join(','), '| GHL_API_KEY set:', !!GHL_API_KEY, '| GHL_LOCATION_ID:', GHL_LOCATION_ID);
  const hasContact = p.name || p.full_name;
  const hasScores  = p.score_speed !== undefined;

  const tasks = [];

  if (hasContact) {
    tasks.push(
      createGHLContact(p).then(contactId => {
        if (contactId && hasScores) return addGHLNote(contactId, p);
      })
    );
  }

  if (p.email && hasScores) {
    tasks.push(sendReportEmail(p));
  }

  const results = await Promise.allSettled(tasks);
  const diag = results.map((r, i) => ({
    task: i === 0 ? 'ghl' : 'email',
    ok: r.status === 'fulfilled',
    error: r.status === 'rejected' ? r.reason?.message : null,
  }));
  diag.forEach(d => {
    if (!d.ok) console.error(`[submit] ${d.task} failed:`, d.error);
  });

  return res.status(200).json({ ok: true, diag });
}

async function createGHLContact(p) {
  const parts     = (p.name || p.full_name || '').trim().split(' ');
  const firstName = parts[0] || '';
  const lastName  = parts.slice(1).join(' ') || '';

  const body = {
    firstName,
    lastName,
    email:       p.email,
    companyName: p.organisation || p.company || '',
    locationId:  GHL_LOCATION_ID,
    tags:        ['solar-scan-lead'],
  };
  if (p.phone && p.phone.trim()) body.phone = p.phone.trim();

  const response = await fetch('https://services.leadconnectorhq.com/contacts/', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Content-Type':  'application/json',
      'Version':       '2021-07-28',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GHL Contacts ${response.status}: ${text}`);
  }

  const data = await response.json();
  return data.contact?.id;
}

async function addGHLNote(contactId, p) {
  const scores = {
    speed:   p.score_speed   || 0,
    quote:   p.score_quote   || 0,
    booking: p.score_booking || 0,
    calls:   p.score_calls   || 0,
    reviews: p.score_reviews || 0,
  };

  const total      = p.total      || 0;
  const annualLeak = p.annualLeak || 0;

  let tier;
  if (total <= 9)       tier = 'Strong Foundation';
  else if (total <= 19) tier = 'Revenue Leakage Detected';
  else                  tier = 'Critical Leaks';

  const bar = s => '█'.repeat(Math.round((s / 6) * 5)) + '░'.repeat(5 - Math.round((s / 6) * 5));
  const sev = s => s >= 4 ? 'Major Gap' : s >= 2 ? 'Moderate' : 'Strong';

  const noteBody = [
    `☀️ Solar Business Scan Results`,
    ``,
    `Overall Score: ${total}/30 — ${tier}`,
    `Annual Revenue at Risk: €${Math.round(annualLeak).toLocaleString('en-IE')}`,
    ``,
    `Speed to Lead:        ${bar(scores.speed)}  ${sev(scores.speed)}`,
    `Quote Follow-Up:      ${bar(scores.quote)}  ${sev(scores.quote)}`,
    `Survey Booking:       ${bar(scores.booking)}  ${sev(scores.booking)}`,
    `Missed Call Coverage: ${bar(scores.calls)}  ${sev(scores.calls)}`,
    `Reviews & Pipeline:   ${bar(scores.reviews)}  ${sev(scores.reviews)}`,
  ].join('\n');

  const response = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Content-Type':  'application/json',
      'Version':       '2021-07-28',
    },
    body: JSON.stringify({ body: noteBody }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GHL Notes ${response.status}: ${text}`);
  }
}

async function sendReportEmail(p) {
  const response = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    'FlowBuild AI <scan@flowbuildai.ie>',
      to:      [p.email],
      subject: 'Your Solar Business Scan Results — FlowBuild AI',
      html:    buildEmailHTML(p),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Resend ${response.status}: ${text}`);
  }
  return response.json();
}

function buildEmailHTML(p) {
  const fmt        = n => '€' + Math.round(n).toLocaleString('en-IE');
  const total      = p.total      || 0;
  const annualLeak = p.annualLeak || 0;

  let tierKey, tierLabel, tierHeadline;
  if (total <= 9) {
    tierKey = 'solid'; tierLabel = 'Strong Foundation';
    tierHeadline = "Your pipeline is mostly healthy — here's what to tighten.";
  } else if (total <= 19) {
    tierKey = 'moderate'; tierLabel = 'Revenue Leakage Detected';
    tierHeadline = "You're losing installs to process gaps that are fixable in weeks.";
  } else {
    tierKey = 'critical'; tierLabel = 'Critical Leaks';
    tierHeadline = "Your pipeline is losing installs daily.";
  }

  const tierStyles = {
    solid:    { bg: 'rgba(100,200,120,0.15)', color: '#7CCC8A' },
    moderate: { bg: 'rgba(232,101,42,0.15)',  color: '#F5804A' },
    critical: { bg: 'rgba(210,60,60,0.15)',   color: '#E57373' },
  };
  const ts = tierStyles[tierKey];

  const scores = {
    speed:   p.score_speed   || 0,
    quote:   p.score_quote   || 0,
    booking: p.score_booking || 0,
    calls:   p.score_calls   || 0,
    reviews: p.score_reviews || 0,
  };

  const sevStyles = {
    major:    { tag: '#E57373', tagBg: 'rgba(210,60,60,0.20)',  bar: '#E57373', label: 'Major Gap' },
    moderate: { tag: '#F5804A', tagBg: 'rgba(232,101,42,0.20)', bar: '#E8652A', label: 'Moderate'  },
    strong:   { tag: '#7CCC8A', tagBg: 'rgba(100,200,120,0.15)',bar: '#7CCC8A', label: 'Strong'    },
  };

  const catBlocks = CAT_ORDER
    .map(cat => ({ cat, score: scores[cat] }))
    .sort((a, b) => b.score - a.score)
    .map(({ cat, score }) => {
      const level = getSeverityLevel(score);
      const pct   = Math.round((score / 6) * 100);
      const ss    = sevStyles[level];
      return `
      <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:20px 24px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
          <span style="font-size:14px;font-weight:700;color:#ffffff;">${CAT_LABELS[cat]}</span>
          <span style="font-size:9px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;padding:3px 8px;border-radius:3px;background:${ss.tagBg};color:${ss.tag};">${ss.label}</span>
        </div>
        <p style="font-size:14px;line-height:1.65;color:rgba(254,241,232,0.72);margin:0 0 14px 0;">${NARRATIVES[cat][level]}</p>
        <div style="background:rgba(232,101,42,0.10);border-left:2px solid #E8652A;padding:9px 13px;border-radius:3px;font-size:12px;color:rgba(254,241,232,0.80);margin-bottom:14px;">${CALLOUTS[cat]}</div>
        <div style="height:3px;background:rgba(255,255,255,0.07);border-radius:2px;overflow:hidden;">
          <div style="height:100%;width:${pct}%;background:${ss.bar};border-radius:2px;"></div>
        </div>
      </div>`;
    }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#1C1917;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#1C1917;">
<tr><td align="center" style="padding:32px 16px;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
  <tr><td style="padding:0 0 28px 0;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td><span style="font-size:15px;font-weight:800;letter-spacing:-0.02em;text-transform:uppercase;color:#ffffff;">FLOW<span style="color:#E8652A;">BUILD</span><span style="display:inline-block;background:#E8652A;color:#fff;font-size:8px;font-weight:800;padding:2px 5px;border-radius:2px;margin-left:4px;vertical-align:middle;">AI</span></span></td>
      <td align="right"><span style="font-size:10px;letter-spacing:0.10em;text-transform:uppercase;color:rgba(255,255,255,0.28);">Solar Business Scan</span></td>
    </tr></table>
  </td></tr>
  <tr><td style="height:1px;background:rgba(255,255,255,0.07);padding:0;"></td></tr>
  <tr><td style="padding:28px 0 10px 0;">
    <span style="display:inline-block;font-size:9px;font-weight:700;letter-spacing:0.10em;text-transform:uppercase;padding:4px 12px;border-radius:3px;background:${ts.bg};color:${ts.color};">${tierLabel}</span>
  </td></tr>
  <tr><td style="padding-bottom:10px;">
    <h1 style="margin:0;font-size:26px;font-weight:800;line-height:1.15;letter-spacing:-0.02em;color:#ffffff;">${tierHeadline}</h1>
  </td></tr>
  <tr><td style="padding-bottom:28px;">
    <p style="margin:0;font-size:15px;line-height:1.65;color:rgba(254,241,232,0.56);">Based on your answers, here's where revenue is slipping through the cracks.</p>
  </td></tr>
  <tr><td style="padding-bottom:4px;">
    <div style="font-size:48px;font-weight:900;letter-spacing:-0.04em;color:#E8652A;line-height:1;">${fmt(annualLeak)}</div>
  </td></tr>
  <tr><td style="padding-bottom:24px;">
    <p style="margin:0;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:rgba(254,241,232,0.36);">Estimated annual install revenue at risk</p>
  </td></tr>
  <tr><td style="padding-bottom:32px;">
    <div style="display:inline-block;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.10);border-radius:4px;padding:8px 16px;font-size:13px;color:rgba(254,241,232,0.48);">
      Audit score &nbsp;<strong style="color:#ffffff;font-size:17px;">${total}</strong><span style="opacity:0.35;"> / 30</span>
    </div>
  </td></tr>
  <tr><td style="height:1px;background:rgba(255,255,255,0.07);padding:0;"></td></tr>
  <tr><td style="padding:24px 0 14px 0;">
    <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:rgba(254,241,232,0.36);">Your Gap Breakdown</p>
  </td></tr>
  <tr><td>${catBlocks}</td></tr>
  <tr><td style="height:1px;background:rgba(255,255,255,0.07);padding:0;"></td></tr>
  <tr><td align="center" style="padding:32px 0;">
    <a href="${BOOKING_URL}" style="display:inline-block;background:#E8652A;color:#ffffff;font-size:15px;font-weight:700;letter-spacing:0.02em;padding:16px 36px;border-radius:4px;text-decoration:none;">Book a Free Systems Call →</a>
  </td></tr>
  <tr><td style="height:1px;background:rgba(255,255,255,0.07);padding:0;"></td></tr>
  <tr><td align="center" style="padding:28px 0 0 0;">
    <p style="margin:0 0 4px 0;font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:rgba(255,255,255,0.32);">FlowBuild AI — Ireland's AI Agency for Solar Installers</p>
    <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.20);">flowbuildai.ie</p>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}
