'use strict'

const assert = require('node:assert/strict')
const { EventEmitter, once } = require('node:events')
const http = require('node:http')
const { URL } = require('node:url')
const zlib = require('node:zlib')

const { after, before, describe, it } = require('mocha')
const sinon = require('sinon')

const { NODE_MAJOR, NODE_MINOR } = require('../../../../../version')
require('../../setup/core')

const agent = require('../../plugins/agent')
const AgentlessExporter = require('../../../src/exporters/agentless')
const DirectTransport = require('../../../src/exporters/agentless/direct-transport')
const sendRequest = require('../../../src/exporters/common/request')
const id = require('../../../src/id')
const AgentlessWriter = require('../../../src/exporters/agentless/writer')
const { errorChannel, errorRecordChannel } = require('../../../src/log/channels')

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const zstdSupported = NODE_MAJOR >= 24 ||
  (NODE_MAJOR === 23 && NODE_MINOR >= 8) ||
  (NODE_MAJOR === 22 && NODE_MINOR >= 15)
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const zstdDecompressSync = zstdSupported ? zlib.zstdDecompressSync : undefined

async function listen (respond) {
  const receiver = http.createServer(respond)
  receiver.listen(0, '127.0.0.1')
  await once(receiver, 'listening')
  return receiver
}

/** @param {string} traceId */
function webSpan (traceId) {
  return {
    duration: 1,
    error: 0,
    meta: {},
    metrics: {},
    name: 'http.request',
    parent_id: id('0'),
    resource: 'GET /test',
    service: 'test-delivery',
    span_id: id('1'),
    start: 1,
    trace_id: id(traceId),
    type: 'web',
  }
}

/**
 * @param {AgentlessWriter} writer
 * @param {string} traceId
 */
function queueDirectTrace (writer, traceId) {
  return writer.append([webSpan(traceId)])
}

function directWriter (receiver) {
  return new AgentlessWriter({
    url: new URL(`http://127.0.0.1:${receiver.address().port}`),
    metadata: { hostname: 'test-host', runtimeID: 'test-runtime-id' },
    generatedObfuscation: true,
  })
}

function observeBackoff () {
  const sandbox = sinon.createSandbox()
  const clock = sandbox.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const setTimeout = globalThis.setTimeout
  let scheduled
  sandbox.stub(globalThis, 'setTimeout').callsFake((callback, delay, ...args) => {
    const timer = setTimeout(callback, delay, ...args)
    if (delay === 1000 || delay === 2000) {
      scheduled?.(delay)
    }
    return timer
  })
  return {
    clock,
    next: () => new Promise(resolve => { scheduled = resolve }),
    restore () {
      sandbox.restore()
    },
  }
}

