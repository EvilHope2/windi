import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const jsDir = fileURLToPath(new URL('../../frontend/js/', import.meta.url));

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) files.push(...walk(full));
    else if (extname(full) === '.js') files.push(full);
  }
  return files;
}

const files = walk(jsDir);
const failed = [];

for (const file of files) {
  try {
    readFileSync(file, 'utf8');
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    if (result.status !== 0) {
      failed.push({
        file,
        error: result.stderr?.toString?.().trim() || 'syntax error'
      });
    }
  } catch (err) {
    failed.push({ file, error: err.message });
  }
}

if (failed.length) {
  for (const item of failed) {
    console.error(`[syntax] ${item.file}: ${item.error}`);
  }
  process.exit(1);
}

console.log(`[syntax] OK (${files.length} frontend modules)`);
