const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const WebSocket = require('ws');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'public', 'uploads');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// 存储改为 SQLite（见 db.js）；启动时从旧 config.json 自动迁移一次
const { loadState, saveState, migrateIfNeeded } = require('./db');
migrateIfNeeded();
let state = loadState();

function getLanIp() {
  if (process.env.LAN_IP) return process.env.LAN_IP;       // 手动指定，最优先
  if (process.env.HOST) return process.env.HOST;
  const ifaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (iface.address.startsWith('169.254.')) continue;  // 跳过链路本地(APIPA)
      const virtual = /vmware|vmnet|vethernet|docker|virtual|hyper-v|wsl|vbox/i.test(name);
      const prefer = /wlan|wi-?fi|ethernet|eth|本地连接|无线|lan/i.test(name) ? 2 : (virtual ? 0 : 1);
      candidates.push({ address: iface.address, prefer, virtual });
    }
  }
  if (!candidates.length) return 'localhost';
  candidates.sort((a, b) => b.prefer - a.prefer || (a.virtual ? 1 : 0) - (b.virtual ? 1 : 0));
  return candidates[0].address;
}
const LAN_IP = getLanIp();
const baseUrl = `http://${LAN_IP}:${PORT}`;

const app = express();
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
app.use('/uploads', express.static(UPLOAD_DIR));

app.get('/api/state', (req, res) => res.json(state));
app.get('/api/info', (req, res) => res.json({ ip: LAN_IP, port: PORT, baseUrl }));

// 评委登录（名字/选择 + 密码）
app.post('/api/judge/login', (req, res) => {
  const { judgeId, name, password } = req.body || {};
  const j = state.judges.find(x => (judgeId && x.id === judgeId) || (name && x.name === name));
  if (!j || String(j.password || '') !== String(password == null ? '' : password)) {
    return res.status(401).json({ ok: false, error: '评委不存在或密码错误' });
  }
  res.json({ ok: true, judge: { id: j.id, name: j.name, avatar: j.avatar, role: j.role || 'pro' } });
});

