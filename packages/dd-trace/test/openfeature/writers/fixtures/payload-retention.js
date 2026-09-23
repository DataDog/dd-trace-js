'use strict'

const assert = require('node:assert/strict')
const { setImmediate } = require('node:timers/promises')

const { iterateFlagEvaluationPayloads } = require('../../../../src/openfeature/writers/flag-evaluation-payload')

function prepare () {
  const full = new Map()
  const degraded = new Map()
  const references = []
  for (let i = 0; i < 13; i++) {
    const entry = {
      flagKey: String(i).padEnd(900000, 'x'),
      rawTargetingKey: 'target-canary',
      attrs: { secret: 'context-canary' },
      consent: i % 2 === 0,
      count: i + 1,
      first: 100,
      last: 200,
    }
    references.push({ entry: new WeakRef(entry), attrs: new WeakRef(entry.attrs) })
    const tier = i < 12 ? full : degraded
    tier.set('identity-' + i, entry)
  }
  let consumed = 0
  const iterator = iterateFlagEvaluationPayloads(full, degraded, { service: 'test' }, 300, count => {
    consumed += count
  })
  return { full, degraded, references, iterator, consumed: () => consumed }
}

async function main () {
  const state = prepare()
  const first = state.iterator.next().value
  assert.ok(first, 'the flush must yield its first payload')
  assert.strictEqual(first.rows, 5)
  assert.strictEqual(state.consumed(), 15)
  if (process.argv[2] === 'keys') {
    assert.strictEqual(state.full.size, 0, 'flush must release full-tier lookup keys')
    assert.strictEqual(state.degraded.size, 0, 'flush must release degraded-tier lookup keys')
  } else {
    // Leave the WeakRef creation job before forcing GC; keep the paused iterator alive.
    await setImmediate()
    assert.ok(global.gc, 'run the fixture with --expose-gc')
    global.gc()
    assert.strictEqual(state.references[0].entry.deref(), undefined, 'encoded entry must be collectible')
    assert.strictEqual(state.references[0].attrs.deref(), undefined, 'encoded context must be collectible')
    assert.notStrictEqual(state.references[11].entry.deref(), undefined, 'pending entry must remain available')
  }

  const payloads = [first, ...state.iterator]
  assert.deepStrictEqual(payloads.map(payload => payload.rows), [5, 5, 3])
  assert.strictEqual(state.consumed(), 91)
  assert.strictEqual(payloads.reduce((sum, payload) => sum + payload.evaluations, 0), 91)
  const rows = payloads.flatMap(payload => JSON.parse(payload.encoded).flagEvaluations)
  for (const [i, row] of rows.entries()) {
    assert.strictEqual(row.flag.key, String(i).padEnd(900000, 'x'))
    assert.strictEqual(row.evaluation_count, i + 1)
    assert.strictEqual(row.first_evaluation, 100)
    assert.strictEqual(row.last_evaluation, 200)
    assert.strictEqual(row.timestamp, 300)
    if (i === 12) {
      assert.strictEqual(row.targeting_key, undefined)
      assert.strictEqual(row.context, undefined)
    } else if (i % 2 === 0) {
      assert.strictEqual(row.targeting_key, 'target-canary')
      assert.deepStrictEqual(row.context, { evaluation: { secret: 'context-canary' } })
    } else {
      assert.match(row.targeting_key, /^sha256_[a-f0-9]{64}$/)
      assert.strictEqual(row.context, undefined)
    }
  }
}

main().catch(error => {
  process.stderr.write(error.stack + '\n')
  process.exitCode = 1
})
