// Entry point for the spawned Workspace child process.
//
//   node --experimental-strip-types --no-warnings <path-to-this-file>
//
// stdin/stdout carry JSON-RPC (see ./protocol.ts); stderr is free-form logs.
// Same shape as @workspace.sh/p2p-runtime's own child-bin.ts, one level up
// the stack (Workspace operations instead of raw Log operations).

import { WorkspaceChild } from './child.ts';

const child = new WorkspaceChild((s) => {
  process.stdout.write(s);
});

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  child.feed(chunk).catch((err) => {
    process.stderr.write(`[ws-child] feed crashed: ${(err as Error).stack ?? err}\n`);
  });
});

process.stdin.on('end', () => {
  // Parent closed the pipe. Exit cleanly so we don't linger.
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  process.stderr.write(`[ws-child] uncaughtException: ${err.stack ?? err}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`[ws-child] unhandledRejection: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
