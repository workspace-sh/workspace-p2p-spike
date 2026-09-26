// M2: one core, blocks sealed per tier by a Hypercore encryption provider.
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import createTestnet from 'hyperdht/testnet.js'
import sodium from 'sodium-universal'
import b4a from 'b4a'
import crypto from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PADDING = 8 // [type][tier id][reserved×2][key period uint32]
const TIERS = { org: 1, hr: 2 }

/** A HypercoreEncryption provider holding the tier keys this device has. */
class TierEncryption {
  constructor(keys /* Map<tierId, key> */) { this.keys = keys; this.tier = TIERS.org }
  padding() { return PADDING }
  encrypt(index, block, fork) {
    const padding = block.subarray(0, PADDING)
    padding.fill(0); padding[0] = 1; padding[1] = this.tier
    const key = this.keys.get(this.tier)
    if (!key) throw new Error(`no key for tier ${this.tier}`)
    const body = block.subarray(PADDING)
    sodium.crypto_stream_xor(body, body, nonceFor(index, padding), key)
  }
  decrypt(index, block) {
    const padding = block.subarray(0, PADDING)
    const key = this.keys.get(padding[1])
    if (!key) { const e = new Error(`tier ${padding[1]} not readable here`); e.code = 'TIER_LOCKED'; throw e }
    const body = block.subarray(PADDING)
    sodium.crypto_stream_xor(body, body, nonceFor(index, padding), key)
  }
}
function nonceFor(index, padding) {
  const n = b4a.alloc(sodium.crypto_stream_NONCEBYTES)
  n.writeBigUInt64LE(BigInt(index), 0); n.set(padding, 8)
  return n
}

const tmp = (n) => mkdtempSync(join(tmpdir(), `m2-${n}-`))
const testnet = await createTestnet(4)
const orgKey = crypto.randomBytes(32), hrKey = crypto.randomBytes(32)

const aStore = new Corestore(tmp('a'))
const a = aStore.get({ name: 'records' }); await a.ready()
const aEnc = new TierEncryption(new Map([[TIERS.org, orgKey], [TIERS.hr, hrKey]]))
await a.setEncryption(aEnc)
const rows = [['org', 'Sam · Design team'], ['hr', 'Sam · salary 61,000'], ['org', 'Ana · Research'], ['hr', 'Ana · salary 64,500']]
for (const [tier, text] of rows) { aEnc.tier = TIERS[tier]; await a.append(b4a.from(text)) }

const aSwarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
aSwarm.on('connection', (c) => aStore.replicate(c))
aSwarm.join(a.discoveryKey, { server: true, client: false }); await aSwarm.flush()

async function reader(name, keys) {
  const store = new Corestore(tmp(name))
  const core = store.get({ key: a.key }); await core.ready()
  if (keys) await core.setEncryption(new TierEncryption(keys))
  const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  swarm.on('connection', (c) => store.replicate(c))
  swarm.join(core.discoveryKey, { server: false, client: true })
  const done = core.findingPeers(); await swarm.flush(); done()
  await core.update({ wait: true })
  await core.download({ start: 0, end: core.length }).done()
  const seen = []
  for (let i = 0; i < core.length; i++) {
    try { seen.push(b4a.toString(await core.get(i))) }
    catch (e) { seen.push(`<${e.code ?? e.message}>`) }
  }
  console.log(`${name}: length ${core.length}, held ${core.contiguousLength}/${core.length} blocks, reads:`, seen)
  await swarm.destroy(); await core.close()
}
await reader('everyone (org key)', new Map([[TIERS.org, orgKey]]))
await reader('HR (org + hr keys)', new Map([[TIERS.org, orgKey], [TIERS.hr, hrKey]]))
await reader('no keys', null)

await aSwarm.destroy(); await a.close(); await testnet.destroy(); process.exit(0)
