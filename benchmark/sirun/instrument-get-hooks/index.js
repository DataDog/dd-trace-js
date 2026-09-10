'use strict'

const assert = require('node:assert/strict')

const guard = require('../startup-guard')

// Cost-of-correctness benchmark for `getHooks` in
// packages/datadog-instrumentations/src/helpers/instrument.js, quantifying the
// fix that dedupes rewriter hooks by (versionRange, filePath). Both
// implementations are kept here verbatim so the bench runs standalone:
// - scan: the pre-fix implementation - map -> filter -> map over the rewriter
//   list, returning one hook per transform (duplicates included).
// - deduped: the fixed implementation - one pass over the list that skips
//   transforms whose (versionRange, filePath) was already emitted and answers
//   the requested names through a Set instead of a per-entry includes scan.
//
// The workload models what production actually does. `getHooks` is called
// once per module name, lazily, from integration files that
// helpers/register.js only runs when the user's package loads; a traced
// process performs zero of these calls at tracer init, and all 13 only when
// every instrumented package family is used. So there is no hot loop to
// optimize and no startup cost to charge against lookup savings: the
// question this bench answers is how much the dedupe costs (or saves) per
// startup, at the real query count.
//
// Variants (see meta.json):
// - *-cold: one simulated startup through the measured window per process -
//   each sirun iteration is a fresh process, so the window is paid cold,
//   exactly where production pays it. The share guard is vacuous for these
//   by design (load+setup legitimately dominates a single pass).
// - *-warm: 20 000 simulated startups per process, for steady-state per-call
//   signal over the same workload.

const STARTUPS = Number(process.env.STARTUPS) || 20000
const SCAN = Number(process.env.SCAN)

const rewriterInstrumentations =
  require('../../../packages/datadog-instrumentations/src/helpers/rewriter/instrumentations')

// The 13 queries that exist in the repo, one per getHooks call site:
// ai.js, langchain.js, mercurius.js, bullmq.js, modelcontextprotocol-sdk.js,
// openai-agents.js, langgraph.js, aws-durable-execution-sdk-js.js,
// azure-cosmos.js, claude-agent-sdk.js and the three from graphql.js.
const QUERIES = [
  'ai',
  '@langchain/core',
  'mercurius',
  'bullmq',
  '@modelcontextprotocol/sdk',
  '@openai/agents-openai',
  '@langchain/langgraph',
  '@aws/durable-execution-sdk-js',
  '@azure/cosmos',
  '@anthropic-ai/claude-agent-sdk',
  'graphql',
  '@graphql-tools/executor',
  'graphql-jit',
]

function scanGetHooks (names) {
  names = [names].flat()

  return rewriterInstrumentations
    .map(inst => inst.module)
    .filter(({ name }) => names.includes(name))
    .map(({ name, versionRange, filePath }) => ({ name, versions: [versionRange], file: filePath }))
}

function dedupedGetHooks (names) {
  const requested = new Set([names].flat())
  const seen = new Set()
  const hooks = []
  for (const { module } of rewriterInstrumentations) {
    if (!requested.has(module.name)) continue
    const key = `${module.versionRange}|${module.filePath}`
    if (seen.has(key)) continue
    seen.add(key)
    hooks.push({ name: module.name, versions: [module.versionRange], file: module.filePath })
  }
  return hooks
}

// One simulated startup: resolve the hooks every lazy integration resolves
// when its user package loads.
function resolveStartup () {
  const getHooks = SCAN ? scanGetHooks : dedupedGetHooks
  let hooks = 0
  for (const name of QUERIES) hooks += getHooks(name).length
  return hooks
}

let sink = 0

guard.loopStart()
for (let i = 0; i < STARTUPS; i++) {
  sink += resolveStartup()
}
// Cold variants run a single startup through the window, so load+setup
// legitimately dominates; only the warm variants enforce a share ceiling.
guard.done(STARTUPS > 1 ? 0.15 : 1)

assert.ok(sink > 0, 'benchmark did no work')

// The deduped variant must answer exactly the distinct hooks of the scan
// variant, or the two are not measuring the same workload. The counts differ
// on purpose: the scan variant resolves 144 hook objects per startup (one
// per transform), the deduped variant 66 (one per distinct
// (versionRange, filePath) pair).
//
// This validates AFTER the measured window, on purpose: the cold variants
// must put a genuinely first execution of both implementations through the
// window, and pre-flight assertions would warm the functions and the
// instrumentation data in every fresh process - turning the "cold" pass into
// each function's fourteenth invocation. A mismatch still fails the process.
for (const name of QUERIES) {
  const scanned = scanGetHooks(name)
  const byKey = new Map(scanned.map(hook => [`${hook.versions[0]}|${hook.file}`, hook]))
  const uniqueScanned = [...byKey.values()].map(({ name, versions, file }) => ({ name, versions, file }))
  assert.deepStrictEqual(uniqueScanned, dedupedGetHooks(name))
}
