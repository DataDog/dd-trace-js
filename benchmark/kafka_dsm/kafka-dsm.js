'use strict'

// Kafka produce/consume workload of the DSM overhead benchmark. No tracer-specific code; spec and timing: README.md.

const { Kafka } = require('kafkajs')

const BOOTSTRAP_SERVERS = process.env.KAFKA_BOOTSTRAP_SERVERS || 'localhost:9092'
const CONSUMER_GROUP_ID = 'benchmark-consumer-group'
const MESSAGE_COUNT = 1000
const NUM_HEADERS = 5
const PAYLOAD = 'x'.repeat(1024)
const COMMIT_EVERY = parseIntegerEnv('COMMIT_EVERY', 100, 1)
// NUM_WORKERS is the legacy name of NUM_THREADS, still honored when NUM_THREADS is unset.
const NUM_THREADS = parseIntegerEnv(process.env.NUM_THREADS === undefined ? 'NUM_WORKERS' : 'NUM_THREADS', 1, 1)
// Unique per process so reruns with the same KAFKA_TOPIC never reuse a topic or consumer group.
const PROCESS_NONCE = `${Date.now().toString(36)}-${process.pid}`

/**
 * Unset means `defaultValue`; an empty or non-decimal value is rejected, like in the other languages' harnesses.
 *
 * @param {string} name env var name
 * @param {number} defaultValue
 * @param {number} min smallest accepted value
 */
function parseIntegerEnv (name, defaultValue, min) {
  const raw = process.env[name]
  if (raw === undefined) return defaultValue
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}, got ${JSON.stringify(raw)}`)
  }
  return value
}

// One headers object per message (built untimed), so in-place header injection never leaks across messages.
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
      waitForLeaders: true,
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
    // Untimed setup: an empty send() loads the topic metadata without a produce request.
    await producer.send({ topic, messages: [], acks: -1 })

    // Untimed setup: run() joins the group and gets the assignment while the topic is still empty.
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic: msgTopic, partition, message }) => {
        try {
          if (consumeStart === undefined) await consumePhase
          const position = consumed + 1
          if (position % COMMIT_EVERY === 0 || position >= MESSAGE_COUNT) {
            await consumer.commitOffsets([
              { topic: msgTopic, partition, offset: (Number(message.offset) + 1).toString() },
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
      },
    })

    // Timed produce: one send() per message (kafkajs has no client-side batching), then await all as the flush.
    const messages = buildMessages()
    const sends = new Array(MESSAGE_COUNT)
    const produceStart = process.hrtime.bigint()
    for (let i = 0; i < MESSAGE_COUNT; i++) {
      sends[i] = producer.send({ topic, messages: [messages[i]], acks: -1 })
    }
    await Promise.all(sends)
    const produceMs = Number(process.hrtime.bigint() - produceStart) / 1e6

    // Timed consume: all messages, sync commit every COMMIT_EVERY messages and after the last.
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
    // Release an eachMessage waiting on consumePhase if produce failed, so disconnect does not wait on it forever.
    startConsumePhase()
    await consumer.disconnect()
    await producer.disconnect()
  }
}

/**
 * One produce/consume pass on fresh topics and consumer groups (unique per process and iteration).
 *
 * @param {number} runId iteration number, part of the topic and consumer-group names
 */
async function runBenchmark (runId) {
  const baseTopic = process.env.KAFKA_TOPIC || 'benchmark-topic'

  const kafka = new Kafka({
    clientId: 'dsm-kafka-benchmark',
    brokers: [BOOTSTRAP_SERVERS],
    logLevel: 1, // ERROR only -- keep workload output legible.
  })

  const topics = []
  for (let t = 0; t < NUM_THREADS; t++) {
    topics.push(`${baseTopic}-${PROCESS_NONCE}-${runId}-${t}`)
  }
  await createTopics(kafka, topics)

  const results = await Promise.all(
    topics.map((topic, t) => runWorker(kafka, topic, `${CONSUMER_GROUP_ID}-${PROCESS_NONCE}-${runId}-${t}`))
  )

  // Mean per-worker phase durations (workers run concurrently).
  const n = results.length
  const meanProduceMs = results.reduce((sum, r) => sum + r.produceMs, 0) / n
  const meanConsumeMs = results.reduce((sum, r) => sum + r.consumeMs, 0) / n
  return { produceMs: meanProduceMs, consumeMs: meanConsumeMs }
}

module.exports = { runBenchmark, parseIntegerEnv, COMMIT_EVERY, NUM_THREADS }
