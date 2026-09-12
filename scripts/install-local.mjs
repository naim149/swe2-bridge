#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  exec, inspectEnvironment, marketplaceName, parseArguments, pluginName, printEnvironment, repositoryRoot,
} from './environment.mjs';

const marketplaceRoot = path.join(repositoryRoot, '.local', 'marketplace');
const pluginRoot = path.join(marketplaceRoot, 'plugins', pluginName);
const requiredEntries = ['src', 'skills', '.codex-plugin', '.mcp.json', 'package.json', 'package-lock.json', 'node_modules'];
const optionalEntries = ['README.md', 'LICENSE', 'CONTRIBUTING.md', 'SECURITY.md', 'PLAN.md', 'VERIFICATION.md', 'docs'];
const configurationKeys = [
  'DEVIN_CLI_PATH', 'DEVIN_BRIDGE_MODEL', 'DEVIN_BRIDGE_STATE_DIR',
  'DEVIN_BRIDGE_PERMISSION_MODE', 'DEVIN_BRIDGE_RESPECT_WORKSPACE_TRUST',
];

async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
async function writeJson(file, data) { await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`); }

async function ensureDirectory(directory) {
  await fs.mkdir(directory, { recursive: true });
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error(`Refusing a symlinked staging directory: ${directory}`);
}

async function hashTree(directory) {
  const hash = createHash('sha256');
  async function visit(relative) {
    const absolute = path.join(directory, relative);
    const stat = await fs.lstat(absolute);
    hash.update(`${relative}\0${stat.mode & 0o777}\0`);
    if (stat.isSymbolicLink()) hash.update(`link:${await fs.readlink(absolute)}\0`);
    else if (stat.isDirectory()) {
      for (const child of (await fs.readdir(absolute)).sort()) await visit(path.join(relative, child));
    } else if (stat.isFile()) hash.update(await fs.readFile(absolute));
    else throw new Error(`Unsupported file in staged plugin: ${relative}`);
  }
  await visit('');
  return hash.digest('hex').slice(0, 20);
}

async function stagePlugin(environment) {
  const catalog = await readJson(path.join(repositoryRoot, 'config', 'marketplace.json'));
  if (catalog.name !== marketplaceName || catalog.plugins?.length !== 1
    || catalog.plugins[0].name !== pluginName
    || catalog.plugins[0].source?.source !== 'local'
    || catalog.plugins[0].source?.path !== `./plugins/${pluginName}`) {
    throw new Error('config/marketplace.json does not match the expected repository-local marketplace.');
  }
  const manifest = await readJson(path.join(repositoryRoot, '.codex-plugin', 'plugin.json'));
  if (manifest.name !== pluginName || !manifest.version) throw new Error('Invalid source plugin name or version.');
  manifest.version = manifest.version.split('+')[0];

  for (const directory of [path.join(repositoryRoot, '.local'), marketplaceRoot, path.join(marketplaceRoot, 'plugins')]) {
    await ensureDirectory(directory);
  }
  const temporary = path.join(marketplaceRoot, 'plugins', `.${pluginName}.install-${randomUUID()}`);
  const previous = `${pluginRoot}.previous-${randomUUID()}`;
  let movedPrevious = false;
  await fs.mkdir(temporary);
  try {
    for (const entry of requiredEntries) {
      const source = path.join(repositoryRoot, entry);
      if ((await fs.lstat(source)).isSymbolicLink()) throw new Error(`Expected a regular source entry: ${entry}`);
      await fs.cp(source, path.join(temporary, entry), { recursive: true, dereference: false, verbatimSymlinks: true });
    }
    for (const entry of optionalEntries) {
      try { await fs.access(path.join(repositoryRoot, entry)); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      await fs.cp(path.join(repositoryRoot, entry), path.join(temporary, entry), { recursive: true, dereference: false, verbatimSymlinks: true });
    }
    await fs.mkdir(path.join(temporary, 'scripts'));
    await fs.copyFile(path.join(repositoryRoot, 'scripts', 'launch-devin-bridge'), path.join(temporary, 'scripts', 'launch-devin-bridge'));
    await fs.chmod(path.join(temporary, 'scripts', 'launch-devin-bridge'), 0o755);

    const mcp = await readJson(path.join(repositoryRoot, '.mcp.json'));
    const server = mcp.mcpServers?.devin;
    if (!server) throw new Error('The source MCP configuration is missing the devin server.');
    // Pin the verified Node binary for GUI environments with a shorter PATH.
    // Codex resolves cwd and the ./ argument relative to its installed plugin.
    server.command = environment.paths.node;
    server.args = ['./src/server.mjs'];
    server.cwd = '.';
    server.env = { ...server.env, DEVIN_CLI_PATH: environment.paths.devin };
    for (const key of configurationKeys) {
      if (process.env[key] !== undefined) server.env[key] = process.env[key];
    }
    // Resolve the executable even if its explicit override used a relative path.
    server.env.DEVIN_CLI_PATH = environment.paths.devin;
    if (!['true', 'false'].includes(server.env.DEVIN_BRIDGE_RESPECT_WORKSPACE_TRUST)) {
      throw new Error('DEVIN_BRIDGE_RESPECT_WORKSPACE_TRUST must be true or false.');
    }
    await writeJson(path.join(temporary, '.mcp.json'), mcp);
    await writeJson(path.join(temporary, '.codex-plugin', 'plugin.json'), manifest);
    manifest.version = `${manifest.version}+codex.${await hashTree(temporary)}`;
    await writeJson(path.join(temporary, '.codex-plugin', 'plugin.json'), manifest);

    try {
      if ((await fs.lstat(pluginRoot)).isSymbolicLink()) throw new Error('Refusing to replace a symlinked plugin staging directory.');
      await fs.rename(pluginRoot, previous);
      movedPrevious = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await fs.rename(temporary, pluginRoot); }
    catch (error) {
      if (movedPrevious) await fs.rename(previous, pluginRoot);
      throw error;
    }
    if (movedPrevious) await fs.rm(previous, { recursive: true });
    for (const directory of [path.join(marketplaceRoot, '.agents'), path.join(marketplaceRoot, '.agents', 'plugins')]) await ensureDirectory(directory);
    await writeJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), catalog);
    return manifest.version;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function runCodex(executable, args) {
  try {
    const result = await exec(executable, args, { cwd: repositoryRoot, timeout: 120000, maxBuffer: 1024 * 1024 });
    if (result.stdout.trim()) console.log(result.stdout.trim());
    if (result.stderr.trim()) console.error(result.stderr.trim());
  } catch (error) {
    if (/already added from a different source/.test(error.stderr || '')) {
      throw new Error(`${marketplaceName} is registered from another checkout. Remove the previous plugin and marketplace before installing from a moved or different clone; see docs/LOCAL_SETUP.md for the migration commands.`);
    }
    throw error;
  }
}

try {
  const options = parseArguments(process.argv.slice(2), { installer: true });
  if (options.help) {
    console.log('Usage: npm run install:local -- [--dry-run] [--experimental-linux]\nStage an allowlisted runtime under .local/marketplace, then install it with the Codex CLI. Rerun to update.\nOptional environment: CODEX_CLI_PATH, DEVIN_CLI_PATH, DEVIN_BRIDGE_MODEL, DEVIN_BRIDGE_STATE_DIR, DEVIN_BRIDGE_PERMISSION_MODE, DEVIN_BRIDGE_RESPECT_WORKSPACE_TRUST.');
  } else {
    const environment = await inspectEnvironment(options);
    printEnvironment(environment);
    if (!environment.ok) throw new Error('Resolve the failed prerequisite checks before installing.');
    if (options.dryRun) {
      console.log(`Would stage the allowlisted runtime at ${pluginRoot}`);
      console.log(JSON.stringify({ executable: environment.paths.codex, args: ['plugin', 'marketplace', 'add', marketplaceRoot, '--json'] }));
      console.log(JSON.stringify({ executable: environment.paths.codex, args: ['plugin', 'add', `${pluginName}@${marketplaceName}`, '--json'] }));
    } else {
      const version = await stagePlugin(environment);
      console.log(`Staged ${pluginName} ${version} at ${pluginRoot}`);
      await runCodex(environment.paths.codex, ['plugin', 'marketplace', 'add', marketplaceRoot, '--json']);
      await runCodex(environment.paths.codex, ['plugin', 'add', `${pluginName}@${marketplaceName}`, '--json']);
      console.log(`Installed ${pluginName}@${marketplaceName}. Start a fresh Codex task to load its skill and tools.`);
      console.log('The MCP server runs locally when Codex starts it; no listening port or hosted service is required.');
    }
  }
} catch (error) {
  console.error(`Installation failed: ${error.message}`);
  process.exitCode = 1;
}
