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
 *   - process model -- .NET relaunches the binary per iteration under
 *     TimeItSharp and measures main-entry to main-exit; Python and this
 *     harness instead run all iterations in one process with the tracer
 *     already initialized, so tracer bootstrap/shutdown are excluded here.
 *   - kafkajs has no client-side batching (linger) and no synchronous
 *     per-message poll like confluent-kafka, so produce issues 1000 concurrent
 *     single-message `producer.send()` calls and awaits them all (the analog
 *     of "produce each message, then flush"; one produce span per message,
 *     like the other languages) and consume drives kafkajs's `eachMessage`
 *     callback with `autoCommit: false`, manually awaiting
 *     `consumer.commitOffsets()` after every COMMIT_EVERY-th message and after
 *     the last one (see below).
 *
 * `runWorker`'s returned `produceMs`/`consumeMs` are the only timed region:
 * topic creation, producer/consumer connect, producer metadata pre-fetch and
 * the consumer-group join are setup and run before either phase starts.
 * kafkajs has no public metadata-fetch API on the producer, so the pre-fetch
 * is an empty `producer.send()`, which loads the topic's metadata and sends
 * no produce request. `consumer.run()` awaits kafkajs's
 * internal `joinAndSync()` before scheduling the fetch loop, so calling it
 * here -- while the topic is still empty -- joins the group and receives the
 * partition assignment without consuming anything, the same way Java's
 * `joinGroup()` polls an empty topic before producing. The fetch loop then
 * runs in the background (like librdkafka's prefetch), so `eachMessage`
 * waits for the consume phase to start: no message is processed or committed
 * while producing. Consumer/producer disconnect also stay untimed.
 *
 * The workload (canonical cross-language spec, Linear DSM2-590):
 *   - `NUM_THREADS` (default 1) workers, each with its own fresh
 *     single-partition topic and fresh consumer group per iteration.
 *     Single-worker by default: Node's single event loop means extra
 *     workers would conflate instrumentation cost with event-loop/IPC
 *     contention rather than measure it. Set NUM_THREADS > 1 only for a
 *     deliberate contention diagnostic.
 *   - Each worker produces MESSAGE_COUNT (1000) messages -- fixed 1024-byte
 *     payload, no key, 5 headers key0..key4 -> value0..value4 -- to its own
 *     topic, then consumes all 1000 messages back,
 *     synchronously committing (last consumed offset + 1) after every
 *     COMMIT_EVERY (default 100) consumed messages and always after the last
 *     one -- 10 commits per run at the default. COMMIT_EVERY=1 is the
 *     per-message sync commit, kept as an on-demand diagnostic. Commits stay
 *     inside the timed consume phase in every scenario.
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
const PAYLOAD = 'x'.repeat(1024)
const COMMIT_EVERY = parsePositiveInteger('COMMIT_EVERY', process.env.COMMIT_EVERY, 100)
// NUM_WORKERS is the legacy name of NUM_THREADS, still honored when NUM_THREADS is unset.
const NUM_THREADS = parsePositiveInteger(
  process.env.NUM_THREADS === undefined ? 'NUM_WORKERS' : 'NUM_THREADS',
  process.env.NUM_THREADS ?? process.env.NUM_WORKERS,
  1
)
// Unique per process so reruns with the same KAFKA_TOPIC never reuse a topic or consumer group.
const PROCESS_NONCE = `${Date.now().toString(36)}-${process.pid}`

/**
 * @param {string} name env var name, used in the error message
 * @param {string | undefined} raw env value; unset means `defaultValue`. An empty string is rejected,
 * like in the Java/Python/Ruby harnesses.
 * @param {number} defaultValue
 */
function parsePositiveInteger (name, raw, defaultValue) {
  if (raw === undefined) return defaultValue
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be an integer >= 1, got ${JSON.stringify(raw)}`)
  }
  return value
}

/**
 * One headers object per message (built untimed), so in-place header injection never leaks across messages.
 */
function buildMessages () {
  const messages = []
  for (let i = 0; i < MESSAGE_COUNT; i++) {
    const headers = {}
    for (let j = 0; j < NUM_HEADERS; j++) {
      headers[`key${j}`] = `value${j}`
    }
    messages.push({ value: PAYLOAD, headers })
  }
  return messages
}

async function createTopics (kafka, topics) {
  const admin = kafka.admin()
  await admin.connect()
  try {
    const created = await admin.createTopics({
      topics: topics.map(topic => ({ topic, numPartitions: 1, replicationFactor: 1 })),
      waitForLeaders: true
    })
    if (!created) throw new Error(`Topics already exist: ${topics.join(', ')}`)
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
  // Setup: pre-fetch the topic metadata on the producer; zero messages means no produce request.
  await producer.send({ topic, messages: [], acks: -1 })

  let consumed = 0
  let consumeStart
  let consumeMs = 0
  let resolveConsumed
  let rejectConsumed
  const consumedPromise = new Promise((resolve, reject) => {
    resolveConsumed = resolve
    rejectConsumed = reject
  })
  // kafkajs fetches in the background once assigned; hold message processing until the consume phase starts.
  let startConsumePhase
  const consumePhase = new Promise(resolve => { startConsumePhase = resolve })

  try {
    // Setup: join the consumer group and receive the partition assignment
    // before anything is produced -- the topic is still empty, so this polls
    // no records, matching Java's joinGroup(). Not timed.
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic: msgTopic, partition, message }) => {
        try {
          if (consumeStart === undefined) await consumePhase
          const position = consumed + 1
          if (position % COMMIT_EVERY === 0 || position >= MESSAGE_COUNT) {
            await consumer.commitOffsets([
              { topic: msgTopic, partition, offset: (Number(message.offset) + 1).toString() }
            ])
          }
          consumed = position
          if (consumed >= MESSAGE_COUNT) {
            consumeMs = Number(process.hrtime.bigint() - consumeStart) / 1e6
            resolveConsumed()
          }
        } catch (err) {
          rejectConsumed(err)
        }
      }
    })

    // Phase 1 (timed): one send() per message, then await all as the flush.
    const messages = buildMessages()
    const sends = new Array(MESSAGE_COUNT)
    const produceStart = process.hrtime.bigint()
    for (let i = 0; i < MESSAGE_COUNT; i++) {
      sends[i] = producer.send({ topic, messages: [messages[i]], acks: -1 })
    }
    await Promise.all(sends)
    const produceMs = Number(process.hrtime.bigint() - produceStart) / 1e6

    // Phase 2 (timed): consume all messages, synchronously committing every
    // COMMIT_EVERY messages and after the last (COMMIT_EVERY=1 is the
    // per-message commit). The group is already joined, so this measures
    // fetch + commits only.
    let timeoutHandle
    consumeStart = process.hrtime.bigint()
    startConsumePhase()
    const timeout = new Promise((resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(
          `Failed to consume ${MESSAGE_COUNT} messages on topic ${topic} within timeout (got ${consumed})`
        ))
      }, 30000)
    })
    try {
      await Promise.race([consumedPromise, timeout])
    } finally {
      clearTimeout(timeoutHandle)
    }

    if (consumed !== MESSAGE_COUNT) {
      throw new Error(`Consumed ${consumed}/${MESSAGE_COUNT} messages on topic ${topic}`)
    }

    return { produceMs, consumeMs }
  } finally {
    // Release a gated eachMessage if produce failed, so disconnect does not wait on it forever.
    startConsumePhase()
    await consumer.disconnect()
    await producer.disconnect()
  }
}

/**
 * Run one full multi-worker produce/consume pass.
 *
 * `runId` (plus a per-process nonce) makes topic and consumer-group names
 * unique per iteration so warmup + timed runs, and reruns, never re-read
 * messages committed by previous iterations.
 */
async function runBenchmark (runId = 0) {
  const baseTopic = process.env.KAFKA_TOPIC || 'benchmark-topic'

  const kafka = new Kafka({
    clientId: 'dsm-kafka-throughput-benchmark',
    brokers: [BOOTSTRAP_SERVERS],
    logLevel: 1 // ERROR only -- keep workload output legible.
  })

  const topics = []
  for (let t = 0; t < NUM_THREADS; t++) {
    topics.push(`${baseTopic}-${PROCESS_NONCE}-${runId}-${t}`)
  }
  await createTopics(kafka, topics)

  const results = await Promise.all(
    topics.map((topic, t) => runWorker(kafka, topic, `${CONSUMER_GROUP_ID}-${PROCESS_NONCE}-${runId}-${t}`))
  )

  // Mean per-worker phase durations (workers run concurrently, so this
  // approximates per-phase wall-clock and lets us localize where DSM cost
  // lands -- produce vs synchronous consume+commit).
  const n = results.length || 1
  const meanProduceMs = results.reduce((sum, r) => sum + r.produceMs, 0) / n
  const meanConsumeMs = results.reduce((sum, r) => sum + r.consumeMs, 0) / n
  return { produceMs: meanProduceMs, consumeMs: meanConsumeMs }
}

module.exports = { runBenchmark, COMMIT_EVERY, NUM_THREADS }

if (require.main === module) {
  runBenchmark().then((phases) => {
    console.log(phases)
    console.log('Benchmark completed successfully')
  }).catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
