async page => {
  const base = 'http://127.0.0.1:8765';
  const stub = await (await fetch(`${base}/tests/smoke/chrome-stub.js`)).text();
  await page.addInitScript(stub);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const check = async (tabs, replies) => {
    await page.addInitScript(
      ({ tabs, replies }) => {
        window.__museTabs = tabs;
        window.__museReply = (message, tabId) =>
          /CHECK_SESSION$/.test(message.type) ? replies[tabId] : { ok: true, checks: [] };
      },
      { tabs, replies },
    );
    await page.goto(`${base}/app.html`);
    await page.waitForFunction(() => /Phiên Muse|phiên Muse|Chat Muse/.test(document.querySelector('#museStatus')?.textContent || ''), null, { timeout: 10000 });
    return page.evaluate(() => ({
      status: document.querySelector('#museStatus').textContent,
      title: document.querySelector('#museStatus').title,
      asked: window.__museTabMessages.filter(m => /CHECK_SESSION$/.test(m.message.type)).map(m => m.tabId),
    }));
  };
  const notChat = { ok: false, error: 'Khung chat Muse chưa sẵn sàng. Mở trang chat Muse và chờ ô nhập tin nhắn tải xong.' };
  const ready = { ok: true, signedIn: true, composer: true };
  const secondTabWins = await check(
    [
      { id: 5, active: true, url: 'https://muse.ai/library' },
      { id: 7, active: false, url: 'https://muse.ai/chat' },
    ],
    { 5: notChat, 7: ready },
  );
  const noChatAnywhere = await check([{ id: 5, active: true, url: 'https://muse.ai/library' }], { 5: notChat });
  return { secondTabWins, noChatAnywhere, errors };
}
