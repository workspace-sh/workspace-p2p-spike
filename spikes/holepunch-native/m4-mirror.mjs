// M4: the tree on disk. Downloaded files mirrored by MirrorDrive, the rest as placeholders.
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Localdrive from 'localdrive'
import MirrorDrive from 'mirror-drive'
import Hyperswarm from 'hyperswarm'
import createTestnet from 'hyperdht/testnet.js'
import crypto from 'node:crypto'
import { mkdtempSync, readdirSync, statSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const SUFFIX = '.sparse'
const tmp = (n) => mkdtempSync(join(tmpdir(), `m4-${n}-`))
const testnet = await createTestnet(4)
const encryptionKey = crypto.randomBytes(32)
const a = new Hyperdrive(new Corestore(tmp('a')), { encryptionKey }); await a.ready()
for (const p of ['/Report Q3 - 2026.md', '/notes/standup.md', '/notes/ideas.md', '/img/logo.png']) await a.put(p, crypto.randomBytes(5000))
const aSwarm = new Hyperswarm({ bootstrap: testnet.bootstrap }); aSwarm.on('connection', (c) => a.corestore.replicate(c))
aSwarm.join(a.discoveryKey, { server: true, client: false }); await aSwarm.flush()

const bStore = new Corestore(tmp('b'))
const b = new Hyperdrive(bStore, a.key, { encryptionKey }); await b.ready()
const bSwarm = new Hyperswarm({ bootstrap: testnet.bootstrap }); bSwarm.on('connection', (c) => bStore.replicate(c))
bSwarm.join(b.discoveryKey, { server: false, client: true }); const d = b.findingPeers(); await bSwarm.flush(); d()
await b.update({ wait: true })

const folder = tmp('folder')
const local = new Localdrive(folder)
// What this step last put on disk, by path: a file is removed on clear only if
// it is still exactly that, so an edit that has not synced yet is never lost.
const written = new Map()
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const tree = () => readdirSync(folder, { recursive: true }).filter((f) => statSync(join(folder, f)).isFile()).sort().map((f) => `${f} (${statSync(join(folder, f)).size} B)`)

async function sync() {
  // Contents: only what this device already holds. has() is local, so the
  // mirror never fetches anything.
  const held = new Set()
  for await (const e of b.list('/', { recursive: true })) if (await b.has(e.key)) held.add(e.key)
  const m = new MirrorDrive(b, local, { filter: (key) => held.has(key), ignore: (key) => key.endsWith(SUFFIX), prune: true })
  await m.done()
  // Placeholders: every entry not held gets an empty stub; a held one loses its stub.
  for await (const e of b.list('/', { recursive: true })) {
    const file = join(folder, e.key)
    const stub = file + SUFFIX
    if (held.has(e.key)) {
      if (existsSync(stub)) rmSync(stub)
      if (existsSync(file)) written.set(e.key, digest(readFileSync(file)))
      continue
    }
    // Cleared: the copy on disk goes too, or clearing frees nothing — but only
    // if it is still what this step wrote. A changed file is an edit to keep.
    if (existsSync(file) && written.get(e.key) === digest(readFileSync(file))) { rmSync(file); written.delete(e.key) }
    if (!existsSync(file) && !existsSync(stub)) { mkdirSync(dirname(stub), { recursive: true }); writeFileSync(stub, '') }
  }
  return m.count
}
console.log('after join:', await sync(), tree())
await b.get('/notes/standup.md')                       // opened
await b.download('/img').done?.()                     // pinned a folder
console.log('after opening one file and pinning /img:', await sync(), tree())
await b.clear('/notes/standup.md')                    // freed
console.log('after clearing it again:', await sync(), tree())
await b.get('/img/logo.png'); await sync()
writeFileSync(join(folder, 'img/logo.png'), 'edited locally, not yet synced')
await b.clear('/img/logo.png')
console.log('after clearing a file edited on disk:', await sync(), tree())

await aSwarm.destroy(); await bSwarm.destroy(); await testnet.destroy(); process.exit(0)
