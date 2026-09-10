'use strict'

// The two `getHooks` implementations under comparison, kept verbatim here so
// the bench runs standalone on master (where the shipped helper is still the
// scan variant), and so index.js and validate.js exercise the exact same
// code. The functions below are copies of
// packages/datadog-instrumentations/src/helpers/instrument.js:
// - scan: the pre-fix implementation - map -> filter -> map over the rewriter
//   list, returning one hook per transform (duplicates included).
// - deduped: the fixed implementation - one pass over the list that skips
//   transforms whose (versionRange, filePath) was already emitted and answers
//   the requested names through a Set instead of a per-entry includes scan.

const rewriterInstrumentations =
  require('../../../packages/datadog-instrumentations/src/helpers/rewriter/instrumentations')

// The 13 queries that exist in the repo, one per getHooks call site: ai.js,
// langchain.js, mercurius.js, bullmq.js, modelcontextprotocol-sdk.js,
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

module.exports = { rewriterInstrumentations, QUERIES, scanGetHooks, dedupedGetHooks }
