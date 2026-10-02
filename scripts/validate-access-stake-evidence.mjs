import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { validateRehearsalReceipt } from './access-stake-contracts.mjs';

const ROOT = path.resolve('programs/access-stake/evidence/devnet');

const parseCli = (argv) => {
  const values = { files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--file') values.files.push(path.resolve(argv[++index]));
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return values;
};

async function discover() {
  try {
    return (await fs.readdir(ROOT, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(ROOT, entry.name))
      .sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function validateEvidenceFiles(files) {
  const results = [];
  for (const file of files) {
    const value = validateRehearsalReceipt(JSON.parse(await fs.readFile(file, 'utf8')));
    if (file.startsWith(`${ROOT}${path.sep}`)) {
      const expected = `${value.executedAt.slice(0, 10)}-${value.sourceCommit.slice(0, 12)}.json`;
      if (path.basename(file) !== expected) throw new Error(`Committed receipt must be named ${expected}`);
    }
    results.push({ file: path.relative(process.cwd(), file), sourceCommit: value.sourceCommit, programId: value.program.programId });
  }
  return results;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const files = options.files.length ? options.files : await discover();
  const results = await validateEvidenceFiles(files);
  console.log(JSON.stringify({ schema: 'neal.access-stake-evidence-validation/v1', count: results.length, receipts: results }, null, 2));
}

main().catch((error) => {
  console.error(`Access-stake evidence validation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
