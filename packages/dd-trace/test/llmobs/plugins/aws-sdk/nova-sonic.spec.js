'use strict'

const assert = require('node:assert/strict')

const { beforeEach, afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { storage: llmobsStorage } = require('../../../../src/llmobs/storage')
const {
  MODEL, EPOCH, OUTPUT, event, pcm, record, fixture, speech,
} = require('../../../../../datadog-instrumentations/test/nova-sonic/helpers')
const { useLlmObs, assertLlmObsSpanEvent } = require('../../util')
const { withVersions } = require('../../../setup/mocha')

const MS = 1e6

function named (spans, name) {
  const span = spans.find(s => s.name === name)
  assert.ok(span, `missing ${name}: ${spans.map(s => s.name)}`)
  return span
}

function wav (part, rate, bytes) {
  assert.equal(part.mime_type, 'audio/wav')
  const raw = Buffer.from(part.content, 'base64')
  assert.equal(raw.toString('ascii', 0, 4), 'RIFF')
  assert.equal(raw.toString('ascii', 8, 12), 'WAVE')
  assert.equal(raw.readUInt16LE(22), 1)
  assert.equal(raw.readUInt32LE(24), rate)
  assert.equal(raw.readUInt16LE(34), 16)
  assert.equal(raw.readUInt32LE(40), bytes)
  assert.equal(raw.length, bytes + 44)
  return raw.subarray(44)
}

function tree (spans, index = 0) {
  const roots = spans.filter(s => s.name === 'nova sonic audio turn')
  const root = roots[index]
  assert.ok(root)
  const children = spans.filter(s => s.parent_id === root.span_id)
  const llm = named(children, 'nova sonic response')
  for (const child of children) {
    assert.equal(child.trace_id, root.trace_id)
    assert.equal(child.session_id, root.session_id)
  }
  for (const span of [root, ...children.filter(s => s !== llm)]) {
    assert.equal(span.meta['span.kind'], 'workflow')
    assert.deepEqual(span.metrics, {})
    assert.equal(JSON.stringify(span).includes('audio_parts'), false)
  }
  assert.equal(llm.meta['span.kind'], 'llm')
  assert.equal(llm.meta.model_provider, 'amazon')
  assert.equal(llm.meta.model_name, MODEL)
  return { root, children, llm }
}

withVersions('aws-sdk', '@aws-sdk/client-bedrock-runtime', '>=3.785.0', version => {
  describe(`Nova Sonic through BedrockRuntimeClient.send (${version})`, () => {
    const { getEvents } = useLlmObs({ plugin: 'aws-sdk' })
    let clock
    let AWS
    let client
    let tracer

    beforeEach(() => {
      clock = sinon.useFakeTimers({ now: EPOCH, toFake: ['Date'] })
      AWS = require(`../../../../../../versions/@aws-sdk/client-bedrock-runtime@${version}`).get()
      client = new AWS.BedrockRuntimeClient({
        region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      })
      tracer = require('../../../../../..')
    })

    afterEach(() => {
      clock.restore()
      client.destroy()
    })

    // Replace transport at the SDK's public middleware boundary. Each response pull advances the
    // captured duplex schedule, consuming input only at the recorded outbound positions.
    function command (records, { failure, cleanupError, model = MODEL } = {}) {
      let inputPulls = 0
      let inputClosed = 0
      let outputClosed = 0
      const body = (async function * () {
        try {
          for (const r of records) {
            if (r.outbound) {
              inputPulls++
              yield r.value
            }
          }
        } finally {
          inputClosed++
        }
      })()
      const request = new AWS.InvokeModelWithBidirectionalStreamCommand({ modelId: model, body })
      request.middlewareStack.add(() => async ({ input }) => {
        const source = input.body[Symbol.asyncIterator]()
        const response = (async function * () {
          try {
            for (const r of records) {
              clock.setSystemTime(EPOCH + r.at)
              if (r.outbound) {
                assert.equal((await source.next()).value, r.value)
              } else {
                yield r.value
              }
            }
            await source.next()
            if (failure) throw failure
          } finally {
            await source.return()
            outputClosed++
            // Deliberately model an SDK iterator whose cleanup rejects.
            // eslint-disable-next-line no-unsafe-finally
            if (cleanupError) throw cleanupError
          }
        })()
        return { output: { body: response, $metadata: {} } }
      }, { name: 'fixtureTransport', step: 'initialize', priority: 'high' })
      return {
        request,
        body,
        counts: () => ({ inputPulls, inputClosed, outputClosed }),
      }
    }

    async function drain (response) {
      const values = []
      for await (const value of response.body) values.push(value)
      return values
    }

    it('serializes the exact hierarchy, WAV placement, and receipt-based TTFA', async () => {
      const records = speech()
      const run = command(records)
      const response = await client.send(run.request)
      assert.equal(run.request.input.body, run.body, 'restore the caller command after send')
      assert.equal(run.counts().inputPulls, 0, 'instrumentation must not eagerly drain input')
      assert.deepEqual(await drain(response), records.filter(r => !r.outbound).map(r => r.value))
      assert.deepEqual(run.counts(), { inputPulls: 4, inputClosed: 1, outputClosed: 1 })
      const { apmSpans, llmobsSpans } = await getEvents(4)
      const { root, children, llm } = tree(llmobsSpans)
      assert.equal(root.parent_id, 'undefined')
      assert.equal(children.length, 3)
      assert.equal(root.session_id, 'provider-session')
      const user = named(children, 'user speech')
      const agent = named(children, 'agent speech')
      assert.equal(user.start_ns + user.duration, (EPOCH + 2500) * MS)
      assert.equal(agent.start_ns - (user.start_ns + user.duration), 500 * MS)
      assert.equal(llm.start_ns, (EPOCH + 2500) * MS)
      assert.equal(llm.start_ns + llm.duration, (EPOCH + 3050) * MS)
      assert.equal(root.start_ns + root.duration, (EPOCH + 3100) * MS)
      wav(llm.meta.input.messages[0].audio_parts[0], 16_000, 12_800)
      wav(llm.meta.output.messages[0].audio_parts[0], 24_000, 4800)
      const metadata = llm.meta.metadata
      assert.deepEqual(metadata.speech_windows, [{ start_ms: 100, end_ms: 500, detection_ms: 750 }])
      assert.equal(metadata.ttfa_boundary, 'speech_end_event_receipt')
      assertLlmObsSpanEvent(llm, {
        span: apmSpans.find(s => s.span_id.toString(10) === llm.span_id),
        spanKind: 'llm',
        name: 'nova sonic response',
        modelName: MODEL,
        modelProvider: 'amazon',
        sessionId: root.session_id,
        parentId: root.span_id,
        traceId: root.trace_id,
        tags: { ml_app: 'test', integration: 'bedrock' },
        inputMessages: llm.meta.input.messages,
        outputMessages: llm.meta.output.messages,
        metadata,
        metrics: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      })
    })

    it('passes through the SDK serializer, signer, event-stream decoder and input half-close', async () => {
      const records = speech()
      const outbound = records.filter(r => r.outbound)
      const inbound = records.filter(r => !r.outbound)
      const accepted = []
      let closed = false
      const body = (async function * () {
        try {
          for (const r of outbound) {
            clock.setSystemTime(EPOCH + r.at)
            yield r.value
          }
        } finally {
          closed = true
        }
      })()
      const requestHandler = {
        metadata: { handlerProtocol: 'h2' },
        async handle (request) {
          assert.equal(request.method, 'POST')
          assert.match(request.path, /\/invoke-with-bidirectional-stream$/)
          assert.match(request.headers.authorization, /^AWS4-HMAC-SHA256/)
          const marshaller = transport.config.eventStreamMarshaller
          const dependencies = require(`../../../../../../versions/@aws-sdk/client-bedrock-runtime@${version}`)
          const { EventStreamCodec } = dependencies.get('@smithy/eventstream-codec')
          const codec = new EventStreamCodec(bytes => Buffer.from(bytes).toString(), text => Buffer.from(text))
          // SigV4 wraps each input event in a signed envelope. Unwrap it before decoding the chunk.
          const unsigned = (async function * () {
            for await (const chunk of request.body) {
              const envelope = codec.decode(chunk)
              assert.ok(envelope.headers[':chunk-signature'])
              if (envelope.body.length) yield envelope.body
            }
          })()
          const decoded = marshaller.deserialize(unsigned, async message => {
            if (!message.chunk) return { $unknown: true }
            return JSON.parse(Buffer.from(message.chunk.body).toString())
          })
          for await (const value of decoded) accepted.push(value)
          assert.equal(closed, true)
          const source = (async function * () {
            for (const r of inbound) {
              clock.setSystemTime(EPOCH + r.at)
              yield r.value
            }
          })()
          const stream = marshaller.serialize(source, value => ({
            headers: {
              ':message-type': { type: 'string', value: 'event' },
              ':event-type': { type: 'string', value: 'chunk' },
              ':content-type': { type: 'string', value: 'application/json' },
            },
            body: Buffer.from(JSON.stringify({ bytes: Buffer.from(value.chunk.bytes).toString('base64') })),
          }))
          return { response: { statusCode: 200, headers: {}, body: stream } }
        },
        destroy () {},
      }
      const transport = new AWS.BedrockRuntimeClient({
        region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, requestHandler,
      })
      try {
        const request = new AWS.InvokeModelWithBidirectionalStreamCommand({ modelId: MODEL, body })
        const response = await transport.send(request)
        assert.equal(accepted.length, outbound.length)
        await drain(response)
        const { llm } = tree((await getEvents(4)).llmobsSpans)
        assert.equal(llm.meta.input.messages[0].content, 'question 1')
        assert.equal(llm.meta.output.messages[0].content, 'answer 1')
        wav(llm.meta.input.messages[0].audio_parts[0], 16_000, 12_800)
        wav(llm.meta.output.messages[0].audio_parts[0], 24_000, 4800)
      } finally {
        transport.destroy()
      }
    })

    it('uses one encoded budget for both roles while preserving transcripts and valid timing', async () => {
      const records = speech({ outputMs: 40_000 })
      records[2] = record('audioInput', { contentName: 'mic1', content: pcm(60_000, 16_000) }, 1000, true)
      records[5] = record('userSpeechEnd', { inputAudioOffsetMs: 50_000 }, 2500)
      await drain(await client.send(command(records).request))
      const { llm, children } = tree((await getEvents(4)).llmobsSpans)
      wav(llm.meta.input.messages[0].audio_parts[0], 16_000, (50_000 - 100) * 32)
      assert.equal(llm.meta.output.messages[0].audio_parts, undefined)
      assert.equal(llm.meta.output.messages[0].content, 'answer 1')
      assert.equal(llm.meta.metadata.output_audio_omitted_reason, 'payload_limit')
      assert.equal(named(children, 'agent speech').duration, 40_000 * MS)
      assert.ok(Buffer.byteLength(JSON.stringify(llm)) < 4 * 1024 * 1024 + 8192)
    })

    it('serializes tool calls and results on the LLM response', async () => {
      const records = speech()
      records.splice(9, 0,
        record('contentStart', { contentId: 'tool', role: 'TOOL', type: 'TOOL' }, 2600),
        record('toolUse', {
          contentId: 'tool', toolName: 'get_weather', toolUseId: 'call', content: '{"city":"Boston"}',
        }, 2610),
        record('contentEnd', { contentId: 'tool', stopReason: 'TOOL_USE' }, 2620),
        record('contentStart', {
          contentName: 'result', toolResultInputConfiguration: { toolUseId: 'call' },
        }, 2630, true),
        record('toolResult', { contentName: 'result', content: 'sunny' }, 2640, true))
      await drain(await client.send(command(records).request))
      const { llm } = tree((await getEvents(4)).llmobsSpans)
      assert.deepEqual(llm.meta.output.messages[0].tool_calls, [{
        name: 'get_weather', arguments: { city: 'Boston' }, tool_id: 'call', type: 'function',
      }])
      assert.deepEqual(llm.meta.input.messages[1].tool_results, [{
        name: '', result: 'sunny', tool_id: 'call', type: 'tool_result',
      }])
    })

    for (const [captureName, turnCount] of [['voice-session-1', 5], ['voice-session-2', 6]]) {
      for (const wrapped of [false, true]) {
        it(`serializes ${captureName}, ${wrapped ? 'inside a workflow' : 'as independent traces'}`, async () => {
          const { records, capture } = fixture(captureName)
          const run = command(records)
          const execute = async () => drain(await client.send(run.request))
          if (wrapped) await tracer.llmobs.trace({ kind: 'workflow', name: 'application' }, execute)
          else await execute()
          const { llmobsSpans } = await getEvents(turnCount * 4 + Number(wrapped))
          const responses = llmobsSpans.filter(s => s.name === 'nova sonic response')
          assert.equal(responses.reduce((n, s) => n + s.metrics.input_tokens, 0), capture.input_tokens)
          assert.equal(responses.reduce((n, s) => n + s.metrics.output_tokens, 0), capture.output_tokens)
          assert.equal(new Set(responses.map(s => s.session_id)).size, 1)
          const lastUsage = capture.events.filter(r => r.event.usageEvent).at(-1).event.usageEvent
          for (const direction of ['input', 'output']) {
            assert.equal(responses.reduce((n, s) => n + s.metrics[`${direction}_audio_tokens`], 0),
              lastUsage.details.total[direction].speechTokens)
          }
          const speechEnds = records.filter(r => r.value.chunk.bytes.includes('userSpeechEnd')).map(r => EPOCH + r.at)
          for (let i = 0; i < turnCount; i++) {
            const { root, children, llm } = tree(llmobsSpans, i)
            assert.equal(root.parent_id, wrapped ? named(llmobsSpans, 'application').span_id : 'undefined')
            const user = named(children, 'user speech')
            const agent = named(children, 'agent speech')
            const end = Math.max(...speechEnds.filter(t => t * MS <= agent.start_ns)) * MS
            assert.equal(user.start_ns + user.duration, Math.round(end))
            const windows = llm.meta.metadata.speech_windows
            wav(llm.meta.input.messages.at(-1).audio_parts[0], 16_000,
              (windows.at(-1).end_ms - windows[0].start_ms) * 32)
            const output = Buffer.from(llm.meta.output.messages[0].audio_parts[0].content, 'base64')
            assert.ok(Math.abs(agent.duration - output.readUInt32LE(40) / 48 * MS) < 1)
            assert.equal(root.start_ns + root.duration, Math.max(...children.map(s => s.start_ns + s.duration)))
          }
          assert.equal(new Set(responses.map(s => s.trace_id)).size, wrapped ? 1 : turnCount)
        })
      }
    }

    for (const parent of ['none', 'finished', 'active']) {
      for (const fail of [false, true]) {
        it(`preserves ${parent} invocation context while consuming under workflow B (${fail ? 'error' : 'success'})`,
          async () => {
            const error = fail ? new Error('stream failed') : undefined
            const run = command(speech(), { failure: error })
            const consume = async response => {
              await tracer.llmobs.trace({ kind: 'workflow', name: 'consumer B', mlApp: 'consumer' }, async () => {
                const active = tracer.scope().active()
                const llmobsActive = llmobsStorage.getStore().span
                if (fail) await assert.rejects(drain(response), e => e === error)
                else await drain(response)
                assert.equal(tracer.scope().active(), active)
                assert.equal(llmobsStorage.getStore().span, llmobsActive)
                tracer.llmobs.trace({ kind: 'task', name: 'subsequent B' }, () => {})
              })
            }
            if (parent === 'active') {
              await tracer.llmobs.trace({ kind: 'workflow', name: 'invocation A', mlApp: 'producer' },
                async () => consume(await client.send(run.request)))
            } else if (parent === 'finished') {
              const response = await tracer.llmobs.trace({ kind: 'workflow', name: 'invocation A', mlApp: 'producer' },
                () => client.send(run.request))
              await consume(response)
            } else {
              await consume(await client.send(run.request))
            }
            const { llmobsSpans } = await getEvents(parent === 'none' ? 6 : 7)
            const { root, llm } = tree(llmobsSpans)
            const consumer = named(llmobsSpans, 'consumer B')
            assert.equal(named(llmobsSpans, 'subsequent B').parent_id, consumer.span_id)
            assert.notEqual(root.parent_id, consumer.span_id)
            if (parent === 'none') {
              assert.equal(root.parent_id, 'undefined')
              assert.notEqual(root.trace_id, consumer.trace_id)
              assert.ok(root.tags.includes('ml_app:test'))
            } else {
              const invocation = named(llmobsSpans, 'invocation A')
              assert.equal(root.parent_id, invocation.span_id)
              assert.equal(root.trace_id, invocation.trace_id)
              assert.ok(root.tags.includes('ml_app:producer'))
            }
            assert.equal(llm.status, fail ? 'error' : 'ok')
            if (fail) assert.equal(llm.meta['error.message'], 'stream failed')
          })
      }
    }

    it('keeps concurrent sessions attached to their respective callers', async () => {
      const a = command(speech())
      const b = command(speech({ id: '2', at: 4000 }))
      const [first, second] = await Promise.all([
        tracer.llmobs.trace({ kind: 'workflow', name: 'A' }, () => client.send(a.request)),
        tracer.llmobs.trace({ kind: 'workflow', name: 'B' }, () => client.send(b.request)),
      ])
      await Promise.all([drain(first), drain(second)])
      const { llmobsSpans } = await getEvents(10)
      const turns = llmobsSpans.filter(s => s.name === 'nova sonic audio turn')
      assert.deepEqual(new Set(turns.map(s => s.parent_id)),
        new Set([named(llmobsSpans, 'A').span_id, named(llmobsSpans, 'B').span_id]))
    })

    for (const cleanupError of [undefined, new Error('cleanup failed')]) {
      it(`delegates iterator return exactly once and ${cleanupError ? 'preserves its error' : 'flushes partial turns'}`,
        async () => {
          const run = command(speech(), { cleanupError })
          const response = await client.send(run.request)
          const iterator = response.body[Symbol.asyncIterator]()
          await iterator.next()
          if (cleanupError) await assert.rejects(iterator.return(), e => e === cleanupError)
          else await iterator.return()
          assert.equal(run.counts().outputClosed, 1)
          const { llmobsSpans } = await getEvents(2)
          assert.equal(llmobsSpans.length, 2)
          assert.equal(named(llmobsSpans, 'nova sonic response').status, cleanupError ? 'error' : 'ok')
        })
    }

    it('supports callback send and preserves the SDK callback result', async () => {
      const run = command(speech())
      const response = await new Promise((resolve, reject) => {
        const result = client.send(run.request, {}, (error, output) => error ? reject(error) : resolve(output))
        assert.equal(result, undefined)
      })
      await drain(response)
      tree((await getEvents(4)).llmobsSpans)
    })

    for (const reverse of [false, true]) {
      for (const callback of [false, true]) {
        for (const fail of [false, true]) {
          it(`isolates reused commands (reverse=${reverse}, callback=${callback}, fail=${fail})`, async () => {
            let iterations = 0
            const body = {
              async * [Symbol.asyncIterator] () {
                const content = `input ${++iterations}`
                yield event('contentStart', { contentName: 'user', role: 'USER', type: 'TEXT', interactive: true })
                yield event('textInput', { contentName: 'user', content })
                yield event('contentEnd', { contentName: 'user' })
              },
            }
            const input = { modelId: MODEL, body }
            const request = new AWS.InvokeModelWithBidirectionalStreamCommand(input)
            const releases = []
            const expected = []
            const failure = new Error('first send failed')
            request.middlewareStack.add(() => async ({ input }) => {
              const id = releases.length
              await new Promise(resolve => releases.push(resolve))
              for await (const chunk of input.body) {
                const text = JSON.parse(Buffer.from(chunk.chunk.bytes).toString()).event.textInput
                if (text) expected[id] = text.content
              }
              if (fail && id === 0) throw failure
              return {
                output: {
                  $metadata: {},
                  body: (async function * () {
                    yield event('contentStart', { contentId: 'answer', role: 'ASSISTANT', type: 'TEXT' })
                    yield event('textOutput', { contentId: 'answer', content: `answer ${id}` })
                    yield event('contentEnd', { contentId: 'answer' })
                  })(),
                },
              }
            }, { name: 'fixtureTransport', step: 'initialize', priority: 'high' })
            const send = () => callback
              ? new Promise((resolve, reject) => {
                client.send(request, (error, output) => error ? reject(error) : resolve(output))
              })
              : client.send(request)
            const pending = [send(), send()]
            const settled = pending.map(promise => promise.then(output => ({ output }), error => ({ error })))
            const both = Promise.all(settled)
            const order = reverse ? [1, 0] : [0, 1]
            for (const index of order) {
              releases[index]()
              await settled[index]
            }
            const results = await both
            assert.equal(request.input, input, 'restore original input after either completion order')
            if (fail) assert.equal(results[0].error, failure)
            // Keep both sessions alive until both inputs have been consumed to expose cross-observation.
            await Promise.all(results.filter(result => result.output).map(result => drain(result.output)))
            const reused = send()
            releases[2]()
            await drain(await reused)
            assert.equal(request.input, input, 'subsequent reuse preserves the original input')
            const { llmobsSpans } = await getEvents(6)
            const responses = llmobsSpans.filter(span => span.name === 'nova sonic response')
            assert.equal(responses.length, 3)
            for (let id = 0; id < 3; id++) {
              const response = responses.find(span => fail && id === 0
                ? span.meta['error.message'] === failure.message
                : span.meta.output.messages[0].content === `answer ${id}`)
              assert.ok(response, `missing response ${id}`)
              assert.equal(response.meta.input.messages[0].content, expected[id], 'input belongs to its invocation')
            }
          })
        }
      }
    }

    for (const callback of [false, true]) {
      it(`preserves a send failure and restores the command (${callback ? 'callback' : 'promise'})`, async () => {
        const failure = new Error('request rejected')
        const request = command([]).request
        const original = request.input
        request.middlewareStack.add(() => async () => { throw failure }, {
          step: 'initialize', priority: 'high', name: 'fixtureTransport', override: true,
        })
        const result = callback
          ? new Promise((resolve, reject) => client.send(request, error => error ? reject(error) : resolve()))
          : client.send(request)
        await assert.rejects(result, error => error === failure)
        assert.equal(request.input, original)
        const { llmobsSpans } = await getEvents(2)
        assert.equal(named(llmobsSpans, 'nova sonic response').meta['error.message'], failure.message)
      })
    }

    it('delegates iterator throw and preserves the exact error and cleanup', async () => {
      const failure = new Error('consumer failed')
      const run = command(speech())
      const response = await client.send(run.request)
      const iterator = response.body[Symbol.asyncIterator]()
      await iterator.next()
      await assert.rejects(iterator.throw(failure), error => error === failure)
      assert.deepEqual(run.counts(), { inputPulls: 4, inputClosed: 1, outputClosed: 1 })
      const { llmobsSpans } = await getEvents(2)
      assert.equal(named(llmobsSpans, 'nova sonic response').meta['error.message'], failure.message)
    })

    for (const where of ['factory', 'next']) {
      it(`preserves input ${where} failures without emitting duplicate errors`, async () => {
        const failure = new Error(`input ${where} failed`)
        const run = command(speech())
        run.request.input.body = {
          [Symbol.asyncIterator] () {
            if (where === 'factory') throw failure
            return { next: () => Promise.reject(failure), return: () => Promise.resolve({ done: true }) }
          },
        }
        const consume = async () => drain(await client.send(run.request))
        await assert.rejects(consume(), error => error === failure)
        const { llmobsSpans } = await getEvents(2)
        assert.equal(llmobsSpans.length, 2)
        assert.equal(named(llmobsSpans, 'nova sonic response').meta['error.message'], failure.message)
      })
    }

    for (const mode of ['disabled', 'original-model', 'immutable-input']) {
      it(`passes through unchanged when ${mode}`, async () => {
        if (mode === 'disabled') tracer.use('aws-sdk', { llmobs: false })
        try {
          const run = command(speech(), { model: mode === 'original-model' ? 'amazon.nova-sonic-v1:0' : MODEL })
          const original = run.request.input
          if (mode === 'immutable-input') Object.defineProperty(run.request, 'input', { writable: false })
          run.request.middlewareStack.addRelativeTo(next => async args => {
            assert.equal(args.input, original)
            return next(args)
          }, { relation: 'before', toMiddleware: 'fixtureTransport', name: 'verifyIdentity' })
          await drain(await client.send(run.request))
          assert.equal(run.request.input, original)
          tracer.llmobs.trace({ kind: 'workflow', name: 'sentinel' }, () => {})
          const { llmobsSpans } = await getEvents(1)
          assert.deepEqual(llmobsSpans.map(span => span.name), ['sentinel'])
        } finally {
          tracer.use('aws-sdk', { llmobs: true })
        }
      })
    }

    it('flushes an aborted response once and preserves AbortSignal behavior', async () => {
      const controller = new AbortController()
      const run = command(speech())
      const response = await client.send(run.request, { abortSignal: controller.signal })
      const iterator = response.body[Symbol.asyncIterator]()
      await iterator.next()
      controller.abort()
      await iterator.return()
      const { llmobsSpans } = await getEvents(2)
      assert.equal(llmobsSpans.length, 2)
      assert.equal(named(llmobsSpans, 'nova sonic response').meta['error.type'], 'AbortError')
    })

    for (const gap of [1000, 40_000, 70_000]) {
      it(`preserves ${gap}ms of output underrun or falls back without losing phase timing`, async () => {
        const records = speech().slice(0, 11)
        records.push(
          record('contentStart', { contentId: 'second', type: 'AUDIO', role: 'ASSISTANT' }, 3050),
          record('audioOutput', { contentId: 'second', content: pcm(100) }, 3100 + gap),
          record('contentEnd', { contentId: 'second', stopReason: 'END_TURN' }, 3150 + gap))
        await drain(await client.send(command(records).request))
        const { llm, children } = tree((await getEvents(4)).llmobsSpans)
        assert.equal(named(children, 'agent speech').duration, (200 + gap) * MS)
        if (gap === 70_000) {
          assert.equal(llm.meta.output.messages[0].audio_parts, undefined)
          assert.equal(llm.meta.metadata.output_audio_omitted_reason, 'retention_limit')
        } else {
          const raw = wav(llm.meta.output.messages[0].audio_parts[0], 24_000, (200 + gap) * 48)
          assert.deepEqual(raw.subarray(4800, raw.length - 4800), Buffer.alloc(gap * 48))
        }
      })
    }

    for (const fields of [{ generationStage: 'FINAL' }, 'broken{', '["FINAL"]', '"FINAL"', undefined]) {
      it(`retains output when optional metadata is ${JSON.stringify(fields)}`, async () => {
        const records = speech()
        records[9] = record('contentStart', {
          contentId: 'audio1',
          type: 'AUDIO',
          role: 'ASSISTANT',
          audioOutputConfiguration: OUTPUT,
          additionalModelFields: fields,
        }, 2700)
        await drain(await client.send(command(records).request))
        const { llm } = tree((await getEvents(4)).llmobsSpans)
        wav(llm.meta.output.messages[0].audio_parts[0], 24_000, 4800)
      })
    }
  })
})
