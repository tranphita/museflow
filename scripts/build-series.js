import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { buildWorkflowFile, readEpisodeScript, readSeriesMusic } from './workflow-file.js';
import { checkEpisode, checkSeries } from '../src/core/script-check.js';
import { SERIES_BIBLE } from '../src/core/series.js';

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
  const biblePath = join(folder, SERIES_BIBLE);
  const bible = existsSync(biblePath) ? readFileSync(biblePath, 'utf8') : '';
  for (const issue of checkSeries(bible, { musicFound: Boolean(readSeriesMusic(folder, bible)) }))
    if (issue.level !== 'info') console.log(`${folder}: ! ${issue.message}`);
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
