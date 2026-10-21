'use strict'

/* eslint-disable no-console */

// Kafka produce/consume overhead benchmark (iteration contract: see README.md).
// The tracer is NOT required here: run.sh preloads it with `node --require <repo>/init.js`.

const crypto = require('node:crypto')
const fs = require('node:fs')
const inspector = require('node:inspector')

const { Kafka, logLevel } = require('kafkajs')

const { writeTopList } = require('./profile-top')

const env = (key, fallback) => process.env[key] ?? fallback
const COMMIT_EVERY = Number(env('COMMIT_EVERY', 100))
const NUM_THREADS = Number(env('NUM_THREADS', 1))
const WARMUP = Number(env('WARMUP', 5))
const COUNT = Number(env('COUNT', 25))
const BOOTSTRAP_SERVERS = env('KAFKA_BOOTSTRAP_SERVERS', 'localhost:9092')
const BASE_TOPIC = env('KAFKA_TOPIC', 'benchmark-topic-node-default')
const OUTPUT = env('TIMEIT_OUTPUT', 'results.json')
const PROFILE = env('PROFILE', '0') === '1'
const PROFILE_OUTPUT = env('PROFILE_OUTPUT', 'profile.node.cpuprofile')
const MESSAGES = 1000
const RUN_ID = crypto.randomBytes(4).toString('hex')

if (NUM_THREADS !== 1) throw new Error('only NUM_THREADS=1 is supported')
if (!(COMMIT_EVERY >= 1)) throw new Error('COMMIT_EVERY must be >= 1')

const kafka = new Kafka({ clientId: 'dsm-bench', brokers: [BOOTSTRAP_SERVERS], logLevel: logLevel.ERROR })

// In-process CPU profiler so only the timed produce+consume window is sampled (`node --cpu-prof` can't do that).
const session = PROFILE ? new inspector.Session() : undefined
const post = (method, params) => new Promise((resolve, reject) => {
  session.post(method, params, (err, result) => err ? reject(err) : resolve(result))
})
const profiles = []

async function iteration (index, profiled) {
  const topic = `${BASE_TOPIC}-${RUN_ID}-${index}`

  // 1. setup (untimed, not profiled): fresh single-partition topic, producer, consumer joined to the group
  const admin = kafka.admin()
  await admin.connect()
  await admin.createTopics({ topics: [{ topic, numPartitions: 1, replicationFactor: 1 }], waitForLeaders: true })
  await admin.disconnect()

  const producer = kafka.producer()
  await producer.connect()
  const consumer = kafka.consumer({ groupId: `group-${RUN_ID}-${index}`, maxWaitTimeInMs: 50 })
  await consumer.connect()
  await consumer.subscribe({ topic, fromBeginning: true })

  // headers must be a plain object (the tracer's DSM hook only handles that shape)
  const headers = { h0: 'v0', h1: 'v1', h2: 'v2', h3: 'v3', h4: 'v4' }
  const value = Buffer.alloc(100, 'x')
  let received = 0
  let resolveDone
  const done = new Promise(resolve => { resolveDone = resolve })
  const joined = new Promise(resolve => consumer.on(consumer.events.GROUP_JOIN, resolve))

  await consumer.run({
    autoCommit: false,
    eachMessage: async ({ topic, partition, message }) => {
      received++
      if (received % COMMIT_EVERY === 0 || received === MESSAGES) {
        await consumer.commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + 1n).toString() }])
      }
      if (received === MESSAGES) resolveDone()
    },
  })
  await joined
  consumer.pause([{ topic }]) // hold consumption until the produce phase is done

  if (profiled) await post('Profiler.start')

  // 2. produce (timed): 1000 messages with 5 headers; send() resolves once the broker acknowledged all of them
  const start = process.hrtime.bigint()
  await producer.send({ topic, messages: Array.from({ length: MESSAGES }, () => ({ value, headers })) })
  const produced = process.hrtime.bigint()

  // 3. consume (timed): 1000 messages with a sync commit every COMMIT_EVERY and after the last one
  consumer.resume([{ topic }])
  await done
  const consumed = process.hrtime.bigint()

  if (profiled) profiles.push((await post('Profiler.stop')).profile)

  // 4. teardown (untimed, not profiled)
  await consumer.disconnect()
  await producer.disconnect()

  return {
    produce_ms: Number(produced - start) / 1e6,
    consume_ms: Number(consumed - produced) / 1e6,
  }
}

async function main () {
  if (PROFILE) {
    session.connect()
    await post('Profiler.enable')
    await post('Profiler.setSamplingInterval', { interval: 200 })
  }

  for (let i = 0; i < WARMUP; i++) await iteration(i, false)

  const runs = []
  for (let i = 0; i < COUNT; i++) {
    const run = await iteration(WARMUP + i, PROFILE)
    runs.push(run)
    console.log(`iter ${i}: produce=${run.produce_ms.toFixed(1)}ms consume=${run.consume_ms.toFixed(1)}ms`)
  }

  fs.writeFileSync(OUTPUT, JSON.stringify({
    runs,
    // ru_maxrss in KB (libuv normalizes macOS bytes to KB)
    max_rss_mb: process.resourceUsage().maxRSS / 1024,
    commit_every: COMMIT_EVERY,
    profiled: PROFILE,
  }, null, 1))

  if (PROFILE) writeTopList(profiles, PROFILE_OUTPUT)
}

main().then(() => {
  // Exit naturally so the tracer's beforeExit handlers flush traces and DSM stats; the timer is a safety net.
  setTimeout(() => process.exit(0), 30_000).unref()
}, (err) => {
  console.error(err)
  process.exit(1)
})
