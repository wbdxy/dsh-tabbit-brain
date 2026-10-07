// Offline CLI fixtures; runtime ledger files are never created.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'gateway-patch/files/src/config.mjs'), 'utf8');
const declaration = source.split('\n').find(line => /^\s*brainSessionStatePath:/.test(line));
assert.ok(declaration, 'real config has the default path declaration');
const fixture = mkdtempSync(join(tmpdir(), 'audit-docs-runtime-'));
let passed = 0;
try {
  for (const dir of ['tools', 'lib', 'gateway-patch/files/src']) mkdirSync(join(fixture, dir), { recursive: true });
  copyFileSync(join(root, 'tools/audit-docs.mjs'), join(fixture, 'tools/audit-docs.mjs'));
  writeFileSync(join(fixture, 'lib/index.js'), '');
  writeFileSync(join(fixture, 'package.json'), '{}');
  function check(label, path, config, ghost) {
    writeFileSync(join(fixture, 'README.md'), `Runtime: \`${path}\`\n`);
    const configPath = join(fixture, 'gateway-patch/files/src/config.mjs');
    if (config === null) rmSync(configPath, { force: true });
    else writeFileSync(configPath, config);
    const result = spawnSync(process.execPath, [join(fixture, 'tools/audit-docs.mjs')], {
      encoding: 'utf8', env: { ...process.env, PATH: '' },
    });
    assert.ifError(result.error);
    const output = result.stdout + result.stderr;
    assert.equal(result.status, ghost ? 1 : 0, `${label}\n${output}`);
    assert.equal(output.includes(`\`${path}\` 在仓库里不存在`), ghost, `${label}: ghost diagnostic\n${output}`);
    assert.equal(existsSync(join(fixture, 'state')), false, 'fixture never creates a runtime state directory');
    console.log(`PASS ${label}`);
    passed++;
  }
  check('known runtime path with real source declaration', 'state/brain-session-map.json', source, false);
  check('unknown state path remains a ghost', 'state/foo.json', source, true);
  check('known path without source file remains a ghost', 'state/brain-session-map.json', null, true);
  check('known path without declaration remains a ghost', 'state/brain-session-map.json', 'export const config = {};', true);
  check('mismatched default filename remains a ghost', 'state/brain-session-map.json', declaration.replace('brain-session-map.json', 'foo.json'), true);
  check('mismatched default directory remains a ghost', 'state/brain-session-map.json', declaration.replace("'state'", "'other-state'"), true);
  check('environment-only path remains a ghost', 'state/brain-session-map.json', 'brainSessionStatePath: ENV.TABBIT_BRAIN_SESSION_MAP_PATH,', true);
  check('commented declaration remains a ghost', 'state/brain-session-map.json', `// ${declaration}`, true);
  check('unrelated property remains a ghost', 'state/brain-session-map.json', declaration.replace('brainSessionStatePath:', 'otherStatePath:'), true);
  check('template declaration bait remains a ghost', 'state/brain-session-map.json',
    'const example = `\n' + declaration + '\n`;\nexport const config = { brainSessionStatePath: ENV.TABBIT_BRAIN_SESSION_MAP_PATH || process.env.TABBIT_BRAIN_SESSION_MAP_PATH };', true);
  const wrap = value => `export const config = {\n${value}\n};`;
  const envOnly = 'brainSessionStatePath: ENV.TABBIT_BRAIN_SESSION_MAP_PATH || process.env.TABBIT_BRAIN_SESSION_MAP_PATH,';
  const path = 'state/brain-session-map.json';
  check('single-quoted declaration bait remains a ghost', path,
    "const example = '" + declaration.replace(/'/g, "\\'") + "';\n" + wrap(envOnly), true);
  check('double-quoted export bait remains a ghost', path, 'const example = ' + JSON.stringify(wrap(declaration)) + ';\n' + wrap(envOnly), true);
  check('template export bait remains a ghost', path, 'const example = `\n' + wrap(declaration) + '\n`;\n' + wrap(envOnly), true);
  check('nested template interpolation bait remains a ghost', path,
    'const example = `${`\n' + wrap(declaration) + '\n`}`;\n' + wrap(envOnly), true);
  check('block-comment declaration bait remains a ghost', path, '/*\n' + wrap(declaration) + '\n*/\n' + wrap(envOnly), true);
  check('line-comment export bait remains a ghost', path, '// ' + wrap(declaration).replace(/\n/g, ' ') + '\n' + wrap(envOnly), true);
  check('unexported object remains a ghost', path, 'const config = {\n' + declaration + '\n};', true);
  check('nested object property remains a ghost', path, wrap('example: {\n' + declaration + '\n},\n' + envOnly), true);
  check('standalone declaration remains a ghost', path, declaration, true);
  check('spread override remains a ghost', path, wrap(declaration + '\n...other,'), true);
  check('duplicate env-only override remains a ghost', path, wrap(declaration + '\n' + envOnly), true);
  check('computed override remains a ghost', path, wrap(declaration + '\n[key]: value,'), true);
  check('quoted property and double-quoted path tokens declare default', path,
    wrap(declaration.replace('brainSessionStatePath:', '"brainSessionStatePath":').replace(/'/g, '"')), false);
  check('comments between real tokens declare default', path,
    wrap(declaration.replace('join(', 'join(/* default */').replace(' || ', ' /* override */ || ')), false);
  check('fake strings before real declaration do not hide default', path,
    'const example = "https://example.invalid/* text */";\n' + wrap(declaration), false);
  console.log(`${passed} passed; 0 failed (offline runtime-path fixtures)`);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
