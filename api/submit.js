// Vercel serverless function — receives Solar Business Scan submissions
// Creates a contact in Go High Level CRM
//
// Required env vars in Vercel:
//   GHL_API_KEY      — Settings → API Keys → generate a new key
//   GHL_LOCATION_ID  — your sub-account ID (visible in your GHL dashboard URL)

const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const p = req.body;

  try {
    await createGHLContact(p);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[submit] GHL error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

async function createGHLContact(p) {
  const nameParts = (p.name || '').trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName  = nameParts.slice(1).join(' ') || '';

  const body = {
    locationId:  GHL_LOCATION_ID,
    firstName,
    lastName,
    email:       p.email       || undefined,
    phone:       p.phone       || undefined,
    companyName: p.organisation || p.business || undefined,
    tags:        ['website-scan', 'solar'],
    customFields: [
      { key: 'audit_score',    field_value: String(p.total        || 0) },
      { key: 'annual_leak',    field_value: String(p.annualLeak   || 0) },
      { key: 'score_speed',    field_value: String(p.score_speed   || 0) },
      { key: 'score_quote',    field_value: String(p.score_quote   || 0) },
      { key: 'score_booking',  field_value: String(p.score_booking || 0) },
      { key: 'score_calls',    field_value: String(p.score_calls   || 0) },
      { key: 'score_reviews',  field_value: String(p.score_reviews || 0) },
    ],
  };

  const res = await fetch('https://services.leadconnectorhq.com/contacts/', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GHL_API_KEY}`,
      'Version':       '2021-07-28',
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL ${res.status}: ${text}`);
  }
  return res.json();
}
