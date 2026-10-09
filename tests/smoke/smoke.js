async page => {
  const base = 'http://127.0.0.1:8765';
  const stub = await (await fetch(`${base}/tests/smoke/chrome-stub.js`)).text();
  await page.addInitScript(stub);
  await page.addInitScript(() => {
    const pixel =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    window.__museTabs = [{ id: 7, active: true, url: 'https://muse.ai/chat' }];
    window.__museReply = message => {
      if (/CHECK_SESSION$/.test(message.type)) return { ok: true, signedIn: true, composer: true };
      if (/GENERATE$/.test(message.type)) return { ok: true, url: pixel };
      if (/DIAGNOSE$/.test(message.type)) return { ok: true, checks: [] };
      return { ok: true };
    };
  });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`${base}/app.html`);
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.waitForTimeout(800);
  const results = {};
  results.initialNodes = await page.locator('.node').count();
  results.title = await page.title();

  await page.click('#runBtn');
  await page.waitForFunction(() => /completed/i.test(document.querySelector('#runStatus').textContent), null, {
    timeout: 10000,
  });
  results.runStatus = await page.locator('#runStatus').textContent();
  results.previewHasImage = (await page.locator('.node img').count()) > 0;
  results.sentPrompt = await page.evaluate(
    () => window.__museTabMessages.find(m => /GENERATE$/.test(m.message.type))?.message.prompt.slice(0, 60),
  );

  await page.click('button[data-add="generateVideo"]');
  results.afterAddVideo = await page.locator('.node').count();
  await page.keyboard.press('Control+z');
  results.afterUndo = await page.locator('.node').count();

  await page.click('#scriptImportBtn');
  await page.fill(
    '#scriptInput',
    'CẢNH 1 (0:00–0:07): Mở đầu\nPrompt ảnh: a cat 9:16\nPrompt video: the cat walks\nAudio: soft piano\n\nCẢNH 2 (0:07–0:12): Kết\nPrompt ảnh: a dog\nPrompt video: the dog runs',
  );
  results.scriptDetected = await page.locator('#scriptImportStatus').textContent();
  await page.click('#buildScriptNodes');
  results.afterScript = await page.locator('.node').count();
  results.timelineClips = await page.locator('#timelineClipCount').textContent();

  await page.click('#viewport', { button: 'right', position: { x: 600, y: 600 } });
  results.menuVisible = await page.locator('#canvasMenu:not(.hidden)').count();
  await page.keyboard.press('Escape');

  await page.click('#saveBtn');
  await page.waitForTimeout(300);
  results.saveStatus = await page.locator('#runStatus').textContent();
  await page.reload();
  await page.waitForTimeout(1000);
  results.nodesAfterReload = await page.locator('.node').count();
  results.errors = errors;
  return results;
}
