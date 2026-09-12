import { execFile } from 'node:child_process';
import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify, stripVTControlCharacters } from 'node:util';
import { resolveDevinPath } from '../src/runner.mjs';

export const exec = promisify(execFile);
export const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const marketplaceName = 'swe2-bridge-local';
export const pluginName = 'swe2-bridge';

async function executable(name, override, fallbacks = []) {
  const candidates = override ? [override] : [
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((entry) => path.join(entry, name)),
    ...fallbacks,
  ];
  for (const candidate of candidates) {
    try {
      const resolved = await fs.realpath(candidate);
      if (!(await fs.stat(resolved)).isFile()) continue;
      await fs.access(resolved, constants.X_OK);
      return resolved;
    } catch { /* Try the next normal installation path. */ }
  }
  throw new Error(override ? `The configured ${name} executable is unavailable.` : `${name} was not found.`);
}

function firstLine(value) {
  return stripVTControlCharacters(value).split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 200) || 'No version reported';
}

export function parseArguments(argv, { installer = false } = {}) {
  const supported = new Set(['--help', '--experimental-linux', ...(installer ? ['--dry-run'] : ['--json'])]);
  for (const argument of argv) {
    if (!supported.has(argument)) throw new Error(`Unknown option: ${argument}. Use --help.`);
  }
  return {
    help: argv.includes('--help'),
    experimentalLinux: argv.includes('--experimental-linux'),
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
  };
}

export async function inspectEnvironment({ experimentalLinux = false } = {}) {
  const checks = [];
  const paths = { node: process.execPath };
  const report = (id, ok, message) => checks.push({ id, ok, message });
  const platformOK = process.platform === 'darwin' || (process.platform === 'linux' && experimentalLinux);
  report('platform', platformOK, process.platform === 'darwin' ? 'macOS is the supported platform.'
    : process.platform === 'linux' ? (experimentalLinux ? 'Linux explicitly enabled; experimental and unverified.' : 'Linux requires --experimental-linux; it is not a verified platform.')
      : 'Windows is unsupported; the runner requires POSIX process groups.');
  report('node', Number(process.versions.node.split('.')[0]) >= 22, `Node ${process.versions.node} at ${process.execPath}; Node 22 or later is required.`);

  try {
    const manifest = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'package.json'), 'utf8'));
    for (const [name, version] of Object.entries(manifest.dependencies)) {
      const installed = JSON.parse(await fs.readFile(path.join(repositoryRoot, 'node_modules', name, 'package.json'), 'utf8'));
      if (installed.version !== version) throw new Error('Dependency versions differ from package.json.');
    }
    report('dependencies', true, 'Pinned runtime dependencies are installed.');
  } catch {
    report('dependencies', false, 'Run npm ci --ignore-scripts in this checkout to install the pinned dependencies.');
  }

  try {
    paths.git = await executable('git');
    const result = await exec(paths.git, ['--version'], { timeout: 15000, maxBuffer: 64 * 1024 });
    report('git', true, `${firstLine(result.stdout)} at ${paths.git}`);
  } catch {
    report('git', false, 'Git is missing or could not run. Install the Git command-line tools.');
  }

  try {
    paths.codex = await executable('codex', process.env.CODEX_CLI_PATH, [
      '/Applications/Codex.app/Contents/Resources/codex',
      '/Applications/ChatGPT.app/Contents/Resources/codex',
    ]);
    const version = await exec(paths.codex, ['--version'], { timeout: 15000, maxBuffer: 64 * 1024 });
    await exec(paths.codex, ['plugin', 'marketplace', 'add', '--help'], { timeout: 15000, maxBuffer: 64 * 1024 });
    await exec(paths.codex, ['plugin', 'add', '--help'], { timeout: 15000, maxBuffer: 64 * 1024 });
    report('codex', true, `${firstLine(version.stdout)} at ${paths.codex}; plugin installation commands are available.`);
  } catch {
    report('codex', false, 'Codex with local plugin support could not run. Install/update Codex or set CODEX_CLI_PATH to its executable.');
  }

  try {
    paths.devin = await resolveDevinPath();
    const version = await exec(paths.devin, ['--version'], { timeout: 15000, maxBuffer: 64 * 1024 });
    report('devin', true, `${firstLine(version.stdout)} at ${paths.devin}`);
    try {
      const status = await exec(paths.devin, ['auth', 'status'], {
        timeout: 20000,
        maxBuffer: 512 * 1024,
        env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' },
      });
      const text = stripVTControlCharacters(`${status.stdout}\n${status.stderr}`);
      const authenticated = !/not\s+(?:logged\s+in|authenticated)|unauthenticated|authentication\s+required/i.test(text)
        && /(?:^|\n)\s*(?:logged\s+in|authenticated)\b/i.test(text);
      report('devin_auth', authenticated, authenticated ? 'Devin reports authenticated. Account details are not printed.'
        : 'Devin authentication was not confirmed. Run the resolved Devin executable with auth login, then rerun doctor.');
    } catch {
      // auth status may include identity and credential metadata. Never relay its raw output.
      report('devin_auth', false, 'Devin auth status failed. Run the resolved Devin executable with auth status locally; authenticate with auth login if needed.');
    }
  } catch {
    report('devin', false, 'Devin CLI is unavailable. Install Devin or set DEVIN_CLI_PATH to an executable.');
    report('devin_auth', false, 'Authentication could not be checked without a working Devin CLI.');
  }

  return { ok: checks.every((check) => check.ok), checks, paths };
}

export function printEnvironment(result) {
  for (const check of result.checks) console.log(`${check.ok ? 'OK' : 'FAIL'} ${check.id}: ${check.message}`);
  console.log('This checks local prerequisites. It does not start a model task or confirm access to a specific model.');
}
