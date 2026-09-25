// SQLite 持久化（纯 WASM 实现，零原生编译；替代 better-sqlite3，避免 CentOS8/glibc 2.28 上原生模块加载失败）
// 表结构：meta(单例配置) / contestants / judges / scores
// 注意：sql.js 初始化是异步的（加载 WASM），由 server.js 在启动时 await db.init() 完成后再 loadState。
const path = require('path');
const fs = require('fs');
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'pingfen.db');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

fs.mkdirSync(DATA_DIR, { recursive: true });

const initSqlJs = require('sql.js');
// 同步读取 wasm，避免运行时再做一次异步文件 I/O（WASM 实例化本身是微任务，由调用方 await）
const wasmBinary = fs.readFileSync(path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'));

const SCHEMA = `
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
`;

let db = null; // SQL.Database 实例，init() 完成后才可用

function init() {
  return initSqlJs({ wasmBinary }).then((SQL) => {
    db = new SQL.Database(fs.existsSync(DB_PATH) ? fs.readFileSync(DB_PATH) : undefined);
    // 无论新旧库都确保表结构存在（IF NOT EXISTS 幂等）；
    // 若旧库是 WAL 模式且主文件未 checkpoint，至多丢失未落盘的数据，但应用不会崩溃
    db.exec(SCHEMA);
    if (!fs.existsSync(DB_PATH)) persist();
  });
}

function persist() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function run(sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind(params || []);
  stmt.run();
  stmt.free();
}
// sql.js 的 stmt.get() 返回按列位置的数组，需要按 getColumnNames() 映射成对象
function rowToObj(stmt, vals) {
  const cols = stmt.getColumnNames();
  const obj = {};
  cols.forEach((c, i) => { obj[c] = vals[i]; });
  return obj;
}
function all(sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind(params || []);
  const rows = [];
  while (stmt.step()) rows.push(rowToObj(stmt, stmt.get()));
  stmt.free();
  return rows;
}
function get(sql, params) {
  const stmt = db.prepare(sql);
  stmt.bind(params || []);
  let row = null;
  if (stmt.step()) row = rowToObj(stmt, stmt.get());
  stmt.free();
  return row;
}

function getMetaAll() {
  const rows = all('SELECT k, v FROM meta');
  const m = {};
  for (const r of rows) m[r.k] = r.v;
  return m;
}
function setMeta(obj) {
  const stmt = db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)');
  for (const k of Object.keys(obj)) {
    stmt.bind([k, obj[k] == null ? '' : String(obj[k])]);
    stmt.run();
  }
  stmt.free();
  persist();
}

// ---------- 读取全部状态（内存对象，供 WebSocket 广播） ----------
function loadState() {
  const m = getMetaAll();
  const contestants = all('SELECT id, name, desc, avatar FROM contestants ORDER BY sort_order');
  const judges = all('SELECT id, name, avatar, password, role FROM judges ORDER BY sort_order');
  const scores = {};
  const scRows = all('SELECT contestantId, judgeId, judgeName, judgeType, judgeAvatar, score, t FROM scores');
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

// ---------- 写入全部状态（每次改动后调用） ----------
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
  db.run('BEGIN');
  try {
    run('DELETE FROM contestants');
    const ci = db.prepare('INSERT INTO contestants (id, name, desc, avatar, sort_order) VALUES (?, ?, ?, ?, ?)');
    state.contestants.forEach((c, i) => { ci.bind([c.id, c.name, c.desc || '', c.avatar || '', i]); ci.run(); });
    ci.free();

    run('DELETE FROM judges');
    const ji = db.prepare('INSERT INTO judges (id, name, avatar, password, role, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    state.judges.forEach((j, i) => { ji.bind([j.id, j.name, j.avatar || '', j.password || '', j.role || 'pro', i]); ji.run(); });
    ji.free();

    run('DELETE FROM scores');
    const si = db.prepare('INSERT INTO scores (contestantId, judgeId, judgeName, judgeType, judgeAvatar, score, t) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const cid of Object.keys(state.scores || {})) {
      for (const s of (state.scores[cid] || [])) {
        si.bind([cid, s.judgeId, s.judgeName || '', s.judgeType || 'pro', s.judgeAvatar || '', s.score, s.t || Date.now()]);
        si.run();
      }
    }
    si.free();

    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
  persist();
}

// ---------- 首次启动：库为空且存在旧 config.json 时，把数据迁过来；之后可删除 config.json ----------
function migrateIfNeeded() {
  const cnt = get('SELECT COUNT(*) AS n FROM meta').n;
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

module.exports = { init, loadState, saveState, migrateIfNeeded };
