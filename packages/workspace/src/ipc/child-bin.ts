// Entry point for the spawned Workspace child process.
//
//   node --experimental-strip-types --no-warnings <path-to-this-file>
//
// stdin/stdout carry JSON-RPC (see ./protocol.ts); stderr is free-form logs.
// Same shape as @workspace.sh/p2p-runtime's own child-bin.ts, one level up
// the stack (Workspace operations instead of raw Log operations).
//
// WORKSPACE_P2P_BOOTSTRAP, read from the environment the child inherits,
// chooses the DHT for requests that name none: unset for the public DHT,
// `none` for no DHT, or `host:port[,…]` for a private one (./bootstrap.ts).

import { BOOTSTRAP_ENV, parseBootstrap } from './bootstrap.ts';
import { WorkspaceChild } from './child.ts';

const bootstrap = parseBootstrap(process.env[BOOTSTRAP_ENV]);
if (bootstrap !== undefined) {
  process.stderr.write(
    `[ws-child] DHT: ${bootstrap.length === 0 ? 'none' : bootstrap.map((n) => `${n.host}:${n.port}`).join(', ')}\n`,
  );
}

const child = new WorkspaceChild(
  (s) => {
    process.stdout.write(s);
  },
  { bootstrap },
);

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  child.feed(chunk).catch((err) => {
    process.stderr.write(`[ws-child] feed crashed: ${(err as Error).stack ?? err}\n`);
  });
});

/** How long a quitting parent's workspaces get to flush before the child exits. */
const CLOSE_ALL_MS = 5_000;

process.stdin.on('end', () => {
  // The parent closed the pipe, usually because the app quit. Its workspaces
  // were not closed one by one, so close them here, which copies each log into
  // its folder, and then exit. Bounded, because closing a runtime can wait on
  // the network (#254) and a quit must not hang.
  const timeout = new Promise((resolve) => setTimeout(resolve, CLOSE_ALL_MS));
  void Promise.race([child.closeAll(), timeout]).finally(() => process.exit(0));
});

process.on('uncaughtException', (err) => {
  process.stderr.write(`[ws-child] uncaughtException: ${err.stack ?? err}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  process.stderr.write(`[ws-child] unhandledRejection: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
