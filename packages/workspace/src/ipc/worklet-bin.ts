// Entry point for the Bare worklet — the iOS/Android counterpart to
// `child-bin.ts`, one level up the stack from
// `@workspace.sh/p2p-runtime`'s own worklet entry.
//
// This is the entry the mobile app actually needs. `RemoteWorkspace`
// (./remote-base.ts, used by both remote.macos.ts and remote.ios.ts) speaks
// the WORKSPACE-level protocol in ./protocol.ts — create / open / write /
// entries — so the worklet on the other side of the byte channel has to be a
// `WorkspaceChild`, exactly as the spawned macOS child is.
//
// Bundling p2p-runtime's worklet-bin.ts here instead — which #226's
// integration checklist said to do — produces a worklet that boots fine and
// then rejects every request, because it serves the LOG-level protocol
// (init / createLog / appendBlock) that nothing on the mobile path sends.
// See #229.
//
// The macOS path spawns a Node child and speaks this protocol over
// stdin/stdout. Mobile has no child processes, so `react-native-bare-kit`
// runs a Bare instance in-process and gives it a bidirectional byte channel
// (`BareKit.IPC`) instead of pipes. Everything above the byte channel is
// identical: this file is `child-bin.ts` with the lines that touch stdio
// swapped for the ones that touch IPC.

// Bare provides no TextEncoder/TextDecoder globals, and this file runs inside
// the Bare worklet on iOS/Android. b4a covers both hosts (#243).
import b4a from 'b4a';

import { WorkspaceChild } from './child.ts';

declare const BareKit: {
  IPC: {
    write(data: Uint8Array | string): void;
    on(event: 'data', cb: (data: Uint8Array) => void): void;
    on(event: 'close', cb: () => void): void;
  };
};

const child = new WorkspaceChild((s) => {
  BareKit.IPC.write(s);
});

BareKit.IPC.on('data', (data) => {
  const chunk = typeof data === 'string' ? data : b4a.toString(data, 'utf8');
  child.feed(chunk).catch((err: unknown) => {
    // No stderr to inherit here — the host sees this through liblog, which is
    // where console output from a worklet goes.
    console.error(`[ws-worklet] feed crashed: ${(err as Error).stack ?? String(err)}`);
  });
});
