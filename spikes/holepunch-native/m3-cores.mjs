// M3: what N cores cost a device that joins: time to sync all, and memory.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import createTestnet from 'hyperdht/testnet.js'
import b4a from 'b4a'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const N = Number(process.env.N ?? 100)
const tmp = (n) => mkdtempSync(join(tmpdir(), `m3-${n}-`))
const testnet = await createTestnet(4)
const key = crypto.randomBytes(32)
const topic = crypto.randomBytes(32)

const aStore = new Corestore(tmp('a'))
const keys = []
for (let i = 0; i < N; i++) {
  const c = aStore.get({ name: `core-${i}`, encryption: { key } }); await c.ready()
  for (let j = 0; j < 10; j++) await c.append(b4a.from(`core ${i} block ${j} `.padEnd(200, '.')))
  keys.push(c.key)
}
const aSwarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
aSwarm.on('connection', (c) => aStore.replicate(c))
aSwarm.join(topic, { server: true, client: false }); await aSwarm.flush()

global.gc?.()
const rss0 = process.memoryUsage().rss
const bStore = new Corestore(tmp('b'))
const bSwarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
bSwarm.on('connection', (c) => bStore.replicate(c))
const t0 = performance.now()
bSwarm.join(topic, { server: false, client: true }); await bSwarm.flush()
const cores = await Promise.all(keys.map(async (k) => { const c = bStore.get({ key: k, encryption: { key } }); await c.ready(); return c }))
await Promise.all(cores.map(async (c) => { await c.update({ wait: true }); await c.download({ start: 0, end: c.length }).done(); await c.get(c.length - 1) }))
const ms = performance.now() - t0
global.gc?.()
const rss = process.memoryUsage().rss
console.log(`N=${N}: all synced and read in ${ms.toFixed(0)} ms; this process's RSS grew ${((rss - rss0) / 1e6).toFixed(0)} MB (includes the writer's side: one process holds both)`)
await aSwarm.destroy(); await bSwarm.destroy(); await testnet.destroy(); process.exit(0)
