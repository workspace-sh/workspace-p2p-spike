// Entry point for the spawned child process.
//
// A parent (Node parent for tests / apps/node, or eventually a macOS
// TurboModule parent) launches:
//
//   node --experimental-strip-types --no-warnings <path-to-this-file>
//
// stdin/stdout carry JSON-RPC; stderr is left for free-form logs.
//
// stderr is `inherit`-friendly so debugging output from the child shows up
// in the parent's terminal during development.

import { Child } from './child.ts';

const child = new Child((s) => {
  process.stdout.write(s);
});

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  child.feed(chunk).catch((err) => {
    process.stderr.write(`[child] feed crashed: ${(err as Error).stack ?? err}\n`);
  });
});

process.stdin.on('end', () => {
  // Parent closed the pipe. Exit cleanly so we don't linger.
  process.exit(0);
});

// Surface uncaught crashes on stderr so the parent's `inherit`-stderr sees them.
process.on('uncaughtException', (err) => {
  process.stderr.write(`[child] uncaughtException: ${err.stack ?? err}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`[child] unhandledRejection: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
