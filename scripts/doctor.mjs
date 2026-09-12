#!/usr/bin/env node
import { inspectEnvironment, parseArguments, printEnvironment } from './environment.mjs';

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: npm run doctor -- [--json] [--experimental-linux]\nCheck Node 22+, dependencies, Git, Codex plugin support, Devin CLI and authentication without a model task.');
  } else {
    const result = await inspectEnvironment(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else printEnvironment(result);
    if (!result.ok) process.exitCode = 1;
  }
} catch (error) {
  console.error(`Doctor failed: ${error.message}`);
  process.exitCode = 1;
}