describe('AgentlessWriter data pipeline', () => {
  let server
  let intakeUrl
  let resolveRequest
  let request

  before(done => {
    process.env.DD_API_KEY = 'test-api-key'
    server = http.createServer((incoming, response) => {
      const chunks = []
      incoming.on('data', chunk => chunks.push(chunk))
      incoming.on('end', () => {
        resolveRequest({
          headers: incoming.headers,
          path: incoming.url,
          payload: Buffer.concat(chunks),
        })
        response.end()
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      intakeUrl = new URL(`http://127.0.0.1:${port}`)
      done()
    })
  })

  after(async () => {
    delete process.env.DD_API_KEY
    await agent.close()
    await new Promise(resolve => server.close(resolve))
  })

  for (const statuses of [[503, 200], [503, 429, 503]]) {
    const name = statuses.length === 2
      ? 'retries an eligible batch after an HTTP failure'
      : 'limits an eligible batch to two retries'
    it(name, async () => {
      const attempts = []
      const receiver = await listen(async (incoming, response) => {
        const chunks = []
        for await (const chunk of incoming) chunks.push(chunk)
        attempts.push({ apiKey: incoming.headers['dd-api-key'], body: Buffer.concat(chunks) })
        response.statusCode = statuses[attempts.length - 1] ?? 500
        response.end(response.statusCode >= 400 ? 'synthetic-private-response-marker' : undefined)
      })
      const writer = directWriter(receiver)
      const backoff = observeBackoff()
      const errorLog = sinon.spy()
      const errorRecord = sinon.spy()
      errorChannel.subscribe(errorLog)
      errorRecordChannel.subscribe(errorRecord)

      try {
        let scheduled = backoff.next()
        assert.strictEqual(queueDirectTrace(writer, '6'), true)
        const flushed = new Promise(resolve => writer.flush(resolve))
        for (const expected of [1000, 2000].slice(0, statuses.length - 1)) {
          assert.strictEqual(await Promise.race([scheduled, flushed]), expected)
          scheduled = backoff.next()
          await backoff.clock.tickAsync(expected)
        }
        await flushed
        assert.strictEqual(attempts.length, statuses.length)
        assert.strictEqual(attempts[0].apiKey, 'test-api-key')
        for (const attempt of attempts.slice(1)) assert.deepStrictEqual(attempt, attempts[0])
        assert.strictEqual(backoff.clock.countTimers(), 0)
        const records = errorRecord.args.map(([record]) => record)
          .filter(record => record.formatted?.startsWith('Failed to send 1 trace(s) to the agentless intake:'))
        assert.strictEqual(records.length, statuses.at(-1) >= 400 ? 1 : 0)
        for (const [entry] of errorLog.args) assert.doesNotMatch(String(entry), /synthetic-private-response-marker/)
        for (const record of records) {
          assert.doesNotMatch(record.formatted, /synthetic-private-response-marker/)
          assert.strictEqual(record.sendViaTelemetry, false)
          assert.match(record.formatted, /\b503\b/)
        }
      } finally {
        errorRecordChannel.unsubscribe(errorRecord)
        errorChannel.unsubscribe(errorLog)
        writer.setUrl(intakeUrl)
        backoff.restore()
        await new Promise(resolve => receiver.close(resolve))
      }
    })
  }

  it('drops an eligible batch quietly when the request buffer is near capacity', async () => {
    let deliveries = 0
    const receiver = await listen((incoming, response) => {
      incoming.resume()
      incoming.once('end', () => {
        deliveries++
        response.end()
      })
    })
    const writer = directWriter(receiver)
    const chunk = Buffer.alloc(1024 * 1024)
    const nearCapacity = Array(63).fill(chunk)
    nearCapacity.push(chunk.subarray(1))
    const parkedRequest = Object.assign(new EventEmitter(), {
      setTimeout: sinon.stub(),
      write: sinon.stub(),
      end: sinon.stub(),
    })
    const reserve = sinon.stub(http, 'request').returns(parkedRequest)
    try {
      sendRequest(nearCapacity, { url: intakeUrl, method: 'POST' }, assert.fail)
    } finally {
      reserve.restore()
    }
    const attempts = sinon.spy(http, 'request')
    const errorRecord = sinon.spy()
    const dropped = sinon.spy()
    const backoff = observeBackoff()
    errorRecordChannel.subscribe(errorRecord)

    try {
      assert.strictEqual(queueDirectTrace(writer, '6'), true)
      await new Promise(resolve => writer.flush(() => {
        dropped()
        resolve()
      }))
      assert.strictEqual(errorRecord.callCount, 0)
      assert.strictEqual(attempts.callCount, 0)
      assert.strictEqual(backoff.clock.countTimers(), 0)

      parkedRequest.emit('close')
      assert.strictEqual(queueDirectTrace(writer, '7'), true)
      await new Promise(resolve => writer.flush(resolve))
      assert.strictEqual(dropped.callCount, 1)
      assert.strictEqual(attempts.callCount, 1)
      assert.strictEqual(deliveries, 1)
    } finally {
      parkedRequest.emit('close')
      attempts.restore()
      errorRecordChannel.unsubscribe(errorRecord)
      writer.setUrl(intakeUrl)
      backoff.restore()
      await new Promise(resolve => receiver.close(resolve))
    }
  })

  it('cancels a scheduled retry on URL cutover', async () => {
    let oldAttempts = 0
    const receiver = await listen((incoming, response) => {
      incoming.resume()
      incoming.once('end', () => {
        oldAttempts++
        response.statusCode = 503
        response.end()
      })
    })
    const writer = directWriter(receiver)
    const backoff = observeBackoff()

    try {
      const scheduled = backoff.next()
      assert.strictEqual(queueDirectTrace(writer, '6'), true)
      const flushed = new Promise(resolve => writer.flush(resolve))
      assert.strictEqual(await Promise.race([scheduled, flushed]), 1000)
      writer.setUrl(intakeUrl)
      await flushed
      assert.strictEqual(backoff.clock.countTimers(), 0)
      assert.strictEqual(oldAttempts, 1)
    } finally {
      writer.setUrl(intakeUrl)
      backoff.restore()
      await new Promise(resolve => receiver.close(resolve))
    }
  })

  it('bounds outstanding batches across writers during retry backoff', async () => {
    let deliveries = 0
    const receiver = await listen((incoming, response) => {
      incoming.resume()
      incoming.once('end', () => {
        deliveries++
        response.statusCode = 503
        response.end()
      })
    })
    const writer = directWriter(receiver)
    const otherWriter = directWriter(receiver)
    const backoff = observeBackoff()
    const flushes = []

    try {
      for (let index = 1; index <= 64; index++) {
        const scheduled = backoff.next()
        assert.strictEqual(queueDirectTrace(writer, String(index)), true)
        const flushed = new Promise(resolve => writer.flush(resolve))
        flushes.push(flushed)
        assert.strictEqual(await Promise.race([scheduled, flushed]), 1000)
      }

      let scheduled = backoff.next()
      assert.strictEqual(queueDirectTrace(otherWriter, '65'), true)
      const overflowDone = sinon.spy()
      const overflow = new Promise(resolve => otherWriter.flush(() => {
        overflowDone()
        resolve()
        throw new Error('completion failed')
      }))
      flushes.push(overflow)
      assert.strictEqual(await Promise.race([scheduled, overflow]), undefined)
      sinon.assert.calledOnce(overflowDone)
      assert.strictEqual(deliveries, 64)

      writer.setUrl(intakeUrl)
      await Promise.all(flushes)
      assert.strictEqual(backoff.clock.countTimers(), 0)

      scheduled = backoff.next()
      assert.strictEqual(queueDirectTrace(otherWriter, '66'), true)
      const admitted = new Promise(resolve => otherWriter.flush(resolve))
      assert.strictEqual(await Promise.race([scheduled, admitted]), 1000)
      assert.strictEqual(deliveries, 65)
      otherWriter.setUrl(intakeUrl)
      await admitted
    } finally {
      writer.setUrl(intakeUrl)
      otherWriter.setUrl(intakeUrl)
      backoff.restore()
      await new Promise(resolve => receiver.close(resolve))
    }
  })

  it('bounds outstanding payload bytes during retry backoff', async () => {
    const lengths = []
    const receiver = await listen((incoming, response) => {
      incoming.resume()
      incoming.once('end', () => {
        lengths.push(Number(incoming.headers['content-length']))
        response.statusCode = lengths.length === 1 ? 503 : 200
        response.end()
      })
    })
    const transport = new DirectTransport()
    const backoff = observeBackoff()
    const bytes = Buffer.alloc(16 * 1024 * 1024 + 1)
    const options = { url: new URL(`http://127.0.0.1:${receiver.address().port}`), method: 'POST' }

    try {
      const scheduled = backoff.next()
      const oversized = new Promise(resolve => transport.send(bytes, options, resolve))
      assert.strictEqual(await Promise.race([scheduled, oversized]), null)

      const full = new Promise(resolve => transport.send(bytes.subarray(1), options, resolve))
      assert.strictEqual(await Promise.race([scheduled, full]), 1000)
      assert.deepStrictEqual(lengths, [bytes.length - 1])

      await new Promise(resolve => transport.send(bytes.subarray(0, 1), options, resolve))
      assert.deepStrictEqual(lengths, [bytes.length - 1])

      transport.close()
      assert.strictEqual(await full, null)
      assert.strictEqual(backoff.clock.countTimers(), 0)
      const admitted = await new Promise(resolve => transport.send(bytes.subarray(0, 1), options, resolve))
      assert.strictEqual(admitted, null)
      assert.deepStrictEqual(lengths, [bytes.length - 1, 1])
    } finally {
      transport.close()
      backoff.restore()
      await new Promise(resolve => receiver.close(resolve))
    }
  })

  for (const failure of ['http error', 'socket close']) {
    it(`completes a flush after both intake retries fail (${failure})`, async () => {
      let attempts = 0
      const receiver = await listen((incoming, response) => {
        incoming.resume()
        incoming.once('end', () => {
          attempts++
          if (failure === 'socket close') {
            incoming.socket.destroy()
          } else {
            response.statusCode = 503
            response.end()
          }
        })
      })
      const writer = directWriter(receiver)
      const backoff = observeBackoff()

      try {
        const firstRetry = backoff.next()
        assert.strictEqual(queueDirectTrace(writer, '8'), true)
        const flushed = new Promise(resolve => writer.flush(resolve))
        assert.strictEqual(await Promise.race([firstRetry, flushed]), 1000)

        const secondRetry = backoff.next()
        await backoff.clock.tickAsync(1000)
        assert.strictEqual(await Promise.race([secondRetry, flushed]), 2000)
        await backoff.clock.tickAsync(2000)

        await flushed
        assert.strictEqual(attempts, 3)
        assert.strictEqual(backoff.clock.countTimers(), 0)
      } finally {
        writer.setUrl(intakeUrl)
        backoff.restore()
        await new Promise(resolve => receiver.close(resolve))
      }
    })
  }

  it('cancels an eligible request before sending to a new intake URL', async () => {
    let oldResponse
    let begin
    let oldAttempts = 0
    const receivedOld = new Promise(resolve => { begin = resolve })
    const old = await listen((incoming, response) => {
      incoming.resume()
      incoming.once('end', () => {
        oldAttempts++
        oldResponse = response
        begin()
      })
    })
    const writer = directWriter(old)

    try {
      assert.strictEqual(queueDirectTrace(writer, '7'), true)
      let completed = 0
      const flush = new Promise(resolve => {
        writer.flush(() => {
          completed++
          resolve()
        })
      })
      await receivedOld
      writer.setUrl(intakeUrl)
      await new Promise(resolve => setImmediate(resolve))
      assert.strictEqual(completed, 1)
      await flush

      const receivedNew = new Promise(resolve => { resolveRequest = resolve })
      assert.strictEqual(queueDirectTrace(writer, '8'), true)
      await new Promise(resolve => writer.flush(resolve))
      const received = await receivedNew
      assert.strictEqual(received.headers['dd-api-key'], 'test-api-key')
      assert.strictEqual(oldAttempts, 1)
      assert.strictEqual(completed, 1)
    } finally {
      oldResponse?.end()
      await new Promise(resolve => old.close(resolve))
    }
  })

  it('delivers an overlapping flush while the first connection is still open', async () => {
    let firstResponse
    let begin
    let attempts = 0
    const started = new Promise(resolve => { begin = resolve })
    const receiver = await listen((incoming, response) => {
      incoming.resume()
      incoming.once('end', () => {
        attempts++
        if (attempts === 1) {
          firstResponse = response
          begin()
        } else {
          response.end()
        }
      })
    })
    const writer = directWriter(receiver)
    const requests = sinon.spy(http, 'request')

    try {
      assert.strictEqual(queueDirectTrace(writer, '9'), true)
      const first = new Promise(resolve => writer.flush(resolve))
      await started

      assert.strictEqual(queueDirectTrace(writer, 'a'), true)
      const second = new Promise(resolve => writer.flush(resolve))
      await new Promise(resolve => setImmediate(resolve))
      const socket = requests.secondCall.returnValue.socket
      assert.ok(socket)
      assert.notStrictEqual(socket, requests.firstCall.returnValue.socket)
      await second
      assert.strictEqual(attempts, 2)
      assert.strictEqual(firstResponse.writableEnded, false)

      firstResponse.end()
      await first
    } finally {
      requests.restore()
      writer.setUrl(intakeUrl)
      await new Promise(resolve => receiver.close(resolve))
    }
  })

  it('encodes v0.4 and exports agentless JSON through the pipeline', async () => {
    request = new Promise(resolve => { resolveRequest = resolve })
    const writer = new AgentlessWriter({
      url: intakeUrl,
      metadata: {
        env: 'test-env',
        hostname: 'test-host',
        runtimeID: 'test-runtime-id',
      },
    })

    writer.append([{
      duration: 1,
      error: 0,
      meta: {},
      metrics: {},
      name: 'operation',
      parent_id: id('0'),
      resource: 'resource',
      service: 'service',
      span_id: id('2'),
      start: 1,
      trace_id: id('1'),
    }])

    await new Promise(resolve => writer.flush(resolve))
    const received = await request

    assert.strictEqual(received.path, '/api/v2/spans')
    assert.strictEqual(received.headers['dd-api-key'], 'test-api-key')
    assert.strictEqual(received.headers['content-type'], 'application/json')
    assert.strictEqual(received.headers['content-encoding'], 'zstd')
    assert.deepStrictEqual(received.payload.subarray(0, ZSTD_MAGIC.length), ZSTD_MAGIC)

    if (zstdDecompressSync) {
      const payload = JSON.parse(zstdDecompressSync(received.payload).toString())
      const trace = payload.traces[0]
      const span = trace.spans[0]

      assert.strictEqual(trace.runtimeID, 'test-runtime-id')
      assert.strictEqual(span.name, 'operation')
      assert.strictEqual(span.resource, 'resource')
      assert.strictEqual(span.service, 'service')
      assert.ok(span.meta, JSON.stringify(span))
      assert.strictEqual(span.meta['_dd.compute_stats'], '1')
      assert.strictEqual(span.metrics._trace_root, 1)
    }
  })

  it('preserves container metadata on the prepared request', async function () {
    if (!zstdDecompressSync) this.skip()

    const container = 'a'.repeat(64)
    const received = new Promise(resolve => { resolveRequest = resolve })
    const writer = new AgentlessWriter({
      url: intakeUrl,
      metadata: { hostname: 'test-host', runtimeID: 'test-runtime-id', containerId: container },
      generatedObfuscation: true,
    })

    try {
      const span = webSpan('1')
      span.meta['custom.number'] = '4111111111111111'
      assert.strictEqual(writer.append([span]), true)
      const flushed = new Promise(resolve => writer.flush(resolve))
      const [, { headers, path, payload }] = await Promise.all([flushed, received])
      assert.strictEqual(headers['datadog-meta-lang-interpreter'], process.versions.bun ? 'JavaScriptCore' : 'v8')
      assert.strictEqual(path, '/api/v2/spans')
      assert.strictEqual(headers['dd-api-key'], 'test-api-key')
      assert.strictEqual(headers['datadog-container-id'], container)
      assert.strictEqual(JSON.parse(zstdDecompressSync(payload)).traces[0].spans[0].meta['custom.number'], '?')
    } finally {
      writer.setUrl(intakeUrl)
    }
  })

  it('preserves the pinned exporter headers on a generated batch', async () => {
    const metadata = { hostname: 'test-host', runtimeID: 'test-runtime-id' }
    const names = [
      'x-datadog-trace-count',
      'datadog-meta-lang',
      'datadog-meta-lang-version',
      'datadog-meta-lang-interpreter',
      'datadog-meta-tracer-version',
      'user-agent',
    ]
    const observed = []
    for (const generatedObfuscation of [false, true]) {
      const writer = new AgentlessWriter({ url: intakeUrl, metadata, generatedObfuscation })
      const received = new Promise(resolve => { resolveRequest = resolve })
      try {
        assert.strictEqual(queueDirectTrace(writer, '1'), true)
        assert.strictEqual(queueDirectTrace(writer, '2'), true)
        const flushed = new Promise(resolve => writer.flush(resolve))
        const [{ headers }] = await Promise.all([received, flushed])
        observed.push(Object.fromEntries(names.map(name => [name, headers[name]])))
      } finally {
        writer.setUrl(intakeUrl)
      }
    }
    const [legacy, direct] = observed
    assert.strictEqual(legacy['x-datadog-trace-count'], '2')
    assert.deepStrictEqual(direct, legacy)
  })

  it('does not send a generated trace that exceeds the payload cap', async () => {
    const metadata = { hostname: 'test-host', runtimeID: 'test-runtime-id' }
    const send = sinon.spy(http, 'request')
    const trace = Array.from({ length: 900 }, (_, spanIndex) => {
      const span = webSpan('1')
      span.span_id = id((spanIndex + 1).toString(16))
      for (let tagIndex = 0; tagIndex < 10; tagIndex++) {
        span.meta['tag' + tagIndex] = 'x'.repeat(6000)
      }
      return span
    })
    try {
      for (const generatedObfuscation of [false, true]) {
        const writer = new AgentlessWriter({ url: intakeUrl, metadata, generatedObfuscation })
        try {
          assert.strictEqual(writer.append(trace), true)
          await new Promise(resolve => writer.flush(resolve))
          assert.strictEqual(send.callCount, 0)
        } finally {
          writer.setUrl(intakeUrl)
        }
      }
    } finally {
      send.restore()
    }
  })

  it('applies the generated policy above the encoder soft limit', async function () {
    if (!zstdDecompressSync) this.skip()

    const writer = directWriter(server)
    const value = 'x'.repeat(25_001)
    const trace = Array.from({ length: 350 }, (_, spanIndex) => {
      const span = webSpan('1')
      span.span_id = id((spanIndex + 1).toString(16))
      span.meta = { large: value, 'custom.number': '4111111111111111' }
      return span
    })
    const received = new Promise(resolve => { resolveRequest = resolve })
    try {
      assert.strictEqual(writer.append(trace), true)
      const { payload } = await received
      const json = zstdDecompressSync(payload).toString()
      assert.doesNotMatch(json, /4111111111111111/)
      const { traces: [{ spans }] } = JSON.parse(json)
      assert.strictEqual(spans.length, trace.length)
      assert.strictEqual(spans.at(-1).meta['custom.number'], '?')
    } finally {
      writer.setUrl(intakeUrl)
    }
  })

  it('matches the incumbent top-level metric for same-service children', async function () {
    if (!zstdDecompressSync) this.skip()

    const metadata = { hostname: 'test-host', runtimeID: 'test-runtime-id' }
    const observed = []
    const maxUint32 = 2 ** 32 - 1
    for (const generatedObfuscation of [false, true]) {
      const writer = new AgentlessWriter({ url: intakeUrl, metadata, generatedObfuscation })
      const values = []
      try {
        for (const [position, topLevel] of [0, maxUint32, 2.5, maxUint32 + 1, -1].entries()) {
          const traceId = (position + 1).toString(16)
          const parent = webSpan(traceId)
          const child = {
            ...webSpan(traceId),
            parent_id: parent.span_id,
            span_id: id('2'),
            metrics: { _top_level: topLevel },
          }
          const received = new Promise(resolve => { resolveRequest = resolve })
          assert.strictEqual(writer.append([parent, child]), true)
          const flushed = new Promise(resolve => writer.flush(resolve))
          const [{ payload }] = await Promise.all([received, flushed])
          const { traces: [trace] } = JSON.parse(zstdDecompressSync(payload).toString())
          values.push(trace.spans[1].metrics._top_level)
        }
      } finally {
        writer.setUrl(intakeUrl)
      }
      observed.push(values)
    }
    const [legacy, direct] = observed
    assert.deepStrictEqual(legacy.slice(0, 3), [0, maxUint32, 2])
    assert.deepStrictEqual(direct, legacy)
  })

  it('uses current environment and runtime metadata on each prepared batch', async function () {
    if (!zstdDecompressSync) this.skip()

    let env = 'test-env'
    let runtimeID = 'test-runtime-id'
    const metadata = {
      hostname: 'test-host',
      get runtimeID () { return runtimeID },
      get env () { return env },
    }
    const writer = new AgentlessWriter({ url: intakeUrl, metadata, generatedObfuscation: true })
    try {
      for (const index of [1, 2]) {
        const received = new Promise(resolve => { resolveRequest = resolve })
        assert.strictEqual(queueDirectTrace(writer, String(index)), true)
        env = `updated-${index}`
        runtimeID = `runtime-${index}`
        const flushed = new Promise(resolve => writer.flush(resolve))
        const [{ payload }] = await Promise.all([received, flushed])
        const { traces: [trace] } = JSON.parse(zstdDecompressSync(payload))
        assert.strictEqual(trace.env, env)
        assert.strictEqual(trace.runtimeID, runtimeID)
      }
    } finally {
      writer.setUrl(intakeUrl)
    }
  })

  it('does not trace the pipeline intake request', async () => {
    await agent.load('http', { server: false })
    const writer = new AgentlessWriter({ url: intakeUrl })
    const noIntakeTrace = agent.assertNoTraces(() => {
      assert.fail('the pipeline intake request must not create an HTTP client trace')
    }, { timeoutMs: 100 })

    request = new Promise(resolve => { resolveRequest = resolve })
    writer.append([{
      duration: 1,
      error: 0,
      meta: {},
      metrics: {},
      name: 'operation',
      parent_id: id('0'),
      resource: 'resource',
      service: 'service',
      span_id: id('2'),
      start: 1,
      trace_id: id('1'),
    }])

    await new Promise(resolve => writer.flush(resolve))
    await request
    await noIntakeTrace
  })

  it('obfuscates span fields before sending a trace to intake', async function () {
    if (!zstdDecompressSync) {
      this.skip()
    }

    request = new Promise(resolve => { resolveRequest = resolve })
    const writer = new AgentlessWriter({ url: intakeUrl })
    const rootSpan = {
      duration: 2,
      error: 0,
      meta: {
        '_dd.p.tid': '123456789abcdef0',
        'card.number': '4111 1111 1111 1111',
        'http.url': 'https://test-user:synthetic-password@shop.example.test/cart?page=1',
      },
      metrics: {},
      name: 'http.request',
      parent_id: id('0'),
      resource: 'GET /cart',
      service: 'shop',
      span_id: id('fedcba9876543211'),
      start: 1,
      trace_id: id('fedcba9876543210'),
      type: 'web',
    }
    writer.append([rootSpan, {
      ...rootSpan,
      meta: { 'redis.raw_command': 'SET cart:42 synthetic-value' },
      metrics: {},
      name: 'redis.command',
      parent_id: rootSpan.span_id,
      resource: 'SET cart:42 synthetic-value',
      service: 'redis',
      span_id: id('2'),
      type: 'redis',
    }])

    await new Promise(resolve => writer.flush(resolve))
    const { payload } = await request
    const json = zstdDecompressSync(payload).toString()
    assert.doesNotMatch(json, /synthetic-password|4111 1111 1111 1111|synthetic-value/)
    const [web, redis] = JSON.parse(json).traces[0].spans
    assert.strictEqual(web.trace_id, 'fedcba9876543210')
    assert.strictEqual(web.meta['_dd.p.tid'], '123456789abcdef0')
    assert.strictEqual(web.meta['http.url'], 'https://shop.example.test/cart?page=1')
    assert.strictEqual(web.meta['card.number'], '?')
    assert.strictEqual(redis.parent_id, web.span_id)
    assert.strictEqual(redis.resource, 'SET')
    assert.strictEqual(redis.meta['redis.raw_command'], 'SET cart:42 ?')
  })

  it('normalizes and obfuscates mixed batches with the generated policy', async function () {
    if (!zstdDecompressSync) {
      this.skip()
    }

    const handlers = globalThis[Symbol.for('dd-trace')].beforeExitHandlers
    const existingHandlers = new Set(handlers)
    const exporter = new AgentlessExporter({
      env: '',
      flushInterval: 60_000,
      tags: { 'runtime-id': 'test-runtime-id' },
      tracing: { DD_TRACE_EXPERIMENTAL_AGENTLESS_GENERATED_OBFUSCATION_ENABLED: true },
    })
    assert.strictEqual(exporter.setUrl(intakeUrl.href), true)

    function redis (traceId, meta = {}) {
      return [{
        duration: 1,
        error: 0,
        meta,
        metrics: {},
        name: 'redis.command',
        parent_id: id('0'),
        resource: 'SET test-key private-value',
        service: 'test-redis',
        span_id: id('1'),
        start: Number(1795170000123456700n),
        trace_id: id(traceId),
        type: 'redis',
      }]
    }

    async function flush (...traces) {
      let received
      resolveRequest = value => { received = value }
      for (const trace of traces) {
        assert.strictEqual(exporter.export(trace), true)
      }
      await new Promise(resolve => exporter.flush(resolve))
      assert.ok(received, 'expected an intake request before flush completed')
      const { payload, headers, path } = received
      assert.strictEqual(path, '/api/v2/spans')
      assert.strictEqual(headers['dd-api-key'], 'test-api-key')
      return zstdDecompressSync(payload).toString()
    }

    try {
      const [root] = redis('2')
      const servicePrefix = 'é'.repeat(100)
      const namePrefix = 'ç'.repeat(100)
      root.service = servicePrefix + 'parent'
      root.metrics = { _trace_root: 0, _top_level: 0 }
      const direct = await flush([
        root,
        {
          ...root,
          span_id: id('2'),
          parent_id: root.span_id,
          service: servicePrefix + 'child',
          resource: '   ',
          metrics: { _top_level: 2 },
        },
        { ...root, span_id: id('3'), parent_id: root.span_id, service: 'other', metrics: { _top_level: 3 } },
        { ...root, span_id: id('4'), parent_id: id('f'), metrics: { _top_level: 4 } },
        {
          ...root,
          span_id: id('5'),
          parent_id: root.span_id,
          name: 'set normalized-resource',
          resource: '',
          metrics: {},
        },
        {
          ...root,
          span_id: id('6'),
          parent_id: root.span_id,
          name: namePrefix + 'suffix',
          type: 'web',
          resource: '',
          metrics: {},
        },
        {
          ...root,
          span_id: id('7'),
          parent_id: root.span_id,
          name: '',
          service: '',
          type: undefined,
          resource: '',
          metrics: {},
        },
        { ...root, span_id: id('8'), parent_id: id('7'), service: undefined, metrics: {} },
      ])
      assert.doesNotMatch(direct, /private-value/)
      assert.match(direct, /"start":1795170000123456768[,}]/)
      const [directTrace] = JSON.parse(direct).traces
      assert.strictEqual(Object.hasOwn(directTrace, 'env'), false)
      assert.deepStrictEqual(directTrace.spans.map(span => span.metrics), [
        { _trace_root: 0, _top_level: 1 },
        { _top_level: 2 },
        { _top_level: 1 },
        { _top_level: 1 },
        {},
        {},
        { _top_level: 1 },
        {},
      ])
      assert.strictEqual(directTrace.spans[1].resource, 'redis.command')
      assert.strictEqual(directTrace.spans[0].service, servicePrefix)
      assert.strictEqual(directTrace.spans[1].service, servicePrefix)
      assert.strictEqual(directTrace.spans[4].resource, 'SET')
      assert.strictEqual(directTrace.spans[5].name, namePrefix)
      assert.strictEqual(directTrace.spans[5].resource, namePrefix)
      assert.strictEqual(directTrace.spans[6].name, 'unnamed_operation')
      assert.strictEqual(directTrace.spans[6].service, 'unnamed-service')
      assert.strictEqual(directTrace.spans[6].resource, 'unnamed_operation')
      assert.strictEqual(Object.hasOwn(directTrace.spans[6], 'type'), false)
      assert.strictEqual(directTrace.spans[7].service, 'unnamed-service')
      const valkey = redis('7', {
        'valkey.raw_command': 'AUTH private-user private-value',
        '_dd.compute_stats': '0',
      })
      valkey[0].type = 'valkey'
      const mixed = await flush(
        redis('3'), redis('4', { 'redis.raw_command': 'SET test-key private-value' }), valkey
      )
      assert.doesNotMatch(mixed, /private-value/)
      const traces = JSON.parse(mixed).traces
      assert.deepStrictEqual(traces.map(trace => trace.spans[0].trace_id), [
        '0000000000000003', '0000000000000004', '0000000000000007',
      ])
      assert.strictEqual(traces[1].spans[0].meta['redis.raw_command'], 'SET test-key ?')
      assert.strictEqual(traces[2].spans[0].meta['valkey.raw_command'], 'AUTH ?')
      assert.strictEqual(traces[2].spans[0].meta['_dd.compute_stats'], '0')
      assert.strictEqual(valkey[0].meta['valkey.raw_command'], 'AUTH private-user private-value')
      const sortedSet = await flush(
        redis('8'), redis('9', { 'redis.raw_command': 'ZADD test-key 1 private-value' }), redis('a')
      )
      assert.doesNotMatch(sortedSet, /private-value/)
      assert.strictEqual(JSON.parse(sortedSet).traces[1].spans[0].meta['redis.raw_command'], 'ZADD test-key 1 ?')

      const [split] = redis('6')
      const splitPrefix = 'a'.repeat(99)
      split.name = splitPrefix + '𖺻'
      const splitWire = await flush([split])
      assert.strictEqual(JSON.parse(splitWire).traces[0].spans[0].name, splitPrefix + '\uFFFD')

      for (const [meta, expected] of [
        [{ 'http.url': 'https://user:synthetic-password@example.test/path' }, {
          'http.url': 'https://example.test/path',
        }],
        [{ 'card.number': '4111 1111 1111 1111' }, { 'card.number': '?' }],
      ]) {
        const web = redis('b', meta)
        web[0].type = 'web'
        web[0].resource = 'GET /test'
        web[0].service = undefined
        const fallback = await flush(redis('c'), web)
        assert.doesNotMatch(fallback, /synthetic-password|4111 1111 1111 1111/)
        const { traces: [queued, rejected] } = JSON.parse(fallback)
        assert.strictEqual(queued.spans[0].resource, 'SET')
        assert.strictEqual(rejected.spans[0].service, 'unnamed-service')
        assert.deepStrictEqual(rejected.spans[0].meta, { ...expected, '_dd.compute_stats': '1' })
      }

      const sql = redis('d', { 'db.type': 'postgres', 'custom.number': '4111111111111111' })
      sql[0].type = 'sql'
      sql[0].resource = "SELECT 'synthetic-secret'"
      const sqlWire = await flush(redis('e'), sql)
      assert.doesNotMatch(sqlWire, /synthetic-secret|4111111111111111/)
      const sqlSpan = JSON.parse(sqlWire).traces[1].spans[0]
      assert.strictEqual(sqlSpan.resource, 'SELECT ?')
      assert.strictEqual(sqlSpan.meta['sql.query'], 'SELECT ?')
      assert.strictEqual(sqlSpan.meta['custom.number'], '?')

      const event = { name: 'test.event', time_unix_nano: 1_000_000 }
      const metaStruct = { test: { flags: [true, false] } }
      for (const metadata of [
        { span_events: [{ name: event.name, startTime: 1 }] },
        { meta: { events: JSON.stringify([event]) } },
        { meta_struct: metaStruct },
      ]) {
        const [span] = redis('e')
        const wire = await flush(redis('f'), [{ ...span, ...metadata }])
        const { traces: [queued, rejected] } = JSON.parse(wire)
        assert.strictEqual(queued.spans[0].resource, 'SET')
        assert.strictEqual(rejected.spans[0].resource, 'SET')
        if (metadata.meta_struct) {
          assert.deepStrictEqual(rejected.spans[0].meta_struct, metaStruct)
        } else {
          assert.deepStrictEqual(JSON.parse(rejected.spans[0].meta.events), [event])
        }
      }

      const metricKey = 'm'.repeat(200) + '...'
      const [longMetric] = redis('f')
      longMetric.metrics[metricKey] = 42
      const metricWire = await flush([longMetric])
      assert.strictEqual(JSON.parse(metricWire).traces[0].spans[0].metrics[metricKey], 42)

      const [large] = redis('10', { large: 'x'.repeat(6200) })
      const largeTrace = Array.from({ length: 225 }, (_, index) => ({
        ...large,
        span_id: id((index + 1).toString(16)),
      }))
      const { traces: [{ spans }] } = JSON.parse(await flush(largeTrace))
      assert.strictEqual(spans.length, largeTrace.length)
    } finally {
      for (const handler of handlers) {
        if (!existingHandlers.has(handler)) handlers.delete(handler)
      }
    }
  })
})
