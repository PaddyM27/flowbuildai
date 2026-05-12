// Vercel serverless function — receives audit form submissions
// Writes to Notion CRM + notifies Slack + fires Make.com webhook as backup

const NOTION_TOKEN      = process.env.NOTION_TOKEN;
const NOTION_DB_ID      = process.env.NOTION_DATABASE_ID || '359710d6-10f0-8111-a900-e034623a8fa5';
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const MAKE_WEBHOOK      = 'https://hook.eu1.make.com/1thi68yaxab7xim945gs0fvbj1840jfg';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const p = req.body;

  const leadScore = computeLeadScore(p);
  const leadTier  = leadScore >= 8 ? 'Hot' : leadScore >= 5 ? 'Warm' : 'Nurture';
  const submittedAt = new Date().toISOString();

  const enriched = { ...p, leadScore, leadTier, submittedAt };

  const results = await Promise.allSettled([
    writeToNotion(enriched),
    notifySlack(enriched),
    fireMakeWebhook(enriched),
  ]);

  const [notionResult, slackResult, makeResult] = results;

  if (notionResult.status === 'rejected') {
    console.error('[submit] Notion error:', notionResult.reason);
  }
  if (slackResult.status === 'rejected') {
    console.error('[submit] Slack error:', slackResult.reason);
  }
  if (makeResult.status === 'rejected') {
    console.error('[submit] Make.com error:', makeResult.reason);
  }

  const ok = notionResult.status === 'fulfilled';
  return res.status(ok ? 200 : 500).json({
    ok,
    notion: notionResult.status,
    slack:  slackResult.status,
    make:   makeResult.status,
  });
}

async function writeToNotion(p) {
  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization':  `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type':   'application/json',
    },
    body: JSON.stringify({
      parent: { database_id: NOTION_DB_ID },
      properties: {
        'Name':                 { title:        [{ text: { content: `${p.name || ''} — ${p.business || ''}` } }] },
        'Business':             { rich_text:    [{ text: { content: p.business    || '' } }] },
        'Email':                { email:         p.email   || null },
        'Phone':                { phone_number:  p.phone   || null },
        'Date Submitted':       { date:         { start: p.submittedAt || new Date().toISOString() } },
        'Status':               { select:       { name: 'New Lead' } },
        'Annual Leak':          { number:        Number(p.annualLeak)       || 0 },
        'Audit Score':          { number:        Number(p.total)            || 0 },
        'Speed to Lead':        { number:        Number(p.score_speed)      || 0 },
        'Quote Follow-Up':      { number:        Number(p.score_quote)      || 0 },
        'Survey Booking':       { number:        Number(p.score_booking)    || 0 },
        'Missed Call Coverage': { number:        Number(p.score_calls)      || 0 },
        'Reviews & Pipeline':   { number:        Number(p.score_reviews)    || 0 },
        'Lead Tier':            { select:       { name: p.leadTier || 'Nurture' } },
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Notion ${res.status}: ${body}`);
  }
  return res.json();
}

async function notifySlack(p) {
  if (!SLACK_WEBHOOK_URL) return { skipped: true };

  const worstCat = getWorstCategory(p);
  const tier = p.leadTier || 'Nurture';
  const tierEmoji = tier === 'Hot' ? '🔥' : tier === 'Warm' ? '⚡' : '🌱';

  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `${tierEmoji} *New Solar Business Scan — ${p.business || 'Unknown'}*`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${tierEmoji} *New Solar Business Scan*\n*${p.business || 'Unknown Business'}*`,
          },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Name:*\n${p.name || '—'}` },
            { type: 'mrkdwn', text: `*Phone:*\n${p.phone || '—'}` },
            { type: 'mrkdwn', text: `*Email:*\n${p.email || '—'}` },
            { type: 'mrkdwn', text: `*Lead Tier:*\n${tier}` },
            { type: 'mrkdwn', text: `*Install Revenue at Risk:*\n€${Number(p.annualLeak || 0).toLocaleString('en-IE')}/yr` },
            { type: 'mrkdwn', text: `*Audit Score:*\n${p.total || 0}/30` },
          ],
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Biggest leak:* ${worstCat.name} (${worstCat.score}/6)`,
          },
        },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Slack ${res.status}`);
}

async function fireMakeWebhook(p) {
  const res = await fetch(MAKE_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  });
  if (!res.ok) throw new Error(`Make.com ${res.status}`);
}

function getWorstCategory(p) {
  const cats = [
    { name: 'Speed to Lead',        score: Number(p.score_speed)   || 0 },
    { name: 'Quote Follow-Up',      score: Number(p.score_quote)   || 0 },
    { name: 'Survey Booking',       score: Number(p.score_booking) || 0 },
    { name: 'Missed Call Coverage', score: Number(p.score_calls)   || 0 },
    { name: 'Reviews & Pipeline',   score: Number(p.score_reviews) || 0 },
  ];
  return cats.sort((a, b) => b.score - a.score)[0];
}

function computeLeadScore(p) {
  const raw = parseInt(p.total) || 0;
  let score = Math.round((raw / 30) * 8);
  if ((parseInt(p.score_speed) || 0) >= 4) score++;
  if ((parseInt(p.score_quote) || 0) >= 4) score++;
  return Math.min(10, score);
}
