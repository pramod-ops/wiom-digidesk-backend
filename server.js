const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8306;

const GH_TOKEN = process.env.GH_TOKEN;
const GH_REPO = 'Wiom-using-AI/wiom-digidesk';
const GH_FILE = 'data.json';
const SLACK_TOKEN = process.env.SLACK_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
let SLACK_MGR_IDS = {};
try { SLACK_MGR_IDS = JSON.parse(process.env.SLACK_MGR_IDS || '{"Pramod":"U099S3YG6SW","Devashish Mukherjee":"U07GW5ML467"}'); } catch(e) {}

// Raw body needed for Slack signature verification
app.use('/slack/actions', express.raw({ type: '*/*' }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

let _memCache = null;
let _memSha = null;
let _memCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function ghRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.github.com', path, method,
      headers: { 'Authorization': `token ${GH_TOKEN}`, 'User-Agent': 'wiom-digidesk', 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' }
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function readData() {
  if (_memCache !== null && (Date.now() - _memCacheTime) < CACHE_TTL) return JSON.parse(JSON.stringify(_memCache));
  try {
    const r = await ghRequest('GET', `/repos/${GH_REPO}/contents/${GH_FILE}`);
    if (r.content) { _memSha = r.sha; _memCache = JSON.parse(Buffer.from(r.content, 'base64').toString('utf8')); _memCacheTime = Date.now(); return JSON.parse(JSON.stringify(_memCache)); }
  } catch (e) {}
  if (_memCache !== null) return JSON.parse(JSON.stringify(_memCache));
  _memCache = {};
  return {};
}

let _writeQueue = Promise.resolve();

// writeData returns true if GitHub confirmed the write, false if all retries failed.
// _writeQueue never rejects (poisoning prevented via .catch).
async function writeData(data) {
  const snapshot = JSON.parse(JSON.stringify(data));
  _memCache = snapshot;
  _memCacheTime = Date.now();
  let resolveResult;
  const result = new Promise(res => { resolveResult = res; });

  _writeQueue = _writeQueue.then(async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const cur = await ghRequest('GET', `/repos/${GH_REPO}/contents/${GH_FILE}`);
        if (cur.sha) _memSha = cur.sha;
      } catch (e) {}
      const content = Buffer.from(JSON.stringify(snapshot)).toString('base64');
      const body = { message: 'update data', content };
      if (_memSha) body.sha = _memSha;
      try {
        const r = await ghRequest('PUT', `/repos/${GH_REPO}/contents/${GH_FILE}`, body);
        if (r.content) { _memSha = r.content.sha; resolveResult(true); return; }
      } catch (e) { console.error('GitHub write attempt', attempt + 1, 'failed:', e?.message); }
      if (attempt < 4) await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
    }
    console.error('GitHub write failed after 5 attempts');
    resolveResult(false);
  }).catch(e => {
    console.error('writeQueue error:', e?.message);
    resolveResult(false);
  });

  const myQueue = _writeQueue;
  await myQueue;
  return result; // already resolved by the time myQueue settles
}

