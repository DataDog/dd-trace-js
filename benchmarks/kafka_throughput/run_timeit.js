'use strict'

/**
 * Timing harness for the Kafka throughput workload.
 *
 * Node.js stand-in for `dotnet timeit --count 25 --warmup 5` and the Python
 * `run_timeit.py`. Runs the workload for a fixed number of warmup + timed
 * iterations in-process (so the tracer, when enabled via `-r dd-trace/init`,
 * stays active across all iterations), then emits a JSON artifact in the
 * shape `steps/compare-results.py` expects:
 *
 *   [
 *     {
 *       "median": <median duration ms>,
 *       "metrics": {
 *         "process.internal_duration_ms.median": <ms>,
 *         "process.internal_duration_ms.std_err": <ms>,
 *         "process.rss_bytes.median": <bytes>
 *       }
 *     }
 *   ]
 *
 * Duration is wall-clock per iteration; the memory metric is process RSS
 * (`process.memoryUsage().rss`), the cross-language analog of Python's
 * psutil RSS and .NET's `runtime.dotnet.mem.committed`. Medians are used for
 * robustness against outliers, matching the Python/.NET gate.
 */

const fs = require('fs')
const { runBenchmark } = require('./kafka_throughput')

function median (values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function stdErr (values) {
  if (values.length <= 1) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance) / Math.sqrt(values.length)
}

async function main () {
  const warmup = parseInt(process.env.WARMUP || '5', 10)
  const count = parseInt(process.env.COUNT || '25', 10)
  const outputPath = process.env.TIMEIT_OUTPUT || 'results.json'

  let runId = 0

  // Warmup iterations are discarded.
  for (let i = 0; i < warmup; i++) {
    await runBenchmark(runId)
    runId++
  }

  const durationsMs = []
  const rssBytes = []
  const produceMs = []
  const consumeMs = []

  for (let i = 0; i < count; i++) {
    const start = process.hrtime.bigint()
    const phases = await runBenchmark(runId)
    durationsMs.push(Number(process.hrtime.bigint() - start) / 1e6)
    rssBytes.push(process.memoryUsage().rss)
    produceMs.push(phases.produceMs)
    consumeMs.push(phases.consumeMs)
    runId++
  }

  const durationMedian = median(durationsMs)
  const durationStdErr = stdErr(durationsMs)
  const rssMedian = median(rssBytes)
  const produceMedian = median(produceMs)
  const consumeMedian = median(consumeMs)

  const result = [
    {
      median: durationMedian,
      metrics: {
        'process.internal_duration_ms.median': durationMedian,
        'process.internal_duration_ms.std_err': durationStdErr,
        'process.rss_bytes.median': rssMedian,
        // Diagnostic breakdown (not gated) -- localizes DSM cost by phase.
        'phase.produce_ms.median': produceMedian,
        'phase.consume_ms.median': consumeMedian
      }
    }
  ]

  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2))

  console.log(
    `Duration median: ${durationMedian.toFixed(3)} ms (± ${durationStdErr.toFixed(3)}) | ` +
    `RSS median: ${(rssMedian / 1_000_000).toFixed(2)} MB | ` +
    `produce median: ${produceMedian.toFixed(3)} ms | ` +
    `consume+commit median: ${consumeMedian.toFixed(3)} ms | ` +
    `runs: ${count} (warmup ${warmup})`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
