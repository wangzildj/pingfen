// 临时测试（串行版）：clearScores 按 contestantId 清分 + resetScoring
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:3999/ws');
const log = (...a) => console.log('[TEST]', ...a);
let phase = 0, cidA = null, cidB = null, judges = [];
let pendingResolve = null;

const countOf = (st, cid) => (st.scores[cid] || []).length;
function sendAndWait(obj) {
  return new Promise((res) => { pendingResolve = res; ws.send(JSON.stringify(obj)); });
}
const totalScores = (st) => Object.keys(st.scores).reduce((n, k) => n + (st.scores[k] || []).length, 0);

ws.on('open', () => log('connected'));
ws.on('error', (e) => { log('WS ERROR', e.message); process.exit(1); });

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'scoreResult') log('scoreResult:', JSON.stringify(msg));
  if (msg.type !== 'state') return;
  const st = msg.state;
  if (pendingResolve) { const r = pendingResolve; pendingResolve = null; r(st); return; }

  if (phase === 0) {
    if (!st.contestants.length || !st.judges.length) { log('本地库无选手/评委'); process.exit(0); }
    cidA = st.currentContestantId || st.contestants[0].id;
    cidB = st.contestants.find(c => c.id !== cidA)?.id || st.contestants[0].id;
    judges = st.judges.slice(0, 2);
    log(`选手A=${cidA} 选手B=${cidB} 评委=${judges.map(j => j.name).join(',')}`);
    phase = 1;
    (async () => {
      await sendAndWait({ type: 'setScoring', value: 'active' });
      for (let i = 0; i < judges.length; i++) {
        await sendAndWait({ type: 'submitScore', judgeId: judges[i].id, contestantId: cidA, score: 90 + i });
        await sendAndWait({ type: 'submitScore', judgeId: judges[i].id, contestantId: cidB, score: 80 + i });
      }
      const stAfter = await sendAndWait({ type: 'setScoring', value: 'idle' });
      const a = countOf(stAfter, cidA), b = countOf(stAfter, cidB);
      log(`造分后: A=${a}条 B=${b}条 scoring=${stAfter.scoring} ${a > 0 && b > 0 ? 'OK' : 'FAIL(造分失败)'}`);
      if (a === 0 || b === 0) process.exit(1);

      const stReset = await sendAndWait({ type: 'clearScores', contestantId: cidA, resetScoring: true });
      const a2 = countOf(stReset, cidA), b2 = countOf(stReset, cidB);
      const pass = a2 === 0 && b2 > 0 && stReset.scoring === 'idle';
      log(`重置A后: A=${a2}条(期望0) B=${b2}条(期望>0) scoring=${stReset.scoring}(期望idle) => ${pass ? 'PASS' : 'FAIL'}`);
      if (!pass) process.exit(1);

      const stClear = await sendAndWait({ type: 'clearScores' });
      const total = totalScores(stClear);
      log(`全清后: 总分数=${total}条 => ${total === 0 ? 'PASS' : 'FAIL'}`);
      log('ALL DONE');
      ws.close(); process.exit(0);
    })();
  }
});
