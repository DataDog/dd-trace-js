'use strict'

// Timing harness: WARMUP discarded + COUNT timed in-process iterations, written as TIMEIT_OUTPUT JSON (see README.md).

const fs = require('node:fs')

const { runBenchmark, parseIntegerEnv, COMMIT_EVERY, NUM_THREADS } = require('./kafka-dsm')

function median (values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function stdErr (values) {
  if (values.length <= 1) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance) / Math.sqrt(values.length)
}

async function main () {
  const warmup = parseIntegerEnv('WARMUP', 5, 0)
  const count = parseIntegerEnv('COUNT', 25, 1)
  const outputPath = process.env.TIMEIT_OUTPUT || 'results.json'

  let runId = 0
  for (let i = 0; i < warmup; i++) {
    await runBenchmark(runId++)
  }

  const durationsMs = []
  const iterationWallMs = []
  const rssBytes = []
  const produceMs = []
  const consumeMs = []

  for (let i = 0; i < count; i++) {
    const start = process.hrtime.bigint()
    const phases = await runBenchmark(runId++)
    iterationWallMs.push(Number(process.hrtime.bigint() - start) / 1e6)
    durationsMs.push(phases.produceMs + phases.consumeMs)
    rssBytes.push(process.memoryUsage().rss)
    produceMs.push(phases.produceMs)
    consumeMs.push(phases.consumeMs)
  }

  const metrics = {
    'process.internal_duration_ms.median': median(durationsMs),
    'process.internal_duration_ms.std_err': stdErr(durationsMs),
    'process.rss_bytes.median': median(rssBytes),
    // Whole-iteration wall time, incl. setup/teardown: context only.
    'process.iteration_wall_ms.median': median(iterationWallMs),
    'phase.produce_ms.median': median(produceMs),
    'phase.consume_ms.median': median(consumeMs),
    'config.commit_every': COMMIT_EVERY,
    'config.num_threads': NUM_THREADS,
  }
  // Per-iteration input of bp-analyzer's TimeItSharp converter, under its metric names (dotnet name = RSS).
  const data = durationsMs.map((durationMs, i) => ({
    status: 'Passed',
    metrics: {
      'process.internal_duration_ms': durationMs,
      'process.corrected_duration_ms': iterationWallMs[i],
      'runtime.dotnet.mem.committed': rssBytes[i],
    },
  }))
  const result = [{
    median: metrics['process.internal_duration_ms.median'],
    metrics,
    name: process.env.EXPERIMENT_NAME || 'kafka_dsm',
    warmUpCount: warmup,
    count,
    data,
  }]

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n')

  // eslint-disable-next-line no-console
  console.log(
    `Duration (produce+consume) median: ${metrics['process.internal_duration_ms.median'].toFixed(3)} ms ` +
    `(± ${metrics['process.internal_duration_ms.std_err'].toFixed(3)}) | ` +
    `RSS median: ${(metrics['process.rss_bytes.median'] / 1_000_000).toFixed(2)} MB | ` +
    `produce median: ${metrics['phase.produce_ms.median'].toFixed(3)} ms | ` +
    `consume+commit median: ${metrics['phase.consume_ms.median'].toFixed(3)} ms | ` +
    `iteration wall median (context only): ${metrics['process.iteration_wall_ms.median'].toFixed(3)} ms | ` +
    `runs: ${count} (warmup ${warmup}) | commit every ${COMMIT_EVERY} | threads: ${NUM_THREADS}`
  )
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
