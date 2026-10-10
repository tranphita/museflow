import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildWorkflowFile, readEpisodeScript } from './workflow-file.js';
import { checkEpisode } from '../src/core/script-check.js';

const folders = process.argv.slice(2);
if (!folders.length) {
  console.error('Usage: npm run series -- <series folder> [more folders]');
  process.exit(1);
}

for (const folder of folders) {
  const episodes = readdirSync(folder)
    .filter(file => /^ep\d+.*\.txt$/i.test(file))
    .sort();
  if (!episodes.length) {
    console.error(`${folder}: no epXX.txt episode scripts found.`);
    process.exitCode = 1;
    continue;
  }
  const outDir = join(folder, 'workflows');
  mkdirSync(outDir, { recursive: true });
  for (const episode of episodes) {
    const { file, summary } = buildWorkflowFile(join(folder, episode));
    const output = join(outDir, `${basename(episode, '.txt')}.workflow.json`);
    writeFileSync(output, `${JSON.stringify(file, null, 2)}\n`);
    console.log(`${output}: ${summary}`);
    for (const issue of checkEpisode(readEpisodeScript(join(folder, episode))))
      console.log(`  ${issue.level === 'error' ? '✗' : '!'} scene ${issue.scene ?? '-'}: ${issue.message}`);
  }
}
