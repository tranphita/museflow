export function scriptField(section, label, nextLabels) {
  const startPattern = new RegExp(`^\\s*${label}\\s*:\\s*`, 'im'),
    match = startPattern.exec(section);
  if (!match) return '';
  const start = match.index + match[0].length,
    tail = section.slice(start),
    stop = nextLabels.length ? new RegExp(`^\\s*(?:${nextLabels.join('|')})\\s*:`, 'im').exec(tail) : null;
  return tail.slice(0, stop ? stop.index : tail.length).trim();
}
export function parseSceneScript(text) {
  const heading = /^\s*CẢNH\s+(\d+)\s*\(([^)]*)\)\s*:\s*(.*?)\s*$/gim,
    matches = [...text.matchAll(heading)];
  return matches
    .map((match, index) => {
      const body = text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length),
        imagePrompt = scriptField(body, 'Prompt\\s+ảnh', ['Prompt\\s+video', 'Audio']),
        videoPrompt = scriptField(body, 'Prompt\\s+video', ['Audio']),
        audio = scriptField(body, 'Audio', []),
        range = match[2].match(/(\d+):(\d{2})\s*[–—-]\s*(\d+):(\d{2})/);
      const seconds = range
        ? Number(range[3]) * 60 + Number(range[4]) - (Number(range[1]) * 60 + Number(range[2]))
        : 0;
      const ratio = (imagePrompt + ' ' + videoPrompt).match(/\b(9:16|16:9|1:1|4:3|3:4)\b/);
      return {
        number: Number(match[1]),
        title: match[3].trim(),
        imagePrompt,
        videoPrompt: [videoPrompt, audio ? `Audio direction: ${audio}` : ''].filter(Boolean).join('\n\n'),
        seconds: seconds > 0 ? seconds : 6,
        size: ratio?.[1] || '9:16',
      };
    })
    .filter(scene => scene.imagePrompt || scene.videoPrompt);
}
