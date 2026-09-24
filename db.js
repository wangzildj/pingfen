// SQLite 持久化（替代原 config.json）
// 表结构：meta(单例配置) / contestants / judges / scores
const path = require('path');
const fs = require('fs');
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'pingfen.db');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

const Database = require('better-sqlite3');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
CREATE TABLE IF NOT EXISTS contestants (
  id TEXT PRIMARY KEY,
  name TEXT,
  desc TEXT,
  avatar TEXT,
  sort_order INTEGER
);
CREATE TABLE IF NOT EXISTS judges (
  id TEXT PRIMARY KEY,
  name TEXT,
  avatar TEXT,
  password TEXT,
  role TEXT,
  sort_order INTEGER
);
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contestantId TEXT,
  judgeId TEXT,
  judgeName TEXT,
  judgeType TEXT,
  judgeAvatar TEXT,
  score REAL,
  t INTEGER
);
`);

const setMetaStmt = db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)');

function getMetaAll() {
  const rows = db.prepare('SELECT k, v FROM meta').all();
  const m = {};
  for (const r of rows) m[r.k] = r.v;
  return m;
}

function setMeta(obj) {
  const tx = db.transaction(() => {
    for (const k of Object.keys(obj)) setMetaStmt.run(k, obj[k] == null ? '' : String(obj[k]));
  });
  tx();
}

// 读取全部状态（内存对象，供 WebSocket 广播）
function loadState() {
  const m = getMetaAll();
  const contestants = db.prepare('SELECT id, name, desc, avatar FROM contestants ORDER BY sort_order').all();
  const judges = db.prepare('SELECT id, name, avatar, password, role FROM judges ORDER BY sort_order').all();
  const scores = {};
  const scRows = db.prepare('SELECT contestantId, judgeId, judgeName, judgeType, judgeAvatar, score, t FROM scores').all();
  for (const r of scRows) {
    if (!scores[r.contestantId]) scores[r.contestantId] = [];
    scores[r.contestantId].push({
      judgeId: r.judgeId, judgeName: r.judgeName, judgeType: r.judgeType,
      judgeAvatar: r.judgeAvatar, score: r.score, t: r.t
    });
  }
  return {
    background: m.background || '',
    page: m.page || 'background',
    scoring: m.scoring || 'idle',
    scoreMin: m.scoreMin !== undefined && m.scoreMin !== '' ? Number(m.scoreMin) : 0,
    scoreMax: m.scoreMax !== undefined && m.scoreMax !== '' ? Number(m.scoreMax) : 100,
    proWeight: m.proWeight !== undefined && m.proWeight !== '' ? Number(m.proWeight) : 0.7,
    massEnabled: m.massEnabled === 'true',
    dropExtremes: m.dropExtremes === 'true',
    currentContestantId: m.currentContestantId || null,
    contestants,
    judges,
    scores
  };
}

// 写入全部状态（每次改动后调用）
function saveState(state) {
  setMeta({
    background: state.background,
    page: state.page,
    scoring: state.scoring,
    scoreMin: state.scoreMin,
    scoreMax: state.scoreMax,
    proWeight: state.proWeight,
    massEnabled: state.massEnabled,
    dropExtremes: state.dropExtremes,
    currentContestantId: state.currentContestantId || ''
  });
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM contestants').run();
    const ci = db.prepare('INSERT INTO contestants (id, name, desc, avatar, sort_order) VALUES (?, ?, ?, ?, ?)');
    state.contestants.forEach((c, i) => ci.run(c.id, c.name, c.desc || '', c.avatar || '', i));

    db.prepare('DELETE FROM judges').run();
    const ji = db.prepare('INSERT INTO judges (id, name, avatar, password, role, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    state.judges.forEach((j, i) => ji.run(j.id, j.name, j.avatar || '', j.password || '', j.role || 'pro', i));

    db.prepare('DELETE FROM scores').run();
    const si = db.prepare('INSERT INTO scores (contestantId, judgeId, judgeName, judgeType, judgeAvatar, score, t) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const cid of Object.keys(state.scores || {})) {
      for (const s of (state.scores[cid] || [])) {
        si.run(cid, s.judgeId, s.judgeName || '', s.judgeType || 'pro', s.judgeAvatar || '', s.score, s.t || Date.now());
      }
    }
  });
  tx();
}

// 首次启动：库为空且存在旧 config.json 时，把数据迁过来；之后可删除 config.json
function migrateIfNeeded() {
  const cnt = db.prepare('SELECT COUNT(*) AS n FROM meta').get().n;
  if (cnt > 0) return false;
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      saveState({
        background: cfg.background || '',
        page: cfg.page || 'background',
        scoring: cfg.scoring || 'idle',
        scoreMin: cfg.scoreMin != null ? cfg.scoreMin : 0,
        scoreMax: cfg.scoreMax != null ? cfg.scoreMax : 100,
        proWeight: cfg.proWeight != null ? cfg.proWeight : 0.7,
        massEnabled: !!cfg.massEnabled,
        dropExtremes: !!cfg.dropExtremes,
        currentContestantId: cfg.currentContestantId || null,
        contestants: cfg.contestants || [],
        judges: cfg.judges || [],
        scores: cfg.scores || {}
      });
      console.log('已从 config.json 迁移数据到 SQLite');
      return true;
    } catch (e) {
      console.warn('迁移 config.json 失败:', e.message);
    }
  }
  // 没有任何数据：写入默认 meta 以便后续识别为已初始化
  setMeta({ page: 'background', scoring: 'idle', scoreMin: 0, scoreMax: 100, proWeight: 0.7, massEnabled: 0, dropExtremes: 0, currentContestantId: '' });
  return false;
}

module.exports = { db, loadState, saveState, migrateIfNeeded };