// ==================== SLACK ====================
function slackAPI(endpoint, payload) {
  if (!SLACK_TOKEN) return Promise.resolve({});
  return new Promise((resolve) => {
    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: 'slack.com', path: `/api/${endpoint}`, method: 'POST',
      headers: { 'Authorization': `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => { let r = ''; res.on('data', c => r += c); res.on('end', () => { try { resolve(JSON.parse(r)); } catch { resolve({}); } }); });
    req.on('error', e => { console.error('Slack error', e); resolve({}); });
    req.write(data);
    req.end();
  });
}

function slackDM(userId, text, blocks) {
  const payload = { channel: userId, text };
  if (blocks) payload.blocks = blocks;
  return slackAPI('chat.postMessage', payload);
}

function slackUpdate(channel, ts, text, blocks) {
  const payload = { channel, ts, text };
  if (blocks) payload.blocks = blocks;
  else payload.blocks = [];
  return slackAPI('chat.update', payload);
}

// ==================== LEAVE NOTIFICATION WITH BUTTONS ====================
function leaveBlocks(empName, empId, leaveType, from, to, days, reason, leaveId) {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `:beach_with_umbrella: *New Leave Request*\n*Employee:* ${empName} (${empId})\n*Type:* ${leaveType}\n*Dates:* ${from} to ${to} (${days} day${days > 1 ? 's' : ''})\n*Reason:* ${reason || '-'}` }
    },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: ':white_check_mark: Approve' }, style: 'primary', action_id: 'approve_leave', value: leaveId },
        { type: 'button', text: { type: 'plain_text', text: ':x: Reject' }, style: 'danger', action_id: 'reject_leave', value: leaveId }
      ]
    }
  ];
}

app.post('/api/notify-leave', async (req, res) => {
  if (!SLACK_TOKEN) return res.json({ ok: true });
  const { empName, empId, manager, leaveType, from, to, days, reason, leaveId } = req.body;
  const slackId = SLACK_MGR_IDS[manager];
  if (slackId) {
    await slackDM(slackId,
      `:beach_with_umbrella: New leave request from ${empName}`,
      leaveBlocks(empName, empId, leaveType, from, to, days, reason, leaveId)
    );
  }
  res.json({ ok: true });
});

// ==================== SLACK INTERACTIVE ACTIONS ====================
app.post('/slack/actions', async (req, res) => {
  // Verify Slack signature
  if (SLACK_SIGNING_SECRET) {
    const ts = req.headers['x-slack-request-timestamp'];
    const sig = req.headers['x-slack-signature'];
    const rawBody = req.body.toString();
    const baseStr = `v0:${ts}:${rawBody}`;
    const myHash = 'v0=' + crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(baseStr).digest('hex');
    if (myHash !== sig) { return res.status(401).send('Unauthorized'); }
  }

  const rawBody = req.body.toString();
  const payload = JSON.parse(decodeURIComponent(rawBody.replace('payload=', '')));
  const action = payload.actions && payload.actions[0];
  if (!action) return res.send('');

  const leaveId = action.value;
  const actionId = action.action_id; // approve_leave or reject_leave
  const mgrSlackId = payload.user.id;
  const mgrName = Object.keys(SLACK_MGR_IDS).find(k => SLACK_MGR_IDS[k] === mgrSlackId) || 'Manager';
  const channel = payload.channel.id;
  const msgTs = payload.message.ts;

  res.send(''); // Respond immediately to Slack

  // Update leave in data — through _opQueue so it never races with attendance writes
  let leaveNotFound = false;
  let leave, approved;
  _opQueue = _opQueue.then(async () => {
    const data = await readData();
    const leaves = data.wiom_leaves ? JSON.parse(data.wiom_leaves) : [];
    const leaveIdx = leaves.findIndex(l => l.id === leaveId);
    if (leaveIdx === -1) { leaveNotFound = true; return; }
    leave = leaves[leaveIdx];
    approved = actionId === 'approve_leave';
    leave.status = approved ? 'Approved' : 'Rejected';
    leave.approvedBy = mgrName;
    leave.approvedAt = new Date().toISOString();
    data.wiom_leaves = JSON.stringify(leaves);
    const writeOk = await writeData(data);
    if (!writeOk) console.error('CRITICAL: Slack leave action write failed for', leaveId);
  }).catch(e => { console.error('slack/actions write error:', e?.message); });
  await _opQueue;

  if (leaveNotFound) {
    await slackAPI('chat.postMessage', { channel, text: ':warning: Leave request not found. It may have already been processed.' });
    return;
  }

  // Update the Slack message to show decision
  const decisionText = approved
    ? `:white_check_mark: *Approved* by ${mgrName}\n*Employee:* ${leave.empName} (${leave.empId}) | *Type:* ${leave.type} | *Dates:* ${leave.from} to ${leave.to}`
    : `:x: *Rejected* by ${mgrName}\n*Employee:* ${leave.empName} (${leave.empId}) | *Type:* ${leave.type} | *Dates:* ${leave.from} to ${leave.to}`;

  await slackUpdate(channel, msgTs, decisionText, [
    { type: 'section', text: { type: 'mrkdwn', text: decisionText } }
  ]);

  // Notify employee (find manager's Slack ID for employee — find employee's manager's slackId)
  const empSlackId = SLACK_MGR_IDS[leave.empName]; // if employee also has Slack ID
  if (empSlackId) {
    await slackDM(empSlackId, approved
      ? `:white_check_mark: *Leave Approved!*\nYour ${leave.type} from ${leave.from} to ${leave.to} has been approved by ${mgrName}.`
      : `:x: *Leave Rejected*\nYour ${leave.type} from ${leave.from} to ${leave.to} has been rejected by ${mgrName}.`
    );
  }

  console.log(`Leave ${leaveId} ${leave.status} by ${mgrName}`);
});

// ==================== CRON (daily 12:30 PM IST = 07:00 UTC) ====================
function startCron() {
  const now = new Date();
  const nextRun = new Date();
  nextRun.setUTCHours(7, 0, 0, 0);
  // If today's 07:00 UTC already passed, schedule for tomorrow (do NOT fire immediately on restart)
  if (nextRun <= now) {
    nextRun.setUTCDate(nextRun.getUTCDate() + 1);
  }
  const delay = nextRun - now;
  setTimeout(async function tick() {
    await sendDailyAttendance();
    setTimeout(tick, 24 * 60 * 60 * 1000);
  }, delay);
  console.log(`Daily attendance cron scheduled in ${Math.round(delay / 60000)} minutes`);
}

async function sendDailyAttendance() {
  if (!SLACK_TOKEN) return;
  try {
    const data = await readData();
    const att = data.wiom_att ? JSON.parse(data.wiom_att) : {};
    const emps = data.wiom_custom_emps ? JSON.parse(data.wiom_custom_emps) : [];
    const todayStr = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const todayKey = new Date().toISOString().split('T')[0];

    const byMgr = {};
    emps.forEach(e => { if (!e.mgr) return; if (!byMgr[e.mgr]) byMgr[e.mgr] = []; byMgr[e.mgr].push(e); });

    // Send each manager their own team report
    for (const [mgrName, team] of Object.entries(byMgr)) {
      const slackId = SLACK_MGR_IDS[mgrName];
      if (!slackId) { console.log(`No Slack ID for manager: ${mgrName}`); continue; }
      const present = [], absent = [];
      team.forEach(e => {
        const rec = att[`${e.id}__${todayKey}`] || att[`${e.id}_${todayKey}`];
        if (rec && rec.in) present.push(`:white_check_mark: ${e.name} — In: ${rec.in}`);
        else absent.push(`:x: ${e.name} — Not Marked`);
      });
      const msg = `:clipboard: *Daily Attendance Report — ${todayStr}*\n*Team: ${mgrName} (${team.length} employees)*\n\n${[...present, ...absent].join('\n')}\n\n*Present: ${present.length} | Absent: ${absent.length}*`;
      await slackDM(slackId, msg);
    }

    // Send Pramod a consolidated all-teams report
    const pramodId = SLACK_MGR_IDS['Pramod'];
    if (pramodId && emps.length > 0) {
      const allLines = [];
      let totalPresent = 0, totalAbsent = 0;
      for (const [mgrName, team] of Object.entries(byMgr)) {
        allLines.push(`\n*Manager: ${mgrName}*`);
        team.forEach(e => {
          const rec = att[`${e.id}__${todayKey}`] || att[`${e.id}_${todayKey}`];
          if (rec && rec.in) { allLines.push(`:white_check_mark: ${e.name} — In: ${rec.in}`); totalPresent++; }
          else { allLines.push(`:x: ${e.name} — Not Marked`); totalAbsent++; }
        });
      }
      const consolidatedMsg = `:bar_chart: *All-Teams Attendance — ${todayStr}*\n${allLines.join('\n')}\n\n*Total: ${emps.length} | Present: ${totalPresent} | Absent: ${totalAbsent}*`;
      await slackDM(pramodId, consolidatedMsg);
    }

    console.log('Daily attendance DMs sent');
  } catch (e) { console.error('Cron error', e); }
}

// ==================== LOGIN TRACKING ====================
app.post('/api/track-login', async (req, res) => {
  const { empId, empName, role, time } = req.body;
  if (!empId) return res.json({ ok: true });
  _opQueue = _opQueue.then(async () => {
    const data = await readData();
    const logins = data.wiom_logins ? JSON.parse(data.wiom_logins) : [];
    logins.unshift({ empId, empName, role, time, date: new Date().toISOString().split('T')[0] });
    if (logins.length > 1000) logins.splice(1000);
    data.wiom_logins = JSON.stringify(logins);
    writeData(data); // fire-and-forget: _memCache updated immediately, GitHub write in background
  }).catch(e => { console.error('track-login write error:', e?.message); });
  await _opQueue;
  res.json({ ok: true });
});

// ==================== MANUAL TRIGGER ====================
app.post('/api/send-attendance-now', async (req, res) => {
  await sendDailyAttendance();
  res.json({ ok: true, message: 'Attendance report sent' });
});

// ==================== VERSION ====================
app.get('/api/version', (req, res) => res.json({ version: '2.2.0', feature: 'opqueue-fire-and-forget' }));

// ==================== API ROUTES ====================
app.get('/api', async (req, res) => {
  const data = await readData();
  if (req.query.action === 'getAll') return res.json({ ok: true, data });
  const key = req.query.key;
  res.json({ ok: true, value: key ? (data[key] || null) : null });
});

// Atomic attendance record — merges a SINGLE att record, never overwrites others
let _opQueue = Promise.resolve();
app.post('/api/att-record', async (req, res) => {
  const { attKey, attValue } = req.body;
  if (!attKey) return res.status(400).json({ ok: false });
  let saved = false;
  _opQueue = _opQueue.then(async () => {
    const data = await readData();
    const att = data.wiom_att ? JSON.parse(data.wiom_att) : {};
    if (attValue === null || attValue === undefined) {
      delete att[attKey];
    } else {
      att[attKey] = { ...(att[attKey] || {}), ...attValue };
    }
    data.wiom_att = JSON.stringify(att);
    saved = await writeData(data); // true only if GitHub confirmed
  }).catch(e => {
    console.error('att-record write error:', e?.message);
  });
  await _opQueue;
  res.json({ ok: saved });
});

app.post('/api', async (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ ok: false });
  _opQueue = _opQueue.then(async () => {
    const data = await readData();
    data[key] = typeof value === 'string' ? value : JSON.stringify(value);
    writeData(data); // fire-and-forget: _memCache updated immediately, GitHub write in background
  }).catch(e => { console.error('api write error:', e?.message); });
  await _opQueue;
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`Wiom DigiDesk running on port ${PORT}`);
  startCron();
});

// Graceful shutdown — wait for any pending GitHub writes before exiting
process.on('SIGTERM', async () => {
  console.log('SIGTERM received — flushing pending writes...');
  try { await _opQueue; } catch (e) {}
  try { await _writeQueue; } catch (e) {}
  console.log('Write queue flushed. Exiting.');
  process.exit(0);
});
