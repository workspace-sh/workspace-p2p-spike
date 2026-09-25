// Which DHT a child process uses when a request does not say.
//
// Platform-free on purpose: the parser takes the variable's value, and only
// the Node entry point (`child-bin.ts`) reads the environment, so this file is
// safe in the Bare worklet graph too.

import type { BootstrapNode } from './protocol.ts';

/** The environment variable `child-bin.ts` reads. */
export const BOOTSTRAP_ENV = 'WORKSPACE_P2P_BOOTSTRAP';

/**
 * Parse `WORKSPACE_P2P_BOOTSTRAP`.
 *
 * - unset: `undefined`, meaning the public DHT.
 * - `none`: `[]`, a swarm with no DHT at all, so nothing leaves the machine.
 * - `host:port[,host:port…]`: those bootstrap nodes, for a private DHT on
 *   localhost or a LAN. An IPv6 host is written in brackets: `[::1]:49737`.
 *
 * Anything else throws. A typo that quietly fell back to the public DHT would
 * announce a workspace to the internet from a run that meant to stay local.
 */
export function parseBootstrap(value: string | undefined): BootstrapNode[] | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === 'none') return [];
  if (trimmed.length === 0) {
    throw new Error(`${BOOTSTRAP_ENV} is set but empty; use "none" for no DHT, or host:port`);
  }
  return trimmed.split(',').map((entry) => {
    const node = entry.trim();
    const colon = node.lastIndexOf(':');
    const rawHost = colon > 0 ? node.slice(0, colon) : '';
    const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
    const portText = colon > 0 ? node.slice(colon + 1) : '';
    const port = /^\d+$/.test(portText) ? Number(portText) : NaN;
    if (host.length === 0 || host.includes(':') !== rawHost.startsWith('[') || !(port > 0 && port < 65536)) {
      throw new Error(`${BOOTSTRAP_ENV}: "${node}" is not host:port`);
    }
    return { host, port };
  });
}
