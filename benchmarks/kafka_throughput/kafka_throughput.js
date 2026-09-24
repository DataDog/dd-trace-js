'use strict'

/**
 * Kafka produce/consume throughput workload for DSM overhead benchmarking.
 *
 * Node.js port of the Python `kafka_throughput.py` workload used by the
 * `python/data-streams-monitoring` benchmarking-platform branch, which itself
 * ports the .NET `Samples.KafkaBenchmark`. The message-level work mirrors
 * those two so the three languages' DSM overhead numbers are broadly
 * comparable. Deliberate divergences, which must be stated whenever the
 * numbers are compared across languages:
 *
 *   - worker count (1 here vs 1 in Python vs 5 in .NET, see below);
 *   - process model -- .NET relaunches the binary per iteration under
 *     TimeItSharp and measures main-entry to main-exit; Python and this
 *     harness instead run all iterations in one process with the tracer
 *     already initialized, so tracer bootstrap/shutdown are excluded here.
 *   - kafkajs has no synchronous per-message poll like confluent-kafka, so
 *     produce is a single batched `producer.send()` call (the analog of
 *     "produce all, then flush") and consume drives kafkajs's `eachMessage`
 *     callback with `autoCommit: false`, manually committing offsets after
 *     each message to mirror the synchronous per-message commit in Python.
 *
 * The workload:
 *   - `NUM_WORKERS` (default 1) workers, each with its own topic/consumer
 *     group. Single-worker by default: Node's single event loop means extra
 *     workers would conflate instrumentation cost with event-loop/IPC
 *     contention rather than measure it. Set NUM_WORKERS > 1 only for a
 *     deliberate contention diagnostic. Note the .NET counterpart uses 5
 *     threads, so cross-language comparisons must state the worker count.
 *   - Each worker produces MESSAGE_COUNT (1000) messages, each carrying 5
 *     headers, to its own topic, then synchronously consumes and commits all
 *     1000 messages back.
 *
 * Tracing/DSM are controlled purely by environment (`-r dd-trace/init` +
 * DD_DATA_STREAMS_ENABLED); this module contains no tracer-specific code, so
 * the DSM-on and DSM-off experiments run the exact same bytes.
 */

const { Kafka } = require('kafkajs')

const BOOTSTRAP_SERVERS = process.env.KAFKA_BOOTSTRAP_SERVERS || 'localhost:9092'
const CONSUMER_GROUP_ID = 'benchmark-consumer-group'
const MESSAGE_COUNT = 1000
const NUM_HEADERS = 5

function buildHeaders () {
  const headers = {}
  for (let j = 0; j < NUM_HEADERS; j++) {
    headers[`key${j}`] = `value${j}`
  }
  return headers
}

async function createTopics (kafka, topics) {
  const admin = kafka.admin()
  await admin.connect()
  try {
    await admin.createTopics({
      topics: topics.map(topic => ({ topic, numPartitions: 1, replicationFactor: 1 })),
      waitForLeaders: true
    })
  } finally {
    await admin.disconnect()
  }
}

async function runWorker (kafka, topic, groupId) {
  const producer = kafka.producer({ allowAutoTopicCreation: false })
  const consumer = kafka.consumer({ groupId, sessionTimeout: 30000, heartbeatInterval: 3000 })

  await producer.connect()
  await consumer.connect()
  await consumer.subscribe({ topic, fromBeginning: true })

  try {
    // Phase 1: produce all messages, then a single flush-equivalent send.
    const headers = buildHeaders()
    const messages = []
    for (let i = 0; i < MESSAGE_COUNT; i++) {
      messages.push({
        key: String(process.hrtime.bigint()),
        value: String(i),
        headers
      })
    }
    const produceStart = process.hrtime.bigint()
    await producer.send({ topic, messages, acks: -1 })
    const produceMs = Number(process.hrtime.bigint() - produceStart) / 1e6

    // Phase 2: consume and commit all messages synchronously (one at a time,
    // matching the Python/`.NET` per-message commit).
    let consumed = 0
    let consumeStart
    let consumeMs = 0

    await new Promise((resolve, reject) => {
      consumeStart = process.hrtime.bigint()
      consumer.run({
        autoCommit: false,
        eachMessage: async ({ topic: msgTopic, partition, message }) => {
          try {
            await consumer.commitOffsets([
              { topic: msgTopic, partition, offset: (Number(message.offset) + 1).toString() }
            ])
            consumed++
            if (consumed >= MESSAGE_COUNT) {
              consumeMs = Number(process.hrtime.bigint() - consumeStart) / 1e6
              resolve()
            }
          } catch (err) {
            reject(err)
          }
        }
      }).catch(reject)

      setTimeout(() => {
        reject(new Error(`Failed to consume ${MESSAGE_COUNT} messages on topic ${topic} within timeout (got ${consumed})`))
      }, 30000)
    })

    if (consumed !== MESSAGE_COUNT) {
      throw new Error(`Consumed ${consumed}/${MESSAGE_COUNT} messages on topic ${topic}`)
    }

    return { produceMs, consumeMs }
  } finally {
    await consumer.disconnect()
    await producer.disconnect()
  }
}

/**
 * Run one full multi-worker produce/consume pass.
 *
 * `runId` makes topic and consumer-group names unique per invocation so
 * repeated in-process iterations (warmup + timed runs) stay isolated instead
 * of re-reading messages committed by previous iterations.
 */
async function runBenchmark (runId = 0) {
  const baseTopic = process.env.KAFKA_TOPIC || 'benchmark-topic'
  const workerCount = parseInt(process.env.NUM_WORKERS || '1', 10)

  const kafka = new Kafka({
    clientId: 'dsm-kafka-throughput-benchmark',
    brokers: [BOOTSTRAP_SERVERS],
    logLevel: 1 // ERROR only -- keep workload output legible.
  })

  const topics = []
  for (let t = 0; t < workerCount; t++) {
    topics.push(`${baseTopic}-${runId}-${t}`)
  }
  await createTopics(kafka, topics)

  const results = await Promise.all(
    topics.map((topic, t) => runWorker(kafka, topic, `${CONSUMER_GROUP_ID}-${runId}-${t}`))
  )

  // Mean per-worker phase durations (workers run concurrently, so this
  // approximates per-phase wall-clock and lets us localize where DSM cost
  // lands -- produce vs synchronous consume+commit).
  const n = results.length || 1
  const meanProduceMs = results.reduce((sum, r) => sum + r.produceMs, 0) / n
  const meanConsumeMs = results.reduce((sum, r) => sum + r.consumeMs, 0) / n
  return { produceMs: meanProduceMs, consumeMs: meanConsumeMs }
}

module.exports = { runBenchmark }

if (require.main === module) {
  runBenchmark().then((phases) => {
    console.log(phases)
    console.log('Benchmark completed successfully')
  }).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
