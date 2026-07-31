// Private hyperdht bootstrap node.
//
// Run this in one terminal; point your test peers at it via the `bootstrap`
// runtime option. All DHT traffic stays between this process and the peers
// you configure — nothing leaves your machine.
//
// This is the layered-discovery story's escape hatch for testing (see
// docs/discovery-layers.md). It's also the mechanism a Lighthouse can sit
// on top of when an org wants to run its own DHT for a remote team.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DHT = require('hyperdht') as any;

const DEFAULT_PORT = 49737;
const DEFAULT_HOST = '127.0.0.1';

async function main(): Promise<void> {
  const port = Number(process.env.BOOTSTRAP_PORT ?? DEFAULT_PORT);
  const host = process.env.BOOTSTRAP_HOST ?? DEFAULT_HOST;

  // HyperDHT.bootstrapper(port, host) is the canonical helper for spinning
  // up a bootstrap-only node (mirrors what `hyperdht --host …` does on the
  // CLI). It sets the right combination of options so other peers can use
  // this node as their `bootstrap` entry without contacting the public DHT.
  const node = DHT.bootstrapper(port, host);
  await node.ready();

  // eslint-disable-next-line no-console
  console.log(`[bootstrap-dht] listening on ${host}:${port}`);
  // eslint-disable-next-line no-console
  console.log(`[bootstrap-dht] point peers at:  bootstrap: [{ host: '${host}', port: ${port} }]`);
  // eslint-disable-next-line no-console
  console.log(`[bootstrap-dht] Ctrl-C to shut down`);

  const shutdown = async (): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log('[bootstrap-dht] shutting down…');
    await node.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[bootstrap-dht] FAIL:', err);
  process.exit(1);
});
