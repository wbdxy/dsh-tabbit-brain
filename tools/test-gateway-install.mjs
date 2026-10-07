import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const patch = path.join(root, 'gateway-patch');
const expected = ['scripts/lib/detect.mjs', 'scripts/lib/cdp.mjs', 'src/config.mjs', 'src/server.mjs', 'src/brain-session-map.mjs', 'src/remote-session-client.mjs'];
const secret = 'fixture-secret-never-stdout';
function fixture(fn) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'gateway-install-'));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function put(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function snapshot(dir) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).sort().map(name => {
    const file = path.join(dir, name);
    return [name, fs.statSync(file).isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('base64')];
  });
}
// Execute the unchanged CLI body with a process-launch trap. Only filesystem roots are fixtures.
function run(target, flags = [], source = patch) {
  const calls = [], output = [];
  let code = fs.readFileSync(path.join(source, 'install.mjs'), 'utf8');
  code = code.replace(/^#!.*\n/, '').replace(/^import .*;$/mg, '').replace(/const HERE = .*;/, 'const HERE = SOURCE;');
  let status = 0;
  const exit = Symbol('exit');
  const sandbox = {
    ...fs, ...path, fileURLToPath, SOURCE: source, homedir: () => path.join(path.dirname(target), 'isolated-home'),
    execFileSync: (...args) => { calls.push(args); throw new Error('unexpected subprocess'); },
    process: { argv: ['node', 'install.mjs', '--dir', target, '--api-key', secret, ...flags], exit: value => { status = value; throw exit; } },
    console: { log: (...a) => output.push(a.join(' ')), error: (...a) => output.push(a.join(' ')) },
  };
  try { vm.runInNewContext(code, sandbox); } catch (error) { if (error !== exit) throw error; }
  assert.deepEqual(calls, [], 'installer launched a subprocess');
  assert.ok(!output.join('\n').includes(secret), 'API key leaked');
  return { status, output: output.join('\n') };
}

test('installer manifest contains all six modules', () => {
  const code = fs.readFileSync(path.join(patch, 'install.mjs'), 'utf8');
  const manifest = code.match(/const MANIFEST = \[([\s\S]*?)\];/)[1];
  const actual = [...manifest.matchAll(/\['([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(actual, expected);
});

test('six required overlay modules exist and dry-run lists each', () => fixture(dir => {
  const target = path.join(dir, '中文 空格');
  const result = run(target, ['--skip-clone', '--dry-run']);
  assert.equal(result.status, 0);
  for (const rel of expected) {
    assert.ok(fs.existsSync(path.join(patch, 'files', rel)), `missing manifest source: ${rel}`);
    assert.ok(result.output.includes(rel), `missing manifest entry: ${rel}`);
  }
  assert.equal(snapshot(target), null);
}));

test('missing source preflight fails before any target writes, even before clone', () => fixture(dir => {
  const source = path.join(dir, 'package');
  fs.cpSync(patch, source, { recursive: true });
  for (const rel of expected) {
    const file = path.join(source, 'files', rel);
    const bytes = fs.existsSync(file) ? fs.readFileSync(file) : Buffer.from('// fixture source\n');
    put(file, bytes);
    fs.unlinkSync(file);
    for (const flags of [[], ['--skip-clone'], ['--dry-run'], ['--skip-clone', '--dry-run']]) {
      const target = path.join(dir, 'missing-target');
      const result = run(target, flags, source);
      assert.notEqual(result.status, 0, `preflight accepted ${rel}`);
      assert.equal(snapshot(target), null);
      assert.ok(result.output.includes(rel));
      put(path.join(target, '.env'), 'API_KEY=existing-fixture\n');
      put(path.join(target, 'state', 'ledger.json'), 'unchanged');
      const before = snapshot(target);
      assert.notEqual(run(target, flags, source).status, 0);
      assert.deepEqual(snapshot(target), before);
      fs.rmSync(target, { recursive: true });
    }
    put(file, bytes);
  }
}));

test('install/reinstall preserves env, ledger, unrelated files and first original backup', () => fixture(dir => {
  const target = path.join(dir, '中文 gateway 空格');
  for (const rel of expected) put(path.join(target, rel), `original:${rel}\n`);
  put(path.join(target, 'state', 'brain-session-map.json'), '{"fixture":true}\n');
  put(path.join(target, 'state', 'brain-session-map.json.tmp'), 'temporary');
  put(path.join(target, 'state', 'brain-session-map.json.corrupt-1'), 'corrupt');
  put(path.join(target, 'other.txt'), 'unrelated');
  put(path.join(target, '.env'), ['API_KEY=existing-fixture', 'TABBIT_COOKIE=fixture-cookie', 'TABBIT_ACCOUNT_KEY=my-account', 'TABBIT_BRAIN_SESSION_MAP_PATH=custom ledger.json', 'PORT=1234', 'TABBIT_BASE_URL=https://fixture.invalid', ''].join('\r\n'));
  const before = snapshot(target);
  assert.equal(run(target, ['--skip-clone', '--dry-run']).status, 0);
  assert.deepEqual(snapshot(target), before);
  assert.equal(run(target, ['--skip-clone']).status, 0);
  const installed = snapshot(target);
  for (const rel of expected) {
    assert.deepEqual(fs.readFileSync(path.join(target, rel)), fs.readFileSync(path.join(patch, 'files', rel)));
    assert.equal(fs.readFileSync(path.join(target, rel + '.upstream-bak'), 'utf8'), `original:${rel}\n`);
  }
  const env = fs.readFileSync(path.join(target, '.env'), 'utf8');
  assert.ok(env.startsWith('API_KEY=existing-fixture\r\nTABBIT_COOKIE=fixture-cookie\r\n'));
  assert.equal(run(target, ['--skip-clone']).status, 0);
  assert.deepEqual(snapshot(target), installed);
}));

test('dry-run no writes for absent target or existing git; non-git target requires skip', () => fixture(dir => {
  const target = path.join(dir, 'target');
  assert.equal(run(target, ['--dry-run']).status, 0);
  assert.equal(snapshot(target), null);
  put(path.join(target, 'unrelated'), 'unchanged');
  const before = snapshot(target);
  assert.equal(run(target).status, 1);
  assert.deepEqual(snapshot(target), before);
  fs.mkdirSync(path.join(target, '.git'));
  const gitBefore = snapshot(target);
  assert.equal(run(target, ['--dry-run']).status, 0);
  assert.deepEqual(snapshot(target), gitBefore);
}));

test('real CLI skip-clone install and dry-run use file redirected stdio and isolated home', () => fixture(dir => {
  const target = path.join(dir, 'CLI 中文 空格');
  const out = path.join(dir, 'stdout');
  const err = path.join(dir, 'stderr');
  for (const flags of [['--dry-run'], []]) {
    const stdout = fs.openSync(out, 'w'), stderr = fs.openSync(err, 'w');
    let result;
    try {
      result = spawnSync(process.execPath, [path.join(patch, 'install.mjs'), '--dir', target, '--skip-clone', '--api-key', secret, '--port', '12345', '--base-url', 'https://fixture.invalid', ...flags], {
        cwd: dir, env: { ...process.env, HOME: dir, USERPROFILE: dir, DSH_HOME: dir, PATH: '' }, stdio: ['ignore', stdout, stderr], timeout: 10000,
      });
    } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
    assert.ifError(result.error);
    assert.equal(result.status, 0);
    assert.ok(!(fs.readFileSync(out, 'utf8') + fs.readFileSync(err, 'utf8')).includes(secret));
    if (flags.length) assert.equal(snapshot(target), null);
  }
  assert.match(fs.readFileSync(path.join(target, '.env'), 'utf8'), /PORT=12345/);
  assert.ok(fs.readFileSync(path.join(target, '.env'), 'utf8').includes(`API_KEY=${secret}`));
}));
