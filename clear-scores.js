// 清除打分数据，保留选手与评委并持久化
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
  const ws = new WebSocket('ws://127.0.0.1:3000/ws');
  await new Promise(r => ws.on('open', r));
  const send = (m) => ws.send(JSON.stringify(m));

  send({ type: 'clearScores' });                       // 仅清分数
  send({ type: 'setMassEnabled', value: false });      // 大众评分恢复默认关闭
  send({ type: 'setScoring', value: 'idle' });         // 评分状态复位
  send({ type: 'setPage', page: 'background' });       // 大屏回到纯背景
  if (st.contestants.length) send({ type: 'setCurrent', id: st.contestants[0].id });
  await wait(500);

  const after = await getState();
  console.log('=== 清理后状态 ===');
  console.log('选手(保留):', after.contestants.map(c => c.name).join(', '));
  console.log('评委(保留):', after.judges.map(j => `${j.name}(${j.role === 'mass' ? '大众' : '专业'})`).join(', '));
  console.log('分数记录:', JSON.stringify(after.scores));
  console.log('大众评分开关:', after.massEnabled, '| 评分状态:', after.scoring, '| 页面:', after.page);
  ws.close();
  process.exit(0);
})();
