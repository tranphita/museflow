import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMusePrompt,
  characterLockInstruction,
  isStylizedStyle,
  lipSyncInstruction,
  styleLockInstruction,
} from '../../src/core/prompts.js';
import { parsePauseLine, parseVoiceLines } from '../../src/core/scene-script.js';
import { clipLengthForVoices, dialogueTiming, scheduleVoices } from '../../src/core/ffmpeg-plan.js';
import { buildSubtitleEvents } from '../../src/core/subtitle-plan.js';
import { videoDurationFor, workflowFromScript } from '../../src/core/film-graph.js';
import { checkEpisode } from '../../src/core/script-check.js';

const PIXAR = 'hoạt hình 3D kiểu phim Pixar, màu pastel';
const REAL = 'phim người thật, photorealistic như quay bằng máy cinema 35mm';

test('animated styles are told apart from live-action ones', () => {
  assert.equal(isStylizedStyle(PIXAR), true);
  assert.equal(isStylizedStyle('2D anime watercolor'), true);
  assert.equal(isStylizedStyle(REAL), false);
  assert.equal(isStylizedStyle('hoạt hình nhưng người thật đóng'), false);
  assert.equal(isStylizedStyle(''), false);
});

test('the style lock forbids drifting into photorealism only for animated films', () => {
  assert.match(styleLockInstruction(PIXAR), /^STYLE LOCK .*Pixar.*Never switch to photorealistic/s);
  assert.match(styleLockInstruction(PIXAR), /close-ups of food/);
  assert.doesNotMatch(styleLockInstruction(REAL), /Never switch/);
  assert.equal(styleLockInstruction('  '), '');
});

