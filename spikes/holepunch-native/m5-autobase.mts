// M5: multi-writer on Autobase, encrypted, with a Hyperbee view as the tree.
// A writer is added only when its request carries a valid UCAN write delegation.
import Corestore from 'corestore'
import Autobase from 'autobase'
import Hyperbee from 'hyperbee'
import b4a from 'b4a'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { principalFromSeed, didOf, issueDelegation, validateDelegation, toBytes, fromBytes }
  from '../../../workspace/packages/ucan-boundary/src/index.ts' // adjust to your monorepo checkout

const tmp = (n: string) => mkdtempSync(join(tmpdir(), `m5-${n}-`))
const root = await principalFromSeed(crypto.randomBytes(32))
const resource = `workspace://v1/${didOf(root).slice('did:key:'.length)}`
const rootDid = didOf(root)
const encryptionKey = crypto.randomBytes(32)
const refused: string[] = []

function open(store: any) {
  return new Hyperbee(store.get('tree'), { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false })
}
async function apply(nodes: any[], view: any, host: any) {
  for (const { value } of nodes) {
    if (value.addWriter) {
      // UCAN decides. `now: 0`: apply must be deterministic, since Autobase
      // undoes and reapplies it, so no device's clock may enter it.
      const token = await fromBytes(b4a.from(value.proof, 'base64'))
      const verdict = await validateDelegation(token, { rootForResource: () => rootDid, now: 0 } as any)
      const cap = verdict.ok ? verdict.capability : null
      if (!verdict.ok || cap.with !== resource || cap.can !== 'workspace/write' || token.meta.audience !== value.did) {
        refused.push(value.did.slice(-6)); continue
      }
      await host.addWriter(b4a.from(value.addWriter, 'hex'), { indexer: true })
      continue
    }
    if (value.put) await view.put(value.put, { size: value.size, by: value.by })
  }
}
const base = (store: any, key: any) => new Autobase(store, key, { open, apply, valueEncoding: 'json', encryptionKey, ackInterval: 50 })

const aStore = new Corestore(tmp('a')), bStore = new Corestore(tmp('b')), cStore = new Corestore(tmp('c'))
const a = base(aStore, null); await a.ready()
const b = base(bStore, a.key); await b.ready()
const c = base(cStore, a.key); await c.ready()
const pipe = (x: any, y: any) => { const s1 = x.replicate(true), s2 = y.replicate(false); s1.pipe(s2).pipe(s1) }
pipe(aStore, bStore); pipe(aStore, cStore); pipe(bStore, cStore)

const bWriter = await principalFromSeed(crypto.randomBytes(32))
const cWriter = await principalFromSeed(crypto.randomBytes(32))
const grant = await issueDelegation({ issuer: root, audience: didOf(bWriter), capabilities: [{ can: 'workspace/write', with: resource }] } as any)
const readOnly = await issueDelegation({ issuer: root, audience: didOf(cWriter), capabilities: [{ can: 'workspace/read', with: resource }] } as any)
await a.append({ addWriter: b4a.toString(b.local.key, 'hex'), did: didOf(bWriter), proof: b4a.toString(await toBytes(grant), 'base64') })
await a.append({ addWriter: b4a.toString(c.local.key, 'hex'), did: didOf(cWriter), proof: b4a.toString(await toBytes(readOnly), 'base64') })
await a.update(); await b.update(); await c.update()
await new Promise((r) => setTimeout(r, 500)); await b.update(); await c.update()
console.log(`writable: B ${b.writable}, C ${c.writable}; refused addWriter for: ${refused.join(', ') || 'nobody'}`)

// Concurrent edits: A and B write at once, including the same path.
await Promise.all([
  a.append({ put: '/Report Q3 - 2026.md', size: 5000, by: 'A' }),
  b.append({ put: '/notes/standup.md', size: 900, by: 'B' }),
  a.append({ put: '/shared.md', size: 10, by: 'A' }),
  b.append({ put: '/shared.md', size: 20, by: 'B' }),
])
for (let i = 0; i < 20; i++) { await Promise.all([a.update(), b.update(), c.update()]); await new Promise((r) => setTimeout(r, 100)) }
const dump = async (x: any) => { const out: string[] = []; for await (const e of x.view.createReadStream()) out.push(`${e.key}←${e.value.by}`); return out.join(' ') }
const [ta, tb, tc] = [await dump(a), await dump(b), await dump(c)]
console.log(`A: ${ta}\nB: ${tb}\nC: ${tc}\nconverged: ${ta === tb && tb === tc}`)
try { await c.append({ put: '/sneaky.md', size: 1, by: 'C' }); console.log('C appended?!') } catch (e: any) { console.log(`C cannot append: ${e.message.slice(0, 60)}`) }
await Promise.all([a.close(), b.close(), c.close()]); process.exit(0)
