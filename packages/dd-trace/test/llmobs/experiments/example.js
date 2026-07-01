'use strict'

/* eslint-disable no-console, n/no-process-exit */

// Manual end-to-end demo of the LLM Obs Experiments API (tracer.llmobs.experiments).
// Not a spec — mocha only runs *.spec.js, so this file is skipped by the suite.
//
// It exercises everything added in this PR against a real Datadog org:
//   - create a dataset + add records, run an experiment with boolean / numeric /
//     categorical evaluators, and print the dataset + experiment URLs
//   - a dataset create -> push -> pull round-trip
//
// Run:
//   DD_API_KEY=... DD_APP_KEY=... [DD_SITE=datadoghq.com] \
//     node packages/dd-trace/test/llmobs/experiments/example.js

const tracer = require('../../../../..')

function requireEnv (name) {
  const value = process.env[name]
  if (!value) {
    console.error(`Missing required env var: ${name}`)
    process.exit(1)
  }
  return value
}

// Mock task: does the prompt contain any keyword from the topics list?
function keywordOverlap (prompt, topics) {
  const haystack = prompt.toLowerCase()
  for (const topic of topics.split(',')) {
    for (const word of topic.trim().toLowerCase().split(/\s+/)) {
      if (word !== '' && haystack.includes(word)) return true
    }
  }
  return false
}

async function runExperiment (experiments) {
  console.log('\n=== Experiment: topic relevance ===')
  const dataset = experiments.createDataset('node-tracer-topic-relevance', 'demo dataset')
    .addRecord({ prompt: 'I love hiking in the mountains on weekends.', topics: 'outdoor, travel' }, 'true',
      { source: 'synthetic', difficulty: 'easy' })
    .addRecord({ prompt: 'Explain quantum entanglement in two sentences.', topics: 'outdoor, travel' }, 'false',
      { source: 'synthetic', difficulty: 'easy' })
    .addRecord({ prompt: 'Best Italian restaurants in Brooklyn?', topics: 'food, nyc' }, 'true',
      { source: 'user-report', difficulty: 'medium' })

  const result = await experiments.experiment({
    name: 'topic-relevance-demo',
    dataset,
    task: (input) => {
      const overlap = keywordOverlap(input.prompt, input.topics)
      return { response: String(overlap), confidence: overlap ? 0.85 : 0.65 }
    },
    evaluators: {
      exact_match: (_input, output, expected) => output.response === expected, // boolean
      confidence_score: (_input, output) => Number(output.confidence), // score
      verdict_category: (_input, output) => (output.response === 'true' ? 'in-topic' : 'off-topic'), // categorical
    },
    config: { approach: 'keyword-overlap', version: 'v0.1' },
    tags: { variant: 'node-tracer' },
  }).run()

  console.log(`Dataset URL    : ${dataset.url()}`)
  console.log(`Experiment URL : ${result.url}`)
  console.log(`Experiment ID  : ${result.experimentId}`)
  console.log(`Rows           : ${result.rows.length}`)
  for (const row of result.rows) {
    console.log(`  row ${row.index} status=${row.isError ? 'error' : 'ok'} evals=${JSON.stringify(row.evaluations)}`)
  }
}

async function runDatasetOps (experiments) {
  console.log('\n=== Dataset operations: create / push / pull ===')
  const name = `node-tracer-capitals-${Date.now()}`
  const dataset = experiments.createDataset(name, 'country -> capital')
    .addRecord({ country: 'France' }, 'Paris', { continent: 'Europe' })
    .addRecord({ country: 'Japan' }, 'Tokyo', { continent: 'Asia' })
  await dataset.push()
  console.log(`Created dataset id : ${dataset.id()}`)
  console.log(`Dataset URL        : ${dataset.url()}`)
  console.log(`Pushed records     : ${dataset.records().length}`)

  const pulled = await experiments.pullDataset(name, { expectedRecordCount: dataset.records().length })
  console.log(`Pulled dataset id  : ${pulled.id()}`)
  console.log(`Pulled records     : ${pulled.records().length}`)
  for (const [i, record] of pulled.records().entries()) {
    console.log(`  [${i}] input=${JSON.stringify(record.input)} expected=${JSON.stringify(record.expectedOutput)}`)
  }
}

async function main () {
  // DD_API_KEY / DD_APP_KEY (and optionally DD_SITE) are read from the env.
  requireEnv('DD_API_KEY')
  requireEnv('DD_APP_KEY')

  tracer.init({
    llmobs: { mlApp: 'node-tracer-experiments-demo' },
  })

  const { experiments } = tracer.llmobs
  await runExperiment(experiments)
  await runDatasetOps(experiments)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