test('animated characters are locked to their design, not described as real photos', () => {
  const lock = characterLockInstruction(['Mommy', 'Mia'], { stylized: true });
  assert.match(lock, /Image #1 is a character design reference of Mommy/);
  assert.doesNotMatch(lock, /real (?:photo|people)|No beautifying, stylizing/);
  assert.match(characterLockInstruction(['Hảo'], {}), /Image #1 is a real photo of Hảo/);
});

test('video prompts lead with the style lock and add lip-sync timing after the prompt', () => {
  const prompt = buildMusePrompt({
    mediaType: 'video',
    size: '9:16',
    duration: 8,
    prompt: 'Mia asks for milk',
    referenceCount: 2,
    characterNames: ['Mia', 'Mommy'],
    filmStyle: PIXAR,
    dialogue: [
      { speaker: 'Mia', text: 'Can I have some milk, please?', start: 0.2, end: 2.34 },
      { speaker: 'Mommy', text: 'Of course!', start: 2.69, end: 3.5 },
    ],
  });
  const sections = prompt.split('\n\n');
  assert.match(sections[1], /^STYLE LOCK/);
  assert.match(sections[2], /^IDENTITY LOCK .*\n- Image #1 is a character design reference of Mia/);
  const promptAt = sections.indexOf('Prompt: Mia asks for milk');
  assert.match(sections[promptAt + 1], /^LIP-SYNC/);
  assert.match(sections[promptAt + 1], /- 0\.2–2\.3 s · Mia: "Can I have some milk, please\?"/);
  assert.match(sections[promptAt + 1], /- 2\.7–3\.5 s · Mommy: "Of course!"/);
});

test('image prompts also carry the style lock, and prompts without style or dialogue stay unchanged', () => {
  const image = buildMusePrompt({ mediaType: 'image', size: '9:16', prompt: 'kitchen', filmStyle: PIXAR });
  assert.match(image, /^STYLE LOCK/);
  const plain = buildMusePrompt({ mediaType: 'video', size: '1:1', duration: 5, prompt: 'x' });
  assert.doesNotMatch(plain, /STYLE LOCK|LIP-SYNC/);
  assert.equal(lipSyncInstruction([{ speaker: 'Mia', text: '  ', start: 0, end: 1 }]), '');
});

test('pause lines extend the gap after the previous line instead of being spoken', () => {
  assert.equal(parsePauseLine('(nghỉ 3 giây)'), 3);
  assert.equal(parsePauseLine('[pause 2.5s]'), 2.5);
  assert.equal(parsePauseLine('(dừng 1,5 giây)'), 1.5);
  assert.equal(parsePauseLine('(cười)'), 0);
  const lines = parseVoiceLines(
    '- (nghỉ 1 giây)\n- Mia: Your turn! | Đến lượt bạn!\n- (nghỉ 3 giây)\n- Mia: Good night! | Chúc ngủ ngon!',
    ['Mia'],
  );
  assert.deepEqual(
    lines.map(line => [line.text, line.pauseAfter]),
    [
      ['Your turn!', 3],
      ['Good night!', undefined],
    ],
  );
});

test('a pause after an unnamed line stops the next unnamed line from merging into it', () => {
  const lines = parseVoiceLines('One.\n(nghỉ 2 giây)\nTwo.');
  assert.deepEqual(
    lines.map(line => line.text),
    ['One.', 'Two.'],
  );
});

test('pauses push later lines back, hold the end of the clip and keep the subtitle up', () => {
  assert.deepEqual(scheduleVoices([2, 1], [3]), { offsets: [0.2, 5.2], length: 6.5 });
  assert.deepEqual(scheduleVoices([2], [3]), { offsets: [0.2], length: 5.2 });
  assert.deepEqual(scheduleVoices([2, 1], [0.1]), scheduleVoices([2, 1]));
  assert.equal(scheduleVoices([2], [99]).length, 8.2);
  assert.equal(clipLengthForVoices(4, [2], [3]), 5.2);
  const [event] = buildSubtitleEvents({
    clips: [{ duration: 10, voices: [{ offset: 0.2, duration: 2, hold: 3, en: 'Your turn!', vi: '' }] }],
  });
  assert.deepEqual([event.start, event.end], [0.2, 5.2]);
});

test('dialogue timing matches where the export will place each voice', () => {
  assert.deepEqual(
    dialogueTiming([
      { speaker: 'Mia', text: 'Hi', duration: 1.2, pauseAfter: 2 },
      { speaker: '', text: 'Bye', duration: 0.8 },
    ]),
    [
      { speaker: 'Mia', text: 'Hi', start: 0.2, end: 1.4 },
      { speaker: '', text: 'Bye', start: 3.4, end: 4.2 },
    ],
  );
});

test('scenes get the shortest Muse clip that covers them, so no frame is frozen', () => {
  assert.equal(videoDurationFor(7), 8);
  assert.equal(videoDurationFor(8), 8);
  assert.equal(videoDurationFor(4), 5);
  assert.equal(videoDurationFor(14), 10);
});

const series = `PHONG CÁCH: ${PIXAR}
NHÂN VẬT:
- Mia: girl

CẢNH 1 (0:00–0:07): Hook
Nhân vật: Mia
Prompt ảnh: kitchen
Prompt video: Mia waves
Lời thoại:
- Mia: Your turn! | Đến lượt bạn!
- (nghỉ 3 giây)`;

test('the film graph stores the style and pauses on the nodes that need them', () => {
  const workflow = workflowFromScript(series);
  const video = workflow.nodes.find(node => node.type === 'generateVideo');
  const image = workflow.nodes.find(
    node => node.type === 'generateImage' && node.data.sceneLabel.startsWith('Cảnh'),
  );
  const voice = workflow.nodes.find(node => node.type === 'voiceover');
  assert.equal(video.data.duration, 8);
  assert.equal(video.data.filmStyle, PIXAR);
  assert.equal(image.data.filmStyle, PIXAR);
  assert.equal(voice.data.pauseAfter, 3);
});

test('a scene length Muse cannot produce is warned', () => {
  const issues = checkEpisode(series);
  assert.ok(issues.some(issue => /Muse chỉ làm clip 5, 6, 8, 10 giây/.test(issue.message)));
  assert.ok(
    !checkEpisode(series.replace('0:00–0:07', '0:00–0:08')).some(issue =>
      /Muse chỉ làm clip/.test(issue.message),
    ),
  );
});
