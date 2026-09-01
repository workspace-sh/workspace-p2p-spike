// Live key delivery log (#9) — the second carrier.
//
// Where the bundle (createBundle / consumeBundle) is the OFFLINE first-contact
// carrier — envelopes packed into `.workspace/envelopes/` for a recipient who
// may never be online with the sender — the key delivery log is the LIVE
// carrier. It's a replicated Hypercore log every workspace member holds; each
// block is one sealed envelope addressed to one peer's DID. Peers scan from
// their last-seen position for blocks addressed to them, unwrap, and ignore
// the rest.
//
// Used when:
//   - an admin invites someone after the workspace is already live
//   - tier keys rotate (e.g. after a departure)
//   - existing members need fresh envelopes (a new tier, a rotated key)
//
// The payload is identical to the bundle's: a UCAN delegation + a wrapped
// symmetric key, sealed to the recipient's DID. Same `createEnvelope` to
// produce, same `consumeEnvelope` to validate and unwrap. Only the transport
// differs — a log block instead of a file in a folder.
//
// See docs/permissions-model.md ("The two carriers") for the design.

// Bare provides no TextEncoder/TextDecoder globals, and this file runs inside
// the Bare worklet on iOS/Android. b4a covers both hosts (#243).
import b4a from 'b4a';

import type { Log, Did } from '@workspace.sh/p2p-runtime';

import {
  consumeEnvelope,
  serialiseEnvelope,
  deserialiseEnvelope,
  type Envelope,
  type ConsumedEnvelope,
  type SerialisedEnvelope,
} from './index.ts';

// Each block carries a tagged JSON record. The tag lets the log hold more than
// just key deliveries later (revocation blocks, per permissions-model.md, are
// the obvious next variant) without ambiguity — scanners skip records whose
// kind they don't recognise.
const DELIVERY_KIND = 'workspace/key-delivery@1' as const;

interface DeliveryRecord {
  kind: typeof DELIVERY_KIND;
  envelope: SerialisedEnvelope;
}

/**
 * Append a sealed envelope to the key delivery log. Returns the log's new
 * length. The envelope is produced exactly as a bundle envelope is — see
 * `createEnvelope`.
 */
export async function publishDelivery(log: Log, envelope: Envelope): Promise<number> {
  if (!log.writable) {
    throw new Error('key delivery log is not writable by this peer');
  }
  const record: DeliveryRecord = {
    kind: DELIVERY_KIND,
    envelope: serialiseEnvelope(envelope),
  };
  return log.append(b4a.from(JSON.stringify(record)));
}

/** A delivery that was addressed to the scanning peer and validated. */
export interface Delivery extends ConsumedEnvelope {
  /** Index of the block this delivery came from. */
  index: number;
}

export interface ScanResult {
  /** Deliveries addressed to this peer, validated and unwrapped. */
  deliveries: Delivery[];
  /**
   * New cursor: the log length scanned up to. Pass this back as `fromCursor`
   * on the next scan so history isn't re-read. Persist it per-peer (the
   * `.workspace/keys/` area in the on-disk format).
   */
  cursor: number;
}

export interface ScanDeliveriesOptions {
  /** This peer's DID — only deliveries addressed here are returned. */
  selfDid: Did;
  /** This peer's 64-byte ed25519 secret key, to unwrap. */
  selfSecretKey: Uint8Array;
  /** The workspace root DID — the canIssue authority for UCAN validation. */
  rootDid: Did;
  /** Resume from this block index (default 0). Pass back `ScanResult.cursor`. */
  fromCursor?: number;
  /** Override "now" in whole seconds — for tests. */
  now?: number;
  /**
   * Called when a block addressed to this peer fails validation or unwrap.
   * Default: swallow and skip (a single bad block shouldn't abort the scan —
   * a later block may carry a valid re-delivery). Other blocks still process.
   */
  onError?: (index: number, error: Error) => void;
}

/**
 * Scan the key delivery log for envelopes addressed to this peer.
 *
 * Reads blocks `[fromCursor, log.length)`, decodes each, and for those
 * addressed to `selfDid` validates the UCAN against `rootDid` and unwraps the
 * key. Blocks addressed to other peers — and blocks of an unrecognised kind —
 * are skipped silently. Returns the validated deliveries plus a cursor to
 * resume from next time.
 *
 * Unlike `consumeBundle`, a malformed or invalid block addressed to this peer
 * does NOT throw the whole scan: deliveries arrive over time and one bad
 * block (corrupt, superseded, or a delivery whose key was since rotated)
 * shouldn't stop a peer seeing the rest. Failures route to `onError`.
 */
export async function scanDeliveries(
  log: Log,
  opts: ScanDeliveriesOptions,
): Promise<ScanResult> {
  const from = opts.fromCursor ?? 0;
  const to = log.length;
  const deliveries: Delivery[] = [];

  for (let index = from; index < to; index++) {
    let record: DeliveryRecord;
    try {
      const parsed = JSON.parse(b4a.toString(await log.get(index), 'utf8')) as Partial<DeliveryRecord>;
      if (parsed.kind !== DELIVERY_KIND || !parsed.envelope) {
        continue; // not a key-delivery block (e.g. a future revocation block)
      }
      record = parsed as DeliveryRecord;
    } catch {
      continue; // unparseable block — not ours to interpret, skip
    }

    // Cheap filter before the expensive validate+unwrap: is it even for us?
    if (record.envelope.recipient !== opts.selfDid) continue;

    try {
      const envelope = deserialiseEnvelope(record.envelope);
      const consumed = await consumeEnvelope(
        envelope,
        opts.selfDid,
        opts.selfSecretKey,
        opts.rootDid,
        opts.now !== undefined ? { now: opts.now } : {},
      );
      deliveries.push({ ...consumed, index });
    } catch (err) {
      opts.onError?.(index, err instanceof Error ? err : new Error(String(err)));
      // skip and continue — see docstring
    }
  }

  return { deliveries, cursor: to };
}
