// M1: an encrypted Hyperdrive — tree on join, contents on demand.
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperswarm from 'hyperswarm'
import createTestnet from 'hyperdht/testnet.js'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FILES = Number(process.env.FILES ?? 1000)
const SIZE = Number(process.env.SIZE ?? 20_000)
const t = () => performance.now()
const tmp = (n) => mkdtempSync(join(tmpdir(), `m1-${n}-`))
const testnet = await createTestnet(4)
const encryptionKey = crypto.randomBytes(32)

const aStore = new Corestore(tmp('a'))
const a = new Hyperdrive(aStore, { encryptionKey })
await a.ready()
let t0 = t()
const batch = a.batch()
for (let i = 0; i < FILES; i++) {
  await batch.put(`/notes/folder-${i % 20}/doc-${i}.md`, crypto.randomBytes(SIZE))
}
await batch.flush()
console.log(`write: ${FILES} files × ${SIZE} B in ${(t() - t0).toFixed(0)} ms; metadata core ${a.core.length} blocks, blobs core ${a.blobs.core.length} blocks`)

const aSwarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
aSwarm.on('connection', (c) => aStore.replicate(c))
aSwarm.join(a.discoveryKey, { server: true, client: false }); await aSwarm.flush()

const bStore = new Corestore(tmp('b'))
const b = new Hyperdrive(bStore, a.key, { encryptionKey })
await b.ready()
let downloaded = 0
const count = (core) => core.on('download', (_i, bytes) => { downloaded += bytes })
count(b.core)
const bSwarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
bSwarm.on('connection', (c) => bStore.replicate(c))
t0 = t()
bSwarm.join(b.discoveryKey, { server: false, client: true })
const done = b.findingPeers(); await bSwarm.flush(); done()
await b.update({ wait: true })
const tConnect = t() - t0

t0 = t()
let entries = 0, declared = 0
for await (const e of b.list('/', { recursive: true })) { entries++; declared += e.value.blob.byteLength }
const tTree = t() - t0
await b.getBlobs(); count(b.blobs.core)
console.log(`join: connected+updated ${tConnect.toFixed(0)} ms; listed ${entries} entries (declared ${(declared/1e6).toFixed(1)} MB) in ${tTree.toFixed(0)} ms, downloading ${(downloaded/1e3).toFixed(0)} KB`)

const path = `/notes/folder-${(FILES - 3) % 20}/doc-${FILES - 3}.md`
console.log(`has before open: ${await b.has(path)}`)
const before = downloaded; t0 = t()
const got = await b.get(path)
console.log(`open one file: ${got.byteLength} B in ${(t() - t0).toFixed(0)} ms, downloading ${((downloaded - before)/1e3).toFixed(1)} KB; has after: ${await b.has(path)}`)
await b.clear(path)
console.log(`after clear: has ${await b.has(path)}, still listed: ${(await b.entry(path)) !== null}`)
const again = await b.get(path)
console.log(`re-open after clear: ${again.byteLength} B, equal: ${Buffer.compare(again, got) === 0}`)

// A reader without the key.
const cStore = new Corestore(tmp('c'))
const c = new Hyperdrive(cStore, a.key)
await c.ready()
const cSwarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
cSwarm.on('connection', (x) => cStore.replicate(x))
cSwarm.join(c.discoveryKey, { server: false, client: true })
const d2 = c.findingPeers(); await cSwarm.flush(); d2()
await c.update({ wait: true })
try { let n = 0; for await (const _ of c.list('/', { recursive: true })) n++; console.log(`no key: listed ${n} entries (!)`) }
catch (e) { console.log(`no key: listing refused — ${e.code ?? e.message}`) }

await Promise.all([aSwarm.destroy(), bSwarm.destroy(), cSwarm.destroy()])
await Promise.all([a.close(), b.close(), c.close()])
await testnet.destroy()
process.exit(0)
