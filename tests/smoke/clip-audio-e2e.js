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

  const exportWith = async clipAudio => {
    await page.evaluate(async clipAudio => {
      const recordLoudClip = async ms => {
        const canvas = document.createElement('canvas');
        canvas.width = 360;
        canvas.height = 640;
        const context = canvas.getContext('2d');
        const audio = new AudioContext();
        const tone = audio.createOscillator();
        const destination = audio.createMediaStreamDestination();
        tone.connect(destination);
        tone.start();
        const stream = new MediaStream([...canvas.captureStream(24).getVideoTracks(), ...destination.stream.getAudioTracks()]);
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' });
        const chunks = [];
        recorder.ondataavailable = event => chunks.push(event.data);
        const done = new Promise(resolve => (recorder.onstop = resolve));
        recorder.start(100);
        const started = performance.now();
        while (performance.now() - started < ms) {
          context.fillStyle = '#6688aa';
          context.fillRect(0, 0, 360, 640);
          await new Promise(r => setTimeout(r, 40));
        }
        recorder.stop();
        await done;
        tone.stop();
        await audio.close();
        return URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
      };
      const silentVoice = seconds => {
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
        return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
      };
      const clip = await recordLoudClip(3000);
      const { state } = await import('/src/core/state.js');
      const { render } = await import('/src/app/render.js');
      state.nodes = [
        { id: 'v1', type: 'generateVideo', x: 40, y: 40, data: { size: '9:16', duration: 5, status: 'success', asset: { id: 'a1', kind: 'video', url: clip } } },
        { id: 's1', type: 'voiceover', x: 40, y: 400, data: { text: 'Hi', status: 'success', asset: { id: 's1a', kind: 'audio', url: silentVoice(1), duration: 1 } } },
        { id: 'tl', type: 'timeline', x: 0, y: 0, data: { dockOnly: true, clipOrder: ['v1'], durations: { v1: 2.8 }, clipAudio } },
      ];
      state.edges = [{ id: 'e1', source: 's1', sourcePort: 'audio', target: 'v1', targetPort: 'voice' }];
      render();
    }, clipAudio);
    const selected = await page.locator('#timelineClipAudio').inputValue();
    await page.selectOption('#timelineExportFormat', 'mp4');
    await page.click('#timelineExportBtn');
    await page.waitForFunction(() => /đã xuất|thất bại|đã dừng/i.test(document.querySelector('#runStatus').textContent), null, { timeout: 120000 });
    const status = await page.locator('#runStatus').textContent();
    const loudness = await page.evaluate(async () => {
      const { state } = await import('/src/core/state.js');
      if (!state.timelineExportUrl) return null;
      const bytes = new Uint8Array(await (await fetch(state.timelineExportUrl)).arrayBuffer());
      const ffmpeg = new window.FFmpegWASM.FFmpeg();
      const logs = [];
      ffmpeg.on('log', event => logs.push(event.message));
      await ffmpeg.load({ coreURL: chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.js'), wasmURL: chrome.runtime.getURL('vendor/ffmpeg/ffmpeg-core.wasm') });
      await ffmpeg.writeFile('/out.mp4', bytes);
      const peak = async (start, length) => {
        logs.length = 0;
        await ffmpeg.exec(['-ss', String(start), '-t', String(length), '-i', '/out.mp4', '-af', 'volumedetect', '-vn', '-f', 'null', '-']);
        return logs.find(line => /max_volume/.test(line))?.replace(/.*max_volume:/, '').trim() || null;
      };
      const result = { duringSpeech: await peak(0.4, 0.6), afterSpeech: await peak(1.8, 0.8) };
      ffmpeg.terminate();
      return result;
    });
    return { clipAudio, selected, status, loudness };
  };
  const kept = await exportWith('keep');
  const ducked = await exportWith('duck');
  const muted = await exportWith('mute');
  return { kept, ducked, muted, errors };
}
