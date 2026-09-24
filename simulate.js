// 演示数据：添加选手+评委，模拟打分完成（部分评委未打分以展示状态）
const http = require('http');
const WebSocket = require('ws');

function getState() {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:3000/api/state', r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const st = await getState();
  const ws = new WebSocket('http://127.0.0.1:3000/ws'.replace('http', 'ws'));
  await new Promise(r => ws.on('open', r));
  const send = (m) => ws.send(JSON.stringify(m));

  // 清空旧数据
  st.contestants.forEach(c => send({ type: 'removeContestant', id: c.id }));
  st.judges.forEach(j => send({ type: 'removeJudge', id: j.id }));
  send({ type: 'clearScores' });
  send({ type: 'setMassEnabled', value: false });
  send({ type: 'setScoring', value: 'idle' });
  send({ type: 'setCurrent', id: null });
  send({ type: 'setPage', page: 'background' });
  await wait(200);

  // 添加选手
  const cnames = ['林晓', '陈航', '苏婷'];
  const cdescs = ['钢琴独奏《月光》', '声乐《我的祖国》', '舞蹈《丝路》'];
  const cids = [];
  cnames.forEach((n, i) => {
    send({ type: 'addContestant', name: n, desc: cdescs[i], avatar: '' });
  });
  await wait(200);
  const st2 = await getState();
  const contestants = st2.contestants;
  const cur = contestants[0];

  // 添加评委：3 专业 + 1 大众
  const judges = [
    { name: '张明', role: 'pro', password: '1111' },
    { name: '李红', role: 'pro', password: '2222' },
    { name: '王强', role: 'pro', password: '3333' },
    { name: '赵大众', role: 'mass', password: '4444' },
  ];
  judges.forEach(j => send({ type: 'addJudge', name: j.name, password: j.password, role: j.role, avatar: '' }));
  await wait(200);

  // 启用大众评分（演示双轨）
  send({ type: 'setMassEnabled', value: true });
  // 设定当前选手并开始评分
  send({ type: 'setCurrent', id: cur.id });
  send({ type: 'setScoring', value: 'active' });
  await wait(200);

  const st3 = await getState();
  const jmap = {};
  st3.judges.forEach(j => jmap[j.name] = j.id);

  // 模拟 3 位评委打分（赵大众未打分，用于展示「未打分」状态）
  const scores = [
    { name: '张明', score: 92.5 },
    { name: '李红', score: 88.0 },
    { name: '王强', score: 95.5 },
  ];
  for (const s of scores) {
    send({ type: 'submitScore', judgeId: jmap[s.name], contestantId: cur.id, score: s.score });
    await wait(120);
  }
  // 结束评分
  send({ type: 'setScoring', value: 'ended' });
  send({ type: 'setPage', page: 'scoring' });
  await wait(300);

  const final = await getState();
  console.log('选手数:', final.contestants.length, '评委数:', final.judges.length);
  console.log('当前选手:', final.contestants.find(c => c.id === final.currentContestantId).name);
  console.log('大众评分启用:', final.massEnabled, '评分状态:', final.scoring);
  console.log('当前选手分数记录:', (final.scores[cur.id] || []).map(s => s.judgeName + '=' + s.score).join(', '));
  ws.close();
  process.exit(0);
})();
