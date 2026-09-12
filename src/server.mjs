#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { JobManager } from './runner.mjs';

const failedStates = new Set(['failed', 'blocked', 'interrupted', 'timed_out']);

function result(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

async function invoke(operation) {
  try {
    const value = await operation();
    return result(value, failedStates.has(value.state ?? value.status));
  } catch (error) {
    return result({
      state: error?.state ?? 'error',
      error: {
        code: typeof error?.code === 'string' ? error.code : 'BRIDGE_ERROR',
        message: (error instanceof Error ? error.message : String(error)).slice(0, 4000),
        ...(typeof error?.retryable === 'boolean' ? { retryable: error.retryable } : {}),
      },
    }, true);
  }
}

async function main() {
  const manager = new JobManager();
  const server = new McpServer(
    { name: 'devin-bridge', version: '0.1.0' },
    {
      instructions: [
        'Devin CLI is an available worker for delegated engineering tasks.',
        'Apply the existing user instructions for roles, task complexity, and model selection.',
        'Provide an absolute working directory, a bounded task, ownership constraints, and acceptance criteria.',
        'Use devin_run once, then devin_wait with its job_id to obtain completion or devin_cancel to stop it.',
        'Running work may modify files and execute commands under the configured Devin permissions.',
        'Scope is an instruction to the worker, not filesystem isolation.',
        'Review returned work against the acceptance criteria before treating it as complete.',
      ].join(' '),
    },
  );

  server.registerTool('devin_run', {
    title: 'Run Devin worker',
    description: 'Start a delegated engineering task through the installed Devin CLI. Returns a job_id promptly; collect its result with devin_wait. The worker may edit files and execute commands. One external job runs at a time per bridge instance.',
    inputSchema: {
      task: z.string().trim().min(1).max(65536).describe('Objective, required context, constraints, and acceptance criteria.'),
      cwd: z.string().min(1).max(4096).describe('Absolute path to the existing working directory.'),
      model: z.string().trim().min(1).max(256).optional().describe('Devin model identifier or alias. Omit to use DEVIN_BRIDGE_MODEL, or swe-2-medium if unset. Model aliases may change model.'),
      scope: z.string().trim().min(1).max(32768).optional().describe('File ownership or task constraints to communicate to the worker; does not enforce isolation.'),
      timeout_seconds: z.number().int().min(1).max(3600).default(900).describe('Maximum worker duration in seconds.'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  }, (args) => invoke(() => manager.run(args)));

  server.registerTool('devin_wait', {
    title: 'Wait for Devin worker',
    description: 'Read the current or terminal result of an existing Devin job. Waits for completion for at most wait_seconds. Reuse the same job_id while it is running; a completed process still requires review of the work.',
    inputSchema: {
      job_id: z.string().min(1).max(128).describe('Job identifier returned by devin_run.'),
      wait_seconds: z.number().int().min(0).max(30).default(10).describe('Wait up to this many seconds; zero returns an immediate snapshot.'),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, ({ job_id, wait_seconds }) => invoke(() => manager.wait(job_id, wait_seconds)));

  server.registerTool('devin_cancel', {
    title: 'Cancel Devin worker',
    description: 'Stop an existing Devin job and return its cancellation or existing terminal state. Cancellation preserves changes already made in the working directory.',
    inputSchema: {
      job_id: z.string().min(1).max(128).describe('Job identifier returned by devin_run.'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, ({ job_id }) => invoke(() => manager.cancel(job_id)));

  let stopping;
  async function shutdown(exitCode = 0) {
    if (stopping) return stopping;
    stopping = (async () => {
      try {
        await manager.close();
      } catch (error) {
        process.stderr.write(`Devin bridge cleanup failed: ${error.message}\n`);
        exitCode = 1;
      }
      try {
        await server.close();
      } catch (error) {
        process.stderr.write(`Devin bridge transport close failed: ${error.message}\n`);
        exitCode = 1;
      }
      process.exitCode = exitCode;
      process.stdin.pause();
    })();
    return stopping;
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => { void shutdown(); });
  }
  process.stdin.once('end', () => { void shutdown(); });
  process.stdin.once('error', (error) => {
    process.stderr.write(`Devin bridge input failed: ${error.message}\n`);
    void shutdown(1);
  });
  process.stdout.once('error', (error) => {
    if (error.code !== 'EPIPE') process.stderr.write(`Devin bridge output failed: ${error.message}\n`);
    void shutdown(error.code === 'EPIPE' ? 0 : 1);
  });

  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    process.stderr.write(`Devin bridge startup failed: ${error.message}\n`);
    await shutdown(1);
  }
}

main().catch((error) => {
  process.stderr.write(`Devin bridge failed: ${error.message}\n`);
  process.exitCode = 1;
});
