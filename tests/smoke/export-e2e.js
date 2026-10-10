async page => {
  const base = 'http://127.0.0.1:8765';
  const stub = await (await fetch(`${base}/tests/smoke/chrome-stub.js`)).text();
  await page.addInitScript(stub);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${base}/app.html`);
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await page.waitForTimeout(800);

  await page.evaluate(async () => {
    const recordClip = async (color, ms) => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      const context = canvas.getContext('2d');
      const stream = canvas.captureStream(24);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
      const chunks = [];
      recorder.ondataavailable = event => chunks.push(event.data);
      const done = new Promise(resolve => (recorder.onstop = resolve));
      recorder.start(100);
      const started = performance.now();
      while (performance.now() - started < ms) {
        context.fillStyle = color;
        context.fillRect(0, 0, 320, 180);
        context.fillStyle = '#fff';
        context.fillText(String(Math.round(performance.now() - started)), 20, 40);
        await new Promise(r => setTimeout(r, 40));
      }
      recorder.stop();
      await done;
      return URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
    };
    const sineWav = seconds => {
      const rate = 48000,
        samples = rate * seconds,
        buffer = new ArrayBuffer(44 + samples * 2),
        view = new DataView(buffer);
      const write = (offset, text) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
      write(0, 'RIFF');
      view.setUint32(4, 36 + samples * 2, true);
      write(8, 'WAVE');
      write(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, rate, true);
      view.setUint32(28, rate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      write(36, 'data');
      view.setUint32(40, samples * 2, true);
      for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.sin((i / rate) * 2 * Math.PI * 440) * 8000, true);
      return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
    };
    const [clipA, clipB] = [await recordClip('#c33', 1500), await recordClip('#33c', 1500)];
    const { state } = await import('/src/core/state.js');
    const { render } = await import('/src/app/render.js');
    state.nodes = [
      { id: 'v1', type: 'generateVideo', x: 40, y: 40, data: { size: '16:9', duration: 5, status: 'success', asset: { id: 'a1', kind: 'video', url: clipA } } },
      { id: 'v2', type: 'generateVideo', x: 400, y: 40, data: { size: '16:9', duration: 5, status: 'success', asset: { id: 'a2', kind: 'video', url: clipB } } },
      { id: 'tl', type: 'timeline', x: 0, y: 0, data: { dockOnly: true, clipOrder: ['v1', 'v2'], durations: { v1: 2, v2: 2 }, music: { id: 'm1', url: sineWav(3), name: 'tone.wav', volume: 0.5 }, transition: { type: 'fade', duration: 0.5 } } },
    ];
    state.edges = [];
    render();
  });
  const musicChip = await page.locator('#timelineMusicName').textContent();
  await page.selectOption('#timelineExportFormat', 'mp4');
  const downloadPromise = page.waitForEvent('download', { timeout: 120000 }).catch(() => null);
  await page.click('#timelineExportBtn');
  await page.waitForFunction(() => /exported|failed|stopped/i.test(document.querySelector('#runStatus').textContent), null, { timeout: 120000 });
  const status = await page.locator('#runStatus').textContent();
  const download = await downloadPromise;
  const probe = await page.evaluate(async () => {
    const { state } = await import('/src/core/state.js');
    if (!state.timelineExportUrl) return null;
    const bytes = new Uint8Array(await (await fetch(state.timelineExportUrl)).arrayBuffer());
    const ffmpeg = new window.FFmpegWASM.FFmpeg();
    await ffmpeg.load({ coreURL: chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.js'), wasmURL: chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.wasm') });
    await ffmpeg.writeFile('/out.mp4', bytes);
    await ffmpeg.ffprobe(['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', '/out.mp4', '-o', '/p.json']);
    const json = JSON.parse(await ffmpeg.readFile('/p.json', 'utf8'));
    ffmpeg.terminate();
    return { size: bytes.length, duration: Number(json.format.duration), streams: json.streams.map(s => `${s.codec_type}:${s.codec_name}${s.width ? `:${s.width}x${s.height}` : ''}`) };
  });
  return { musicChip, status, download: download?.suggestedFilename() || null, probe, errors };
}
