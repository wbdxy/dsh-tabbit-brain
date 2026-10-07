#!/usr/bin/env node
// Read-only checker for the direct Brain gateway configuration.

const DEFAULT_BASE_URL = 'http://127.0.0.1:8787';
const DEFAULT_API_KEY_ENV = 'TABBIT_API_KEY';
const OLD_OPTIONS = new Set([
  '--provider', '--preset-id', '--mount-preset', '--write-settings',
  '--force', '--api-key', '--profile',
]);
const OPTIONS = new Map([
  ['--help', { value: false }],
  ['--base-url', { value: DEFAULT_BASE_URL, takesValue: true }],
  ['--api-key-env', { value: DEFAULT_API_KEY_ENV, takesValue: true }],
  ['--models', { value: '', takesValue: true }],
  ['--dry-run', { value: false }],
  ['--yes', { value: false }],
  ['--check-gateway', { value: false }],
]);

function fail(message) {
  console.error(`Setup failed: ${message}`);
  process.exitCode = 2;
}

function parseArgs(argv) {
  const args = Object.fromEntries([...OPTIONS].map(([name, spec]) => [name.slice(2).replaceAll('-', '_'), spec.value]));
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (OLD_OPTIONS.has(flag)) {
      throw new Error(`${flag} has been removed; use the direct Brain gateway options`);
    }
    const spec = OPTIONS.get(flag);
    if (!spec) {
      if (flag.startsWith('--')) throw new Error(`unknown option: ${flag}`);
      throw new Error(`unexpected argument: ${flag}`);
    }
    const key = flag.slice(2).replaceAll('-', '_');
    if (spec.takesValue) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
      args[key] = value;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function printHelp() {
  console.log(`dsh-tabbit-brain setup — read-only direct Brain gateway checker

Usage:
  node scripts/setup.mjs [options]

Options:
  --help                  Show this help.
  --base-url <url>        Brain gateway base URL (default: ${DEFAULT_BASE_URL}).
  --api-key-env <name>    Environment variable containing the gateway key (default: ${DEFAULT_API_KEY_ENV}).
  --models <a,b,c>        Optional expected model ids; checked only with --check-gateway.
  --check-gateway         Explicitly request GET /v1/models. Never starts a gateway.
  --dry-run               Print the check plan without network access.
  --yes                   Non-interactive mode; accepted for automation.

This command never writes settings, presets, provider registrations, or credentials.
The key value is read from the named environment variable only for an explicit gateway check and is never printed.
`);
}

function validateBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('base URL must be credential-free loopback HTTP or HTTPS'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.search || url.hash) {
    throw new Error('base URL must be credential-free loopback HTTP or HTTPS');
  }
  return url.href.replace(/\/+$/, '').replace(/\/v1$/, '');
}

function modelsPath(baseUrl) {
  return `${baseUrl}/v1/models`;
}

async function checkGateway(args) {
  const key = process.env[args.api_key_env];
  if (!key) throw new Error(`environment variable ${args.api_key_env} is not set`);
  const response = await fetch(modelsPath(args.base_url), {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`gateway /v1/models returned HTTP ${response.status}`);
  const payload = await response.json();
  const ids = Array.isArray(payload?.data) ? payload.data.map((item) => item?.id).filter(Boolean) : [];
  if (args.models) {
    const expected = args.models.split(',').map((id) => id.trim()).filter(Boolean);
    const missing = expected.filter((id) => !ids.includes(id));
    if (missing.length) throw new Error(`requested models missing: ${missing.join(', ')}`);
    console.log(`Gateway reachable; ${expected.length} requested model(s) matched.`);
  } else {
    console.log(`Gateway reachable; ${ids.length} model(s) reported.`);
  }
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
  if (!args.help) args.base_url = validateBaseUrl(args.base_url);
} catch (error) {
  fail(error.message);
}
if (process.exitCode) process.exit();
if (args.help) {
  printHelp();
} else if (args.dry_run) {
  console.log(`Read-only plan: inspect ${args.base_url}; gateway check is ${args.check_gateway ? 'enabled' : 'disabled'}.`);
  console.log('No files will be written and no gateway will be started.');
} else if (!args.check_gateway) {
  console.log(`Direct Brain gateway check plan for ${args.base_url} (not checked).`);
  console.log(`Credential source: environment variable ${args.api_key_env} (value hidden).`);
  if (args.models) console.log('Model list not checked; add --check-gateway to verify it.');
  console.log('No network request, gateway startup, settings write, or preset write was performed.');
} else {
  try {
    await checkGateway(args);
  } catch (error) {
    console.error(`Gateway check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
