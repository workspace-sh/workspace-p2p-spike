// Phase 1 smoke harness — runs two NodeRuntime instances in one process,
// joins them on a shared Hyperswarm topic, and confirms a log replicates
// from one to the other through the actual DHT.
//
// Requires internet access for the Hyperswarm bootstrap. The integration
// test in packages/p2p-runtime/tests/replicate.test.ts exercises the
// replication path itself without the network; this script proves the
// discovery + transport piece works end-to-end.

import { createHash } from 'node:crypto';
import { createRuntime } from '@workspace.sh/p2p-runtime/node';

const dec = new TextDecoder();
const enc = new TextEncoder();

function logStep(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[smoke] ${msg}`);
}

function topicFromString(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

async function main(): Promise<void> {
  logStep('starting two runtimes…');
  const a = await createRuntime();
  const b = await createRuntime();
  logStep(`peer A: ${a.did().slice(0, 32)}…`);
  logStep(`peer B: ${b.did().slice(0, 32)}…`);

  const logA = await a.createLog();
  logStep(`peer A created log key=${logA.key.slice(0, 16)}…`);

  const logB = await b.openLog(logA.key);
  logStep(`peer B opened the same log key`);

  // Use a unique topic per run so we don't collide with other runs in flight.
  const topic = topicFromString(`p2p-runtime/smoke/${Date.now()}/${Math.random()}`);
  logStep(`joining topic ${topic.slice(0, 16)}…`);
  await a.joinTopic(topic);
  await b.joinTopic(topic);
  logStep('both peers joined; waiting for swarm connection…');

  await logA.append(enc.encode('hello'));
  await logA.append(enc.encode('from'));
  await logA.append(enc.encode('peer A'));
  logStep(`peer A appended 3 blocks (logA.length=${logA.length})`);

  const deadlineMs = 30_000;
  const start = Date.now();
  while (logB.length < 3 && Date.now() - start < deadlineMs) {
    await new Promise((r) => setTimeout(r, 250));
  }

  if (logB.length < 3) {
    // eslint-disable-next-line no-console
    console.error(
      `[smoke] FAIL — replication timed out after ${deadlineMs}ms (logB.length=${logB.length})`,
    );
    await a.close();
    await b.close();
    process.exit(1);
  }

  for (let i = 0; i < logB.length; i++) {
    const block = await logB.get(i);
    logStep(`logB[${i}] = ${dec.decode(block)}`);
  }
  logStep(`OK — replication confirmed via Hyperswarm in ${Date.now() - start}ms`);

  await a.close();
  await b.close();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[smoke] crashed:', err);
  process.exit(1);
});
