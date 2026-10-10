async page => {
  const base = 'http://127.0.0.1:8765';
  const context = page.context();
  const stub = await (await fetch(`${base}/tests/smoke/chrome-stub.js`)).text();
  await context.addInitScript(stub);
  await context.addInitScript(() => {
    const frame = (size, color) => {
      const [w, h] = String(size || '1:1')
        .split(':')
        .map(Number);
      const canvas = document.createElement('canvas');
      canvas.width = (w || 1) * 20;
      canvas.height = (h || 1) * 20;
      const context2d = canvas.getContext('2d');
      context2d.fillStyle = color;
      context2d.fillRect(0, 0, canvas.width, canvas.height);
      return canvas;
    };
    const clips = {};
    const recordClip = async size => {
      const canvas = frame(size, '#36c');
      const recorder = new MediaRecorder(canvas.captureStream(24), { mimeType: 'video/webm;codecs=vp8' });
      const chunks = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const stopped = new Promise(resolve => (recorder.onstop = resolve));
      recorder.start(100);
      const started = performance.now();
      const context2d = canvas.getContext('2d');
      while (performance.now() - started < 1500) {
        context2d.fillStyle = `hsl(${Math.round(performance.now() / 10) % 360} 60% 50%)`;
        context2d.fillRect(0, 0, 20, 20);
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      recorder.stop();
      await stopped;
      return URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
    };
    window.__museTabs = [
      { id: 7, url: 'https://muse.ai/chat' },
      { id: 8, url: 'https://muse.ai/chat' },
    ];
    window.__museReply = async message => {
      if (/CHECK_SESSION$/.test(message.type)) return { ok: true, signedIn: true, composer: true };
      if (!/GENERATE$/.test(message.type)) return { ok: true };
      if (localStorage.getItem('smoke-mode') === 'credits')
        return { ok: false, error: 'Muse account has insufficient image credits.' };
      const title = /title:(\w+)/.exec(message.prompt)?.[1] || 'unknown';
      const counts = JSON.parse(localStorage.getItem('smoke-counts') || '{}');
      counts[title] = (counts[title] || 0) + 1;
      localStorage.setItem('smoke-counts', JSON.stringify(counts));
      await new Promise(resolve => setTimeout(resolve, Number(localStorage.getItem('smoke-delay') || 300)));
      if (message.mediaType === 'video')
        return { ok: true, url: (clips[message.size] ||= await recordClip(message.size)) };
      return { ok: true, url: frame(message.size, '#c63').toDataURL('image/png') };
    };
  });
  const errors = [];
  const watch = target =>
    target.on('pageerror', error => {
      if (!target.url().startsWith('about:')) errors.push(`${target.url()}: ${error}`);
    });
  watch(page);
  context.on('page', watch);
  const until = async (label, predicate, timeout = 240000, interval = 500) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await page.evaluate(predicate);
      if (value) return value;
      await page.waitForTimeout(interval);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };

  await page.goto(`${base}/app.html`);
  await page.evaluate(async () => {
    sessionStorage.clear();
    localStorage.clear();
    localStorage.setItem('museta-view', 'production');
    localStorage.setItem('smoke-delay', '4000');
    for (const name of ['museta-library', 'museflow-media'])
      await new Promise(resolve => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = request.onerror = request.onblocked = resolve;
      });
  });
  await page.reload();
  await page.waitForTimeout(800);

  await page.evaluate(async () => {
    const store = await import('/src/app/library-store.js');
    const { createJob, interleave } = await import('/src/core/jobs.js');
    const scene = (title, n) =>
      `CẢNH ${n} (0:0${(n - 1) * 2}–0:0${n * 2}): Shot ${n}\nPrompt ảnh: A red ball on a table, title:${title} shot ${n}\nPrompt video: The ball rolls slowly, title:${title} shot ${n}`;
    const script = (seriesId, title) =>
      `TÊN BỘ: ${seriesId}\n\nTIÊU ĐỀ: ${title}\n\n${scene(title, 1)}\n\n${scene(title, 2)}`;
    for (const id of ['smoke-a', 'smoke-b'])
      await store.saveSeries({
        id,
        folder: id,
        name: id,
        bible: `TÊN BỘ: ${id}`,
        characters: {},
        episodes: [],
        importedAt: 0,
      });
    const groups = [
      [
        ['smoke-a', 'ep01.txt', 'A1'],
        ['smoke-a', 'ep02.txt', 'A2'],
      ],
      [['smoke-b', 'ep01.txt', 'B1']],
    ];
    await store.putJobs(
      interleave(groups).map(([seriesId, episodeId, title], index) =>
        createJob({
          seriesId,
          episodeId,
          title,
          fileName: `${title}.mp4`,
          script: script(seriesId, title),
          order: index + 1,
        }),
      ),
    );
    await store.updateQueueControl({ paused: false, leaseMs: 6000, pollMs: 500, workers: 2 });
  });

  const openWorker = async (id, muse) => {
    const worker = await context.newPage();
    await worker.goto(`${base}/app.html?worker=${id}&muse=${muse}`);
    return worker;
  };
  const worker1 = await openWorker(1, 7);
  await openWorker(2, 8);

  const killed = await until('worker 1 to checkpoint two finished steps', async () => {
    const jobs = await (await import('/src/app/library-store.js')).listJobs();
    const job = jobs.find(
      item =>
        item.workerId === '1' &&
        item.status === 'running' &&
        (item.checkpoint?.nodes || []).filter(
          node => /^generate/.test(node.type) && node.data.status === 'success',
        ).length >= 2,
    );
    return job ? { id: job.id, title: job.title } : null;
  });
  await page.evaluate(async () => (await import('/src/app/persistence.js')).queueWorkflowSave());
  await worker1.close();

  const finished = await until('all three episodes to reach review', async () => {
    const store = await import('/src/app/library-store.js');
    const jobs = await store.listJobs();
    if (jobs.length !== 3 || !jobs.every(job => job.status === 'review')) return null;
    const sizes = [];
    for (const job of jobs) sizes.push((await store.getOutput(job.outputKey))?.size || 0);
    return jobs.map((job, index) => ({ title: job.title, attempts: job.attempts, size: sizes[index] }));
  });
  const counts = await page.evaluate(() => JSON.parse(localStorage.getItem('smoke-counts') || '{}'));

  await page.evaluate(async () => {
    localStorage.setItem('smoke-delay', '300');
    const store = await import('/src/app/library-store.js');
    const { createJob } = await import('/src/core/jobs.js');
    await store.putJobs([
      createJob({
        seriesId: 'smoke-a',
        episodeId: 'ep03.txt',
        title: 'D1',
        fileName: 'D1.mp4',
        script: 'TÊN BỘ: smoke-a\n\nCẢNH 1 (0:00–0:02): x\nPrompt ảnh: title:D1 a ball\nPrompt video: title:D1 it rolls',
        order: 5,
      }),
    ]);
  });
  const stolenId = await until(
    'D1 to start exporting',
    async () => {
      const store = await import('/src/app/library-store.js');
      const job = (await store.listJobs()).find(item => item.title === 'D1' && item.status === 'exporting');
      if (!job) return null;
      await store.updateJob(job.id, { workerId: '9', heartbeatAt: Date.now() + 600000 });
      return job.id;
    },
    120000,
    100,
  );
  await page.waitForTimeout(8000);
  const theft = await page.evaluate(async id => {
    const store = await import('/src/app/library-store.js');
    const { jobOutputKey } = await import('/src/core/jobs.js');
    const job = (await store.listJobs()).find(item => item.id === id);
    const output = (await store.getOutput(jobOutputKey(job))) || (await store.getOutput('smoke-a/ep03.txt'));
    await store.deleteJob(id);
    return { status: job.status, workerId: job.workerId, output: Boolean(output) };
  }, stolenId);

  await page.evaluate(async () => {
    localStorage.setItem('smoke-mode', 'credits');
    const store = await import('/src/app/library-store.js');
    const { createJob } = await import('/src/core/jobs.js');
    await store.putJobs([
      createJob({
        seriesId: 'smoke-b',
        episodeId: 'ep02.txt',
        title: 'C1',
        fileName: 'C1.mp4',
        script: 'TÊN BỘ: smoke-b\n\nCẢNH 1 (0:00–0:02): x\nPrompt ảnh: title:C1 a ball',
        order: 10,
      }),
    ]);
  });
  const paused = await until('the queue to pause on missing credits', async () => {
    const store = await import('/src/app/library-store.js');
    const control = await store.getQueueControl();
    const job = (await store.listJobs()).find(item => item.title === 'C1');
    return control.paused
      ? { reason: control.reason, status: job.status, attempts: job.attempts, kind: job.errorKind }
      : null;
  });
  await page.waitForTimeout(2500);
  const ui = await page.evaluate(() => ({
    rows: document.querySelectorAll('#production .job-row').length,
    banner: document.querySelector('#production .production-banner')?.textContent || '',
    keepAwakeEver: Boolean(window.__keepAwakeEver),
  }));

  const pass =
    finished.every(item => item.size > 0) &&
    counts[killed.title] <= 6 &&
    Object.entries(counts)
      .filter(([title]) => title !== killed.title && title !== 'C1')
      .every(([, count]) => count === 4) &&
    finished.find(item => item.title === killed.title).attempts === 2 &&
    theft.status === 'exporting' &&
    theft.workerId === '9' &&
    !theft.output &&
    paused.reason === 'credits' &&
    paused.status === 'queued' &&
    paused.attempts === 0 &&
    ui.rows === 4 &&
    /credits/i.test(ui.banner) &&
    ui.keepAwakeEver &&
    errors.length === 0;
  return { pass, killed, finished, counts, theft, paused, ui, errors };
}
