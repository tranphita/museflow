import { writeFileSync } from 'node:fs';
import { buildWorkflowFile } from './workflow-file.js';

const [input, output = input?.replace(/\.[^.\\/]+$/, '') + '.workflow.json'] = process.argv.slice(2);
if (!input) {
  console.error('Usage: npm run script-to-workflow -- <script.txt> [output.json]');
  process.exit(1);
}

const { file, summary } = buildWorkflowFile(input);
writeFileSync(output, `${JSON.stringify(file, null, 2)}\n`);
console.log(`${output}: ${summary}`);
