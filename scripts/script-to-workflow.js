import { readFileSync, writeFileSync } from 'node:fs';
import { workflowFromScript } from '../src/core/film-graph.js';

const [input, output = input?.replace(/\.[^.\\/]+$/, '') + '.workflow.json'] = process.argv.slice(2);
if (!input) {
  console.error('Usage: npm run script-to-workflow -- <script.txt> [output.json]');
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const workflow = workflowFromScript(readFileSync(input, 'utf8'));
const file = {
  format: 'museta-workflow',
  version: 1,
  appVersion: version,
  exportedAt: new Date().toISOString(),
  workflow,
};
writeFileSync(output, `${JSON.stringify(file, null, 2)}\n`);

const count = type => workflow.nodes.filter(node => node.type === type).length;
const characters = workflow.nodes.filter(node => node.data.characterName).length;
console.log(
  `${output}: ${characters} character reference(s), ${count('generateImage') - characters} scene image(s), ${count('generateVideo')} video clip(s).`,
);
