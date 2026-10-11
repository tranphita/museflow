import {
  countHighlights,
  parseCharacters,
  parseMusic,
  parseSceneScript,
  parseSubtitleMode,
  parseVoiceLines,
  stripHighlights,
} from './scene-script.js';
import { scheduleVoices } from './ffmpeg-plan.js';
import { MUSE_VIDEO_SECONDS } from './node-defs.js';

const GENERAL_RULE_NAMES = new Set(['chung', 'tất cả', 'tat ca', 'all', 'everyone']);
const MAX_MUSE_SECONDS = 10;
const MAX_SUBTITLE_CHARS = 70;
const NEGATION =
  /(?<![\p{L}])(?:tháo|bỏ|cởi|gỡ|không\s+(?:đeo|mặc|có|để|cầm|mang)|without|no|remove[sd]?|take[sn]?\s+off)\s+([^,.;:!?\n]{2,30})/giu;
const STOPWORDS = new Set(
  'luôn đeo mặc để giữ cầm mang trong mọi cảnh khi của với và các những một màu kiểu always wear wears keep keeps every scene the a an with and in on of'.split(
    ' ',
  ),
);

const norm = text => text.normalize('NFC').toLowerCase();
// Compound nouns that contain a banned word but mean something else (camera lens, glass door).
const COMPOUNDS = /(?:ống|cửa|tường|vách|mặt|tủ)\s+kính|kính\s+(?:thiên\s+văn|hiển\s+vi|lúp)/giu;
const keywords = text =>
  norm(text)
    .replace(COMPOUNDS, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(word => word.length >= 3 && !STOPWORDS.has(word));

export function parseRules(text) {
  const firstScene = text.search(/^\s*CẢNH\s+\d+/im);
  const preamble = firstScene >= 0 ? text.slice(0, firstScene) : text;
  const heading = /^\s*(?:LUẬT|RULES?)\s*:?\s*$/im.exec(preamble);
  const rules = { general: [], byName: {} };
  if (!heading) return rules;
  let started = false;
  for (const line of preamble.slice(heading.index + heading[0].length).split(/\r?\n/)) {
    if (!line.trim()) {
      if (started) break;
      continue;
    }
    const entry = /^\s*[-*•]\s*(?:([^:\n]{1,40}?)\s*:\s*)?(.+?)\s*$/.exec(line);
    if (!entry) break;
    started = true;
    const owner = entry[1]?.trim() || '';
    const items = entry[2]
      .split(';')
      .map(item => item.trim())
      .filter(Boolean);
    if (!owner || GENERAL_RULE_NAMES.has(norm(owner))) rules.general.push(...items);
    else (rules.byName[norm(owner)] ||= []).push(...items);
  }
  return rules;
}

export function rulesFor(rules, names) {
  const personal = names.flatMap(name => (rules.byName[norm(name)] || []).map(rule => `${name}: ${rule}`));
  return [...rules.general, ...personal];
}

export function estimateSpeechSeconds(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const english = words.filter(word => /^[\x20-\x7e]+$/.test(word)).length;
  return english / 2.6 + (words.length - english) / 3.4;
}

function subtitleIssues(line) {
  const en = line.subtitle?.en ?? line.text,
    vi = line.subtitle?.vi ?? '';
  const quote = `“${line.text.slice(0, 40)}${line.text.length > 40 ? '…' : ''}”`;
  const issues = [];
  if (!vi) issues.push(`Câu ${quote} thiếu phần dịch tiếng Việt; hãy viết dạng “English | Tiếng Việt”.`);
  if (stripHighlights(en).includes('*') || stripHighlights(vi).includes('*'))
    issues.push(`Câu ${quote} có dấu * chưa đóng; cụm tô vàng phải viết dạng *cụm từ*.`);
  else if (vi && countHighlights(en) !== countHighlights(vi))
    issues.push(`Câu ${quote} có số cụm tô vàng ở tiếng Anh và tiếng Việt khác nhau.`);
  if (line.text.length > MAX_SUBTITLE_CHARS)
    issues.push(
      `Câu ${quote} dài ${line.text.length} ký tự, quá dài cho phụ đề trên màn hình dọc (tối đa ${MAX_SUBTITLE_CHARS}); hãy tách thành hai câu.`,
    );
  return issues;
}

function sceneCastNames(scene, castNames) {
  if (scene.characterNames.length) return scene.characterNames;
  const text = norm(`${scene.imagePrompt} ${scene.videoPrompt}`);
  return castNames.filter(name => text.includes(norm(name)));
}

export function checkEpisode(script) {
  const issues = [];
  const cast = parseCharacters(script).map(character => character.name);
  const castSet = new Set(cast.map(norm));
  const rules = parseRules(script);
  const add = (level, scene, message) => issues.push({ level, scene: scene?.number ?? null, message });
  const scenes = parseSceneScript(script);
  const bilingual = parseSubtitleMode(script) === 'bilingual';
  if (!scenes.length)
    add('error', null, 'Không tìm thấy cảnh nào. Hãy bắt đầu mỗi cảnh bằng “CẢNH 1 (0:00–0:08): Tiêu đề”.');
  for (const scene of scenes) {
    const declared = scene.characterNames;
    for (const name of declared)
      if (!castSet.has(norm(name)))
        add('error', scene, `“${name}” có trong dòng Nhân vật nhưng không thuộc danh sách nhân vật của bộ.`);
    const inScene = new Set(sceneCastNames(scene, cast).map(norm));
    const prompts = `${scene.imagePrompt}\n${scene.videoPrompt}`;
    if (declared.length)
      for (const name of cast)
        if (!inScene.has(norm(name)) && norm(prompts).includes(norm(name)))
          add(
            'warn',
            scene,
            `${name} xuất hiện trong prompt nhưng không có trong dòng Nhân vật, nên Muse không nhận được ảnh tham chiếu của ${name} cho cảnh này.`,
          );
    const lines = parseVoiceLines(scene.voiceText, cast);
    for (const line of lines)
      if (line.speaker && declared.length && !inScene.has(norm(line.speaker)))
        add('error', scene, `${line.speaker} có lời thoại nhưng không có trong dòng Nhân vật của cảnh này.`);
    if (bilingual)
      for (const line of lines) for (const message of subtitleIssues(line)) add('warn', scene, message);
    if (lines.length) {
      const speech = scheduleVoices(
        lines.map(line => estimateSpeechSeconds(line.text)),
        lines.map(line => line.pauseAfter || 0),
      ).length;
      if (speech > scene.seconds + 0.5)
        add(
          'warn',
          scene,
          `Lời thoại cần khoảng ${speech.toFixed(1)} giây nhưng cảnh chỉ dài ${scene.seconds} giây; clip sẽ được kéo dài bằng cách giữ khung hình cuối.`,
        );
    }
    if (scene.seconds <= MAX_MUSE_SECONDS && !MUSE_VIDEO_SECONDS.includes(scene.seconds))
      add(
        'warn',
        scene,
        `Cảnh dài ${scene.seconds} giây nhưng Muse chỉ làm clip ${MUSE_VIDEO_SECONDS.join(', ')} giây; clip ${Math.min(...MUSE_VIDEO_SECONDS.filter(value => value >= scene.seconds))} giây sẽ bị cắt bớt đuôi, dễ gây giật ở chỗ nối cảnh. Hãy cho cảnh dài đúng ${MUSE_VIDEO_SECONDS.join(', ')} giây.`,
      );
    if (scene.seconds > MAX_MUSE_SECONDS)
      add(
        'warn',
        scene,
        `Cảnh dài ${scene.seconds} giây; Muse chỉ làm clip tối đa ${MAX_MUSE_SECONDS} giây, hãy tách cảnh này làm hai.`,
      );
    const sceneRules = rulesFor(
      rules,
      [...inScene].map(name => cast.find(item => norm(item) === name) || name),
    );
    for (const name of [...inScene]) {
      const owner = cast.find(item => norm(item) === name) || name;
      for (const rule of rules.byName[name] || []) {
        const banned = [...rule.matchAll(NEGATION)].flatMap(match => keywords(match[1]));
        if (!banned.length) continue;
        for (const clause of prompts.split(/[.;,\n]/)) {
          if (!norm(clause).includes(name) || new RegExp(NEGATION.source, 'iu').test(clause)) continue;
          const hit = keywords(clause).find(word => banned.includes(word));
          if (hit) add('error', scene, `“${clause.trim()}” vi phạm luật “${owner}: ${rule}”.`);
        }
      }
    }
    for (const match of prompts.matchAll(NEGATION)) {
      const removed = keywords(match[1]);
      const broken = sceneRules.find(rule => keywords(rule).some(word => removed.includes(word)));
      if (broken) add('error', scene, `“${match[0].trim()}” mâu thuẫn với luật “${broken}”.`);
    }
  }
  return issues;
}

export function checkSeries(bible, { photoNames = [], musicFound = false } = {}) {
  const issues = [];
  const music = parseMusic(bible);
  if (music && !musicFound)
    issues.push({
      level: 'warn',
      scene: null,
      message: `Không tìm thấy file nhạc nền “${music.file}” trong thư mục bộ phim, nên các tập sẽ xuất không có nhạc.`,
    });
  const cast = parseCharacters(bible).map(character => character.name);
  const rules = parseRules(bible);
  const photos = new Set(photoNames.map(norm));
  if (!cast.length)
    issues.push({
      level: 'warn',
      scene: null,
      message: 'Chưa có danh sách NHÂN VẬT, nên không thể giữ nhân vật nhất quán giữa các tập.',
    });
  for (const name of cast) {
    if (!rules.byName[norm(name)]?.length)
      issues.push({
        level: 'info',
        scene: null,
        message: `${name} chưa có dòng LUẬT. Hãy thêm những chi tiết không được thay đổi (kính, kiểu tóc, phụ kiện).`,
      });
    if (photoNames.length && !photos.has(norm(name)))
      issues.push({
        level: 'info',
        scene: null,
        message: `${name} chưa có ảnh trong characters/, nên Muse sẽ tự nghĩ ra khuôn mặt.`,
      });
  }
  return issues;
}
