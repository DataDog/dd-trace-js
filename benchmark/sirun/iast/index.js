'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')
const ops = require('../../../packages/dd-trace/src/appsec/iast/taint-tracking/operations')

// IAST's per-request taint-tracking cost, isolated from the express / network /
// subprocess machinery the appsec-iast live bench drags in. A request opens a
// transaction, taints its inputs (sources), and every instrumented sink checks
// isTainted / getRanges on its argument. The native
// @datadog/native-iast-taint-tracking does the work; operations.js is the
// production wrapper. Two variants:
//   request-lifecycle - open a transaction, taint a source, check a tainted and
//     an untainted sink, close it (the full per-request shape)
//   sink-check - one transaction, taint once, then loop the isTainted/getRanges
//     check that fires at every sink (the most frequent op)
const { VARIANT } = process.env
const OPERATIONS = Number(process.env.OPERATIONS)

const SOURCE = 'echo hello; cat /etc/passwd && rm -rf /tmp/x'
const UNTAINTED = 'echo a static safe command with no user input'
const TYPE = 'http.request.parameter'

let sink = 0

if (VARIANT === 'sink-check') {
  const iastContext = {}
  ops.createTransaction('sink-check', iastContext)
  const tainted = ops.newTaintedString(iastContext, SOURCE, 'param', TYPE)
  assert.ok(ops.isTainted(iastContext, tainted), 'source was not tainted')
  assert.ok(ops.getRanges(iastContext, tainted).length > 0, 'tainted source has no ranges')

  guard.loopStart()
  for (let i = 0; i < OPERATIONS; i++) {
    if (ops.isTainted(iastContext, tainted)) {
      sink += ops.getRanges(iastContext, tainted).length
    }
  }
  guard.done()

  ops.removeTransaction(iastContext)
} else {
  // Preflight one cycle so a broken taint path fails loudly instead of measuring
  // a no-op.
  const probe = {}
  ops.createTransaction('preflight', probe)
  const probeTainted = ops.newTaintedString(probe, SOURCE, 'param', TYPE)
  assert.ok(ops.isTainted(probe, probeTainted), 'source was not tainted')
  assert.equal(ops.isTainted(probe, UNTAINTED), false, 'untainted value reported tainted')
  ops.removeTransaction(probe)

  guard.loopStart()
  for (let i = 0; i < OPERATIONS; i++) {
    const iastContext = {}
    ops.createTransaction(String(i), iastContext)
    const tainted = ops.newTaintedString(iastContext, SOURCE, 'param', TYPE)
    if (ops.isTainted(iastContext, tainted)) {
      sink += ops.getRanges(iastContext, tainted).length
    }
    if (ops.isTainted(iastContext, UNTAINTED)) {
      sink += 1
    }
    ops.removeTransaction(iastContext)
  }
  guard.done()
}

assert.ok(sink > 0, 'iast bench produced no work')
