async page => {
  const base = 'http://127.0.0.1:8765';
  const stub = await (await fetch(`${base}/tests/smoke/chrome-stub.js`)).text();
  await page.addInitScript(stub);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(`${base}/app.html`);
  await page.evaluate(() => {
    sessionStorage.clear();
    localStorage.setItem('museta-view', 'canvas');
  });
  await page.reload();
  await page.waitForTimeout(800);

  await page.evaluate(async () => {
    const recordClip = async (color, ms) => {
      const canvas = document.createElement('canvas');
      canvas.width = 360;
      canvas.height = 640;
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
        context.fillRect(0, 0, 360, 640);
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
    const [clipA, clipB] = [await recordClip('#6688aa', 1500), await recordClip('#aa8866', 1500)];
    const { state } = await import('/src/core/state.js');
    const { render } = await import('/src/app/render.js');
    const voice = (id, text, subtitle) => ({
      id,
      type: 'voiceover',
      x: 40,
      y: 400,
      data: { text, subtitle, status: 'success', asset: { id: `${id}a`, kind: 'audio', url: sineWav(1), duration: 1 } },
    });
    const withPause = (node, seconds) => ({ ...node, data: { ...node.data, pauseAfter: seconds } });
    state.nodes = [
      { id: 'v1', type: 'generateVideo', x: 40, y: 40, data: { size: '9:16', duration: 5, status: 'success', asset: { id: 'a1', kind: 'video', url: clipA } } },
      { id: 'v2', type: 'generateVideo', x: 400, y: 40, data: { size: '9:16', duration: 5, status: 'success', asset: { id: 'a2', kind: 'video', url: clipB } } },
      withPause(voice('s1', 'Say Can I have some milk?', { en: 'Say *Can I have some milk?*', vi: 'Con nói *Con uống sữa được không ạ?*' }), 2),
      voice('s2', 'Can I have some pancakes?', { en: '*Can I have some* pancakes?', vi: '*Con ăn* bánh kếp *được không ạ*?' }),
      { id: 'tl', type: 'timeline', x: 0, y: 0, data: { dockOnly: true, clipOrder: ['v1', 'v2'], durations: { v1: 2, v2: 2 }, subtitles: 'bilingual', learningFx: ['karaoke', 'countdown', 'pop'], transition: { type: 'fade', duration: 0.5 } } },
    ];
    state.edges = [
      { id: 'e1', source: 's1', sourcePort: 'audio', target: 'v1', targetPort: 'voice' },
      { id: 'e2', source: 's2', sourcePort: 'audio', target: 'v2', targetPort: 'voice' },
    ];
    render();
  });
  const checkbox = await page.locator('#timelineSubtitles').isChecked();
  await page.selectOption('#timelineExportFormat', 'mp4');
  await page.click('#timelineExportBtn');
  await page.waitForFunction(() => /đã xuất|thất bại|đã dừng/i.test(document.querySelector('#runStatus').textContent), null, { timeout: 120000 });
  const status = await page.locator('#runStatus').textContent();
  const frame = await page.evaluate(async () => {
    const { state } = await import('/src/core/state.js');
    if (!state.timelineExportUrl) return null;
    const bytes = new Uint8Array(await (await fetch(state.timelineExportUrl)).arrayBuffer());
    const size = bytes.length;
    const ffmpeg = new window.FFmpegWASM.FFmpeg();
    await ffmpeg.load({ coreURL: chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.js'), wasmURL: chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.wasm') });
    await ffmpeg.writeFile('/out.mp4', bytes);
    const logs = [];
    ffmpeg.on('log', event => logs.push(event.message));
    await ffmpeg.exec(['-i', '/out.mp4']);
    const duration = /Duration: ([\d:.]+)/.exec(logs.join(' '))?.[1];
    await ffmpeg.exec(['-ss', '1.9', '-i', '/out.mp4', '-frames:v', '1', '/frame.png']);
    const png = await ffmpeg.readFile('/frame.png');
    await ffmpeg.exec(['-ss', '0.5', '-i', '/out.mp4', '-frames:v', '1', '/karaoke.png']);
    const karaoke = await ffmpeg.readFile('/karaoke.png');
    ffmpeg.terminate();
    const pngSize = png.length;
    const url = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
    const karaokeUrl = URL.createObjectURL(new Blob([karaoke], { type: 'image/png' }));
    document.body.innerHTML = `<img src="${karaokeUrl}" style="height:640px"><img id="frame" src="${url}" style="height:640px">`;
    return { size, pngSize, duration };
  });
  return { checkbox, status, frame, errors };
}
