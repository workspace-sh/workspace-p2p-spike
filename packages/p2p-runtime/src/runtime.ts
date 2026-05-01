// Default runtime entry — every consumer imports from here.
//
// At BUILD time the bundler picks the right `runtime.<platform>.ts` via
// platform extensions:
//   - Metro (RN): runtime.ios.ts / runtime.android.ts / runtime.macos.ts /
//     runtime.windows.ts / runtime.native.ts
//   - Vite + browser: runtime.web.ts (via resolve.conditions or alias)
//   - Plain Node: runtime.node.ts (via package.json exports → "./node")
//
// This file is the FALLBACK when no platform extension matched. It throws so
// misconfiguration is loud rather than silent.

import type { CreateRuntimeOptions, P2PRuntime } from './types.ts';

export async function createRuntime(_opts: CreateRuntimeOptions = {}): Promise<P2PRuntime> {
  throw new Error(
    '[@workspace/p2p-runtime] no platform implementation matched. ' +
      'Configure your bundler to pick runtime.<platform>.ts ' +
      '(Metro: rely on platform extensions; Vite: alias or conditions). ' +
      'For plain Node, import directly from "@workspace/p2p-runtime/node".',
  );
}

export type { P2PRuntime, Log, Did, TopicId, LogKey, CreateRuntimeOptions } from './types.ts';
