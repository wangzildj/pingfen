const { chromium } = require('playwright');
const fs = require('fs');
const dir = 'D:/treaWork/pingfen/shots';
fs.mkdirSync(dir, { recursive: true });

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-setuid-sandbox']
  });
  console.log('浏览器已启动');

  // 1) 大屏打分页
  const big = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const sp = await big.newPage();
  await sp.goto('http://127.0.0.1:3000/screen', { waitUntil: 'domcontentloaded' });
  await sp.waitForSelector('.judge-mini', { timeout: 10000 });
  await sp.waitForTimeout(700);
  await sp.screenshot({ path: `${dir}/1-大屏打分页.png` });
  console.log('✓ 大屏打分页');
  await big.close();

  // 2) 手机控制端：评委打分进度
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 });
  const cp = await phone.newPage();
  await cp.goto('http://127.0.0.1:3000/control', { waitUntil: 'domcontentloaded' });
  await cp.waitForSelector('#judgeProgress .jp-item', { timeout: 10000 });
  await cp.waitForTimeout(500);
  await cp.screenshot({ path: `${dir}/2-手机控制-评委进度.png`, fullPage: true });
  console.log('✓ 手机控制-评委进度');

  // 3) 评委打分端：登录后展示（张明，已打分 92.5）
  const jp = await phone.newPage();
  await jp.goto('http://127.0.0.1:3000/judge', { waitUntil: 'domcontentloaded' });
  await jp.waitForSelector('#judgeSel', { timeout: 10000 });
  await jp.waitForFunction(() => document.querySelectorAll('#judgeSel option').length > 1, { timeout: 10000 });
  const val = await jp.$eval('#judgeSel', sel => {
    for (const o of sel.options) if (o.textContent.includes('张明')) return o.value;
    return sel.options[0].value;
  });
  await jp.selectOption('#judgeSel', val);
  await jp.fill('#pwd', '1111');
  await jp.click('#loginBtn');
  await jp.waitForSelector('#scoreBox', { state: 'visible', timeout: 10000 });
  await jp.waitForTimeout(600);
  await jp.screenshot({ path: `${dir}/3-评委打分端.png`, fullPage: true });
  console.log('✓ 评委打分端');

  await phone.close();
  console.log('全部截图完成：\n' + fs.readdirSync(dir).filter(f => f.endsWith('.png')).join('\n'));

  // 关闭浏览器可能挂起，给 3 秒宽限后直接退出
  Promise.race([
    browser.close(),
    new Promise(r => setTimeout(r, 3000))
  ]).finally(() => process.exit(0));
})().catch(e => { console.error('截图失败:', e); process.exit(1); });
