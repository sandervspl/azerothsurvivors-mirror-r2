import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, lstat, mkdir, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [sourceArg, version, outputArg] = process.argv.slice(2);
if (!sourceArg || !version || !outputArg || !/^\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9]+)*$/.test(version)) throw new Error('Usage: npm run prepare -- <game-folder> <version> <output.zip>');
const source = await realpath(resolve(sourceArg));
const output = resolve(outputArg);
const withinSource = relative(source, output);
if (!withinSource.startsWith(`..${sep}`) && withinSource !== '..' && !isAbsolute(withinSource)) throw new Error('Save the archive outside the game folder.');
if (!output.toLowerCase().endsWith('.zip')) throw new Error('Choose a .zip output filename.');
const sidecars = [output, output + '.sha256', output + '.md5', output + '.release.json'];
for (const path of sidecars) {
  try { await access(path); throw new Error(`Output already exists: ${path}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const sevenZip = process.env.SEVEN_ZIP || (process.platform === 'win32' ? join(process.env.ProgramFiles || 'C:/Program Files', '7-Zip/7z.exe') : '7z');
function run(args, onData) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(sevenZip, args, { cwd: dirname(source), windowsHide: true });
    let outputText = '', errorText = '';
    child.stdout.on('data', data => { if (onData) onData(data); else outputText += data.toString(); });
    child.stderr.on('data', data => { errorText += data.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveRun(outputText) : reject(new Error(`7-Zip failed (${code}): ${errorText || outputText}`)));
  });
}
async function hashFile(path) {
  const sha256 = createHash('sha256'), md5 = createHash('md5');
  for await (const chunk of createReadStream(path)) { sha256.update(chunk); md5.update(chunk); }
  return { sha256: sha256.digest('hex'), md5: md5.digest('hex') };
}
const files = [];
async function collect(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error('Release inputs must not contain symbolic links.');
  if (info.isDirectory()) {
    for (const name of (await readdir(path)).sort()) await collect(join(path, name));
  } else if (info.isFile()) {
    files.push({ source: path, path: relative(dirname(source), path).split(sep).join('/'), bytes: info.size, mtimeMs: info.mtimeMs });
  } else throw new Error('Release inputs must be regular files or directories.');
}
await collect(join(source, 'AzerothSurvivors.exe'));
if (!(await lstat(join(source, 'Data'))).isDirectory()) throw new Error('The game Data directory is missing.');
await collect(join(source, 'Data'));
if (!files.some(file => file.path.endsWith('.MPQ'))) throw new Error('No game MPQ data files were found.');
console.log(`Preparing ${version}: ${files.length} game files. Local benilla-config data is excluded.`);
for (const file of files) file.hashes = await hashFile(file.source);
await mkdir(dirname(output), { recursive: true });
const pending = `${output}.preparing-${process.pid}`;
const top = basename(source);
console.log('Compressing ZIP archive…');
await run(['a', '-tzip', '-mx=7', '-mmt=4', '-bb0', '-bsp0', pending, `${top}/AzerothSurvivors.exe`, `${top}/Data`]);
console.log('Checking archive integrity…');
await run(['t', '-bb0', '-bsp0', pending]);
const listing = await run(['l', '-slt', pending]);
const entries = listing.split(/\r?\n\r?\n/).map(block => Object.fromEntries(block.split(/\r?\n/).filter(line => line.includes(' = ')).map(line => { const at = line.indexOf(' = '); return [line.slice(0, at), line.slice(at + 3)]; }))).filter(entry => entry.Path && entry.Folder === '-');
const actual = entries.map(entry => entry.Path.replace(/\\/g, '/')).sort();
const expected = files.map(file => file.path).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Archive contents do not match the selected game files.');
console.log('Comparing every archived file with the source checksums…');
for (const file of files) {
  const sha256 = createHash('sha256'), md5 = createHash('md5'); let bytes = 0;
  await run(['x', '-so', '-bb0', '-bsp0', pending, file.path], chunk => { bytes += chunk.length; sha256.update(chunk); md5.update(chunk); });
  if (bytes !== file.bytes || sha256.digest('hex') !== file.hashes.sha256 || md5.digest('hex') !== file.hashes.md5) throw new Error(`Archive verification failed for ${file.path}`);
  const current = await stat(file.source);
  if (current.size !== file.bytes || current.mtimeMs !== file.mtimeMs) throw new Error('A source file changed during packaging. Prepare a fresh archive.');
}
const archiveHashes = await hashFile(pending);
const info = await stat(pending);
// A failed verification leaves only the uniquely named .preparing file for inspection.
await access(output).then(() => { throw new Error('Output appeared while preparing the archive.'); }, error => { if (error.code !== 'ENOENT') throw error; });
await rename(pending, output);
const manifest = {
  version, filename: basename(output), bytes: info.size, ...archiveHashes,
  preparedAt: new Date().toISOString(), readyForUpload: true, uploaded: false,
  included: ['AzerothSurvivors.exe', 'Data/'], excluded: ['benilla-config/ (local configuration, character state, and installed addons)'],
  uncompressedBytes: files.reduce((sum, file) => sum + file.bytes, 0),
  verification: { archiveIntegrity: '7-Zip test passed', archiveEntries: files.length, contentComparison: 'Every archived file matched its source SHA-256, MD5, size, and unchanged source metadata' },
  files: files.map(({ path, bytes, hashes }) => ({ path, bytes, ...hashes })),
};
await writeFile(output + '.sha256', `${manifest.sha256}  ${manifest.filename}\n`, { flag: 'wx' });
await writeFile(output + '.md5', `${manifest.md5}  ${manifest.filename}\n`, { flag: 'wx' });
await writeFile(output + '.release.json', JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
const evidence = new URL(`../artifacts/prepared-release-${version}.json`, import.meta.url);
await mkdir(dirname(fileURLToPath(evidence)), { recursive: true });
await writeFile(evidence, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Ready: ${output}\nVersion: ${version}\nSize: ${(info.size / 1048576).toFixed(1)} MiB\nSHA-256: ${manifest.sha256}\nMD5: ${manifest.md5}`);