// 图片上传（头像 / 背景），客户端以 base64 发送
app.post('/api/upload', (req, res) => {
  const { name, data, category } = req.body || {};
  if (!data || !name) return res.status(400).json({ error: 'missing' });
  const ext = (String(name).split('.').pop() || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png';
  const fname = `${category || 'img'}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const buf = Buffer.from(String(data).replace(/^data:.*;base64,/, ''), 'base64');
  fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf);
  res.json({ url: '/uploads/' + fname });
});

// 二维码（评委扫码打分 / 手机控制切页）
// 评委二维码支持 ?j=评委ID → 指向本人专属登录链接（扫码后只显示该评委账号）
app.get('/api/qrcode/judge', async (req, res) => {
  try {
    const j = req.query.j;
    const url = j ? baseUrl + '/judge?j=' + encodeURIComponent(j) : baseUrl + '/judge';
    const buf = await QRCode.toBuffer(url, { type: 'png', width: 480, margin: 1 });
    res.set('Content-Type', 'image/png').send(buf);
  } catch { res.status(500).send('err'); }
});
app.get('/api/qrcode/control', async (req, res) => {
  try {
    const buf = await QRCode.toBuffer(baseUrl + '/control', { type: 'png', width: 480, margin: 1 });
    res.set('Content-Type', 'image/png').send(buf);
  } catch { res.status(500).send('err'); }
});

// 导出所有评委二维码 Word：一张 A4 三列九宫格，每码下方写评委名称 + 密码
app.get('/api/export/judge-qrcodes', async (req, res) => {
  try {
    const docx = require('docx');
    const { Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, WidthType, AlignmentType } = docx;
    if (!state.judges.length) return res.status(400).send('暂无评委，无法导出');
    const cells = [];
    for (const j of state.judges) {
      const qrBuf = await QRCode.toBuffer(baseUrl + '/judge?j=' + j.id, { type: 'png', width: 360, margin: 1 });
      cells.push(new TableCell({
        width: { size: 33.3, type: WidthType.PERCENTAGE },
        margins: { top: 160, bottom: 160, left: 120, right: 120 },
        children: [
          new Paragraph({ alignment: AlignmentType.CENTER, children: [ new ImageRun({ type: 'png', data: qrBuf, transformation: { width: 150, height: 150 } }) ] }),
          new Paragraph({ alignment: AlignmentType.CENTER, children: [ new TextRun({ text: j.name, bold: true, size: 24 }) ] }),
          new Paragraph({ alignment: AlignmentType.CENTER, children: [ new TextRun({ text: '密码：' + (j.password || '(无)'), size: 18 }) ] }),
        ],
      }));
    }
    const rows = [];
    for (let i = 0; i < cells.length; i += 3) rows.push(new TableRow({ children: cells.slice(i, i + 3) }));
    const table = new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows });
    const doc = new Document({
      sections: [{
        properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 720, bottom: 720, left: 720, right: 720 } } },
        children: [ new Paragraph({ alignment: AlignmentType.CENTER, children: [ new TextRun({ text: '评委评分二维码', bold: true, size: 32 }) ] }), table ],
      }],
    });
    const buf = await Packer.toBuffer(doc);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.set('Content-Disposition', "attachment; filename=\"judge_qrcodes.docx\"; filename*=UTF-8''%E8%AF%84%E5%A7%94%E4%BA%8C%E7%BB%B4%E7%A0%81.docx");
    res.send(buf);
  } catch (e) { console.error('export docx err:', e); res.status(500).send('生成失败'); }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

function broadcast() {
  const msg = JSON.stringify({ type: 'state', state });
  for (const c of wss.clients) {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', state }));
  ws.send(JSON.stringify({ type: 'info', ip: LAN_IP, port: PORT, baseUrl }));
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(msg, ws);
  });
});

function handleMessage(msg, ws) {
  switch (msg.type) {
    case 'setPage':
      if (['background', 'contestant', 'scoring', 'leaderboard'].includes(msg.page)) state.page = msg.page;
      break;
    case 'setScoring':
      if (['idle', 'active', 'ended'].includes(msg.value)) state.scoring = msg.value;
      break;
    case 'setBackground':
      state.background = msg.url || '';
      break;
    case 'addContestant':
      state.contestants.push({
        id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6),
        name: msg.name || '选手',
        desc: msg.desc || '',
        avatar: msg.avatar || ''
      });
      if (!state.currentContestantId) state.currentContestantId = state.contestants[state.contestants.length - 1].id;
      break;
    case 'updateContestant': {
      const c = state.contestants.find(x => x.id === msg.id);
      if (c) {
        if (msg.name !== undefined) c.name = msg.name;
        if (msg.desc !== undefined) c.desc = msg.desc;
        if (msg.avatar !== undefined) c.avatar = msg.avatar;
      }
      break;
    }
    case 'removeContestant':
      state.contestants = state.contestants.filter(x => x.id !== msg.id);
      delete state.scores[msg.id];
      if (state.currentContestantId === msg.id) state.currentContestantId = state.contestants.length ? state.contestants[0].id : null;
      break;
    case 'setCurrent':
      if (msg.id === null || state.contestants.find(x => x.id === msg.id)) state.currentContestantId = msg.id;
      break;
    case 'addJudge':
      state.judges.push({
        id: 'g' + Date.now() + Math.random().toString(36).slice(2, 6),
        name: msg.name || '评委',
        avatar: msg.avatar || '',
        password: String(msg.password == null ? '' : msg.password),
        role: msg.role === 'mass' ? 'mass' : 'pro'
      });
      break;
    case 'updateJudge': {
      const g = state.judges.find(x => x.id === msg.id);
      if (g) {
        if (msg.name !== undefined) g.name = msg.name;
        if (msg.avatar !== undefined) g.avatar = msg.avatar;
        if (msg.password !== undefined) g.password = String(msg.password);
        if (msg.role !== undefined) g.role = msg.role === 'mass' ? 'mass' : 'pro';
      }
      break;
    }
    case 'removeJudge':
      state.judges = state.judges.filter(x => x.id !== msg.id);
      break;
    case 'setWeights':
      if (typeof msg.proWeight === 'number' && msg.proWeight >= 0 && msg.proWeight <= 1) state.proWeight = msg.proWeight;
      break;
    case 'setMassEnabled':
      state.massEnabled = !!msg.value;
      break;
    case 'setDropExtremes':
      state.dropExtremes = !!msg.value;
      break;
    case 'clearScores':
      state.scores = {};
      break;
    case 'setScoreRange':
      if (typeof msg.min === 'number' && !isNaN(msg.min)) state.scoreMin = msg.min;
      if (typeof msg.max === 'number' && !isNaN(msg.max)) state.scoreMax = msg.max;
      break;
    case 'submitScore': {
      if (state.scoring !== 'active') {
        ws.send(JSON.stringify({ type: 'scoreResult', ok: false, reason: 'not_active' }));
        return;
      }
      const judge = state.judges.find(x => x.id === msg.judgeId);
      if (!judge) {
        ws.send(JSON.stringify({ type: 'scoreResult', ok: false, reason: 'not_registered' }));
        return;
      }
      // 未启用大众评分时，大众评委的提交一律忽略
      if (judge.role === 'mass' && !state.massEnabled) {
        ws.send(JSON.stringify({ type: 'scoreResult', ok: false, reason: 'mass_disabled' }));
        return;
      }
      const cid = msg.contestantId || state.currentContestantId;
      if (!cid || !state.contestants.find(c => c.id === cid)) {
        ws.send(JSON.stringify({ type: 'scoreResult', ok: false, reason: 'no_contestant' }));
        return;
      }
      const score = Number(msg.score);
      if (isNaN(score) || score < state.scoreMin || score > state.scoreMax) {
        ws.send(JSON.stringify({ type: 'scoreResult', ok: false, reason: 'invalid' }));
        return;
      }
      if (!state.scores[cid]) state.scores[cid] = [];
      const existing = state.scores[cid].find(s => s.judgeId === judge.id);
      if (existing) {
        existing.score = score;
        existing.judgeAvatar = judge.avatar || '';
        existing.t = Date.now();
      } else {
        state.scores[cid].push({ judgeId: judge.id, judgeName: judge.name, judgeType: judge.role || 'pro', judgeAvatar: judge.avatar || '', score, t: Date.now() });
      }
      ws.send(JSON.stringify({ type: 'scoreResult', ok: true, contestantId: cid }));
      break;
    }
    default:
      return;
  }
  saveState(state);
  broadcast();
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n现场打分平台已启动: ${baseUrl}`);
  console.log(`  大屏显示 : ${baseUrl}/screen`);
  console.log(`  管理后台 : ${baseUrl}/admin`);
  console.log(`  评委扫码 : ${baseUrl}/judge  (二维码 ${baseUrl}/api/qrcode/judge)`);
  console.log(`  手机控制 : ${baseUrl}/control (二维码 ${baseUrl}/api/qrcode/control)\n`);
});
