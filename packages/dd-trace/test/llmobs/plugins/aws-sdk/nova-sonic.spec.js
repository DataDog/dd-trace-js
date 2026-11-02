'use strict'

const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { join } = require('node:path')
const { promisify } = require('node:util')

const { beforeEach, afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { storage: llmobsStorage } = require('../../../../src/llmobs/storage')
const {
  MODEL, EPOCH, INPUT, OUTPUT, event, pcm, record, fixture, speech, namedUsage,
} = require('../../../../../datadog-instrumentations/test/nova-sonic/helpers')
const { useLlmObs, assertLlmObsSpanEvent } = require('../../util')
const { withVersions } = require('../../../setup/mocha')

const MS = 1e6
const exec = promisify(execFile)

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

    // Keep the SDK serializer, signer and decoder, replacing only its HTTP transport.
    function serializedClient (respond, config = {}, model = MODEL) {
      const requestHandler = {
        metadata: { handlerProtocol: 'h2' },
        async handle (request) {
          assert.equal(request.method, 'POST')
          assert.match(request.path, /\/invoke-with-bidirectional-stream$/)
          assert.equal(decodeURIComponent(request.path), `/model/${model}/invoke-with-bidirectional-stream`)
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
            assert.ok(message.chunk)
            const payload = JSON.parse(Buffer.from(message.chunk.body).toString())
            return JSON.parse(Buffer.from(payload.bytes, 'base64').toString())
          })
          const accepted = []
          for await (const value of decoded) accepted.push(value)
          const source = await respond(accepted)
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
        region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, requestHandler, ...config,
      })
      return transport
    }

    for (const { name, counts, expected } of [
      {
        name: 'complete',
        counts: { inputText: 6, outputText: 24 },
        expected: { input_text_tokens: 6, output_text_tokens: 24 },
      },
      {
        name: 'missing text',
        counts: {},
        expected: {},
      },
      {
        name: 'explicit zero text',
        counts: { inputText: 0, outputText: 0 },
        expected: { input_text_tokens: 0, output_text_tokens: 0 },
      },
      {
        name: 'invalid text',
        counts: { inputText: -1, outputText: '24' },
        expected: {},
      },
    ]) {
      it(`serializes ${name} named token counts without inventing cache counts`, async () => {
        const records = speech()
        records.splice(10, 0, namedUsage({
          input: 85, output: 129, inputAudio: 79, outputAudio: 105, ...counts,
        }, 2701))
        const outbound = records.filter(r => r.outbound)
        const transport = serializedClient(() => (async function * () {
          for (const r of records.filter(r => !r.outbound)) {
            clock.setSystemTime(EPOCH + r.at)
            yield r.value
          }
        })())
        const body = { async * [Symbol.asyncIterator] () { for (const r of outbound) yield r.value } }
        try {
          await drain(await transport.send(new AWS.InvokeModelWithBidirectionalStreamCommand({ modelId: MODEL, body })))
          const { llmobsSpans } = await getEvents(4)
          assert.deepEqual(tree(llmobsSpans).llm.metrics, {
            input_tokens: 85,
            output_tokens: 129,
            total_tokens: 214,
            input_audio_tokens: 79,
            output_audio_tokens: 105,
            ...expected,
          })
        } finally {
          transport.destroy()
        }
      })
    }

    it('honors the environment service disable before subscribing or wrapping streams', async () => {
      await exec(process.execPath, [join(__dirname, 'fixtures/nova-sonic-config.js'), version], {
        env: { ...process.env, DD_TRACE_AWS_SDK_BEDROCKRUNTIME_ENABLED: 'false' },
      })
    })

    it('keeps other AWS services enabled when Bedrock is disabled', async () => {
      const S3 = require('../../../../../../versions/@aws-sdk/client-s3@3').get()
      const s3 = new S3.S3Client({
        region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      })
      tracer.use('aws-sdk', { bedrockruntime: false })
      const request = new S3.ListBucketsCommand({})
      request.middlewareStack.add(() => async () => ({ output: { Buckets: [], $metadata: {} } }),
        { name: 'fixtureTransport', step: 'initialize', priority: 'high' })
      try {
        assert.deepEqual((await s3.send(request)).Buckets, [])
        tracer.llmobs.trace({ kind: 'workflow', name: 'sentinel' }, () => {})
        const { apmSpans, llmobsSpans } = await getEvents(1)
        assert.ok(apmSpans.some(span => span.meta['aws.operation'] === 'listBuckets'))
        assert.deepEqual(llmobsSpans.map(span => span.name), ['sentinel'])
      } finally {
        s3.destroy()
        tracer.use('aws-sdk', {})
      }
    })

    for (const bedrockruntime of [false, { enabled: false }, { llmobs: false }]) {
      for (const cacheMiddleware of [false, true]) {
        const label = `${JSON.stringify(bedrockruntime)}, cache=${cacheMiddleware}`
        it(`honors Bedrock opt-out and re-enable (${label})`, async () => {
          const records = speech()
          const outbound = records.filter(r => r.outbound)
          const transport = serializedClient(() => (async function * () {
            for (const r of records.filter(r => !r.outbound)) {
              clock.setSystemTime(EPOCH + r.at)
              yield r.value
            }
          })(), { cacheMiddleware })
          const send = () => {
            const body = { async * [Symbol.asyncIterator] () { for (const r of outbound) yield r.value } }
            return transport.send(new AWS.InvokeModelWithBidirectionalStreamCommand({ modelId: MODEL, body }))
          }
          try {
            for (const enabled of [false, true, false]) {
              tracer.use('aws-sdk', { bedrockruntime: enabled ? { service: 'sonic-service' } : bedrockruntime })
              const context = {}
              require('dc-polyfill').channel('dd-trace:aws:bedrockruntime:sonic:capture-context').publish(context)
              assert.equal(context.enabled, enabled ? true : undefined)
              await drain(await send())
              if (!enabled) tracer.llmobs.trace({ kind: 'workflow', name: 'sentinel' }, () => {})
              const { llmobsSpans, apmSpans } = await getEvents(enabled ? 4 : 1)
              const sonic = apmSpans.filter(span => span.name === 'aws.bedrockruntime.sonic')
              assert.equal(sonic.length, enabled ? 4 : 0)
              if (enabled) {
                tree(llmobsSpans)
                for (const span of sonic) assert.equal(span.service, 'sonic-service')
              } else {
                assert.deepEqual(llmobsSpans.map(span => span.name), ['sentinel'])
              }
            }
          } finally {
            transport.destroy()
            tracer.use('aws-sdk', {})
          }
        })
      }
    }

    for (const config of [
      { enabled: false, bedrockruntime: { enabled: true } },
      { llmobs: false, bedrockruntime: { llmobs: true } },
    ]) {
      it(`preserves the top-level opt-out (${JSON.stringify(config)})`, async () => {
        tracer.use('aws-sdk', config)
        try {
          const run = command(speech())
          await drain(await client.send(run.request))
          tracer.llmobs.trace({ kind: 'workflow', name: 'sentinel' }, () => {})
          const { llmobsSpans, apmSpans } = await getEvents(1)
          assert.deepEqual(llmobsSpans.map(span => span.name), ['sentinel'])
          assert.equal(apmSpans.filter(span => span.name === 'aws.bedrockruntime.sonic').length, 0)
        } finally {
          tracer.use('aws-sdk', {})
        }
      })
    }

    for (const kind of ['empty-error', 'tool-only', 'input-only', 'output-only', 'invalid-input', 'invalid-output',
      'oversized-output', 'empty-input', 'empty-output']) {
      it(`uses audio placeholders only for observed audio (${kind})`, async () => {
        const records = []
        const hasInput = kind === 'input-only' || kind === 'invalid-input' || kind === 'empty-input'
        const hasOutput = kind.endsWith('output') || kind === 'output-only'
        if (hasInput) {
          records.push(
            record('contentStart', {
              contentName: 'mic', role: 'USER', type: 'AUDIO', audioInputConfiguration: INPUT,
            }, 0, true),
            record('audioInput', {
              contentName: 'mic',
              content: kind === 'empty-input' ? '' : kind === 'invalid-input' ? 'invalid!' : pcm(100),
            }, 1, true))
        }
        if (hasOutput) {
          records.push(
            record('contentStart', {
              contentId: 'audio', role: 'ASSISTANT', type: 'AUDIO', audioOutputConfiguration: OUTPUT,
            }, 100),
            record('audioOutput', {
              contentId: 'audio',
              content: kind === 'empty-output'
                ? ''
                : kind === 'invalid-output' ? 'invalid!' : pcm(kind === 'oversized-output' ? 70_000 : 100),
            }, 110),
            record('contentEnd', { contentId: 'audio', stopReason: 'END_TURN' }, 120))
        } else if (kind !== 'empty-error') {
          records.push(
            record('contentStart', { contentId: 'tool', role: 'TOOL', type: 'TOOL' }, 100),
            record('toolUse', { contentId: 'tool', toolName: 'weather', toolUseId: 'call', content: '{}' }, 110),
            record('contentEnd', { contentId: 'tool', stopReason: 'TOOL_USE' }, 120))
        }
        const failure = new Error('stream failed')
        await assert.rejects(async () => drain(await client.send(command(records, { failure }).request)),
          error => error === failure)
        const count = kind === 'output-only' || kind === 'oversized-output' ? 3 : 2
        const { llmobsSpans } = await getEvents(count)
        const { llm } = tree(llmobsSpans)
        assert.equal(llm.meta.input.messages[0].content, hasInput && kind !== 'empty-input' ? '[audio]' : '')
        assert.equal(llm.meta.output.messages[0].content, hasOutput && kind !== 'empty-output' ? '[audio]' : '')
        assert.equal(llm.meta['error.message'], failure.message)
        if (!hasOutput && kind !== 'empty-error') {
          assert.deepEqual(llm.meta.output.messages[0].tool_calls, [{
            name: 'weather', arguments: {}, tool_id: 'call', type: 'function',
          }])
        }
        if (kind === 'invalid-output' || kind === 'oversized-output') {
          assert.equal(llm.meta.output.messages[0].audio_parts, undefined)
        }
      })
    }

    for (const kind of [
      'text-only', 'partial-text', 'empty-audio', 'partial-audio', 'audio', 'late-final', 'interrupted',
    ]) {
      it(`uses the correct response completion boundary (${kind})`, async () => {
        const records = [
          record('contentStart', { contentId: 'text', role: 'ASSISTANT', type: 'TEXT' }, 100),
          record('textOutput', { contentId: 'text', content: 'hello' }, 110),
          record('contentEnd', {
            contentId: 'text', stopReason: kind === 'partial-text' ? 'PARTIAL_TURN' : 'END_TURN',
          }, 120),
        ]
        if (kind !== 'text-only' && kind !== 'partial-text') {
          records.push(record('contentStart', {
            contentId: 'audio', role: 'ASSISTANT', type: 'AUDIO', audioOutputConfiguration: OUTPUT,
          }, 130))
          if (kind !== 'empty-audio') {
            records.push(record('audioOutput', { contentId: 'audio', content: pcm(100) }, 140))
          }
          if (kind === 'audio' || kind === 'late-final' || kind === 'interrupted') {
            records.push(record('contentEnd', {
              contentId: 'audio', stopReason: kind === 'interrupted' ? 'INTERRUPTED' : 'END_TURN',
            }, 160))
          }
          if (kind === 'late-final' || kind === 'interrupted') {
            records.push(
              record('contentStart', {
                contentId: 'final',
                role: 'ASSISTANT',
                type: 'TEXT',
                additionalModelFields: { generationStage: 'FINAL' },
              }, 170),
              record('textOutput', { contentId: 'final', content: 'hello' }, 180),
              record('contentEnd', { contentId: 'final', stopReason: 'END_TURN' }, 190))
          }
        }
        records.push(record('completionEnd', {}, 10_100))
        await drain(await client.send(command(records).request))
        const audio = !['text-only', 'partial-text', 'empty-audio'].includes(kind)
        const { llmobsSpans } = await getEvents(audio ? 3 : 2)
        const { llm, root } = tree(llmobsSpans)
        const partial = !['text-only', 'audio', 'late-final'].includes(kind)
        const end = kind === 'text-only' ? 120 : kind === 'interrupted' || !partial ? 160 : 10_100
        assert.equal(llm.start_ns + llm.duration, (EPOCH + end) * MS)
        assert.equal(llm.meta.metadata.partial, partial)
        const playbackEnd = kind === 'interrupted' ? 160 : audio ? 240 : 0
        assert.equal(root.start_ns + root.duration, (EPOCH + Math.max(end, playbackEnd)) * MS)
        assert.equal(llm.meta.output.messages[0].content, 'hello')
        assert.equal(llm.meta.input.messages[0].content, '')
      })
    }

    for (const stage of ['SPECULATIVE', 'FINAL']) {
      for (const openUser of [false, true]) {
        it(`keeps consecutive ${stage} text-only exchanges separate (open user=${openUser})`, async () => {
          const records = []
          for (let index = 0; index < 2; index++) {
            for (const role of ['USER', 'ASSISTANT']) {
              const contentId = `${role}${index}`
              const at = index * 200 + (role === 'USER' ? 0 : 100)
              records.push(
                record('contentStart', {
                  contentId, role, type: 'TEXT', additionalModelFields: { generationStage: stage },
                }, at),
                record('textOutput', { contentId, content: `${role}${index}` }, at + 10))
              if (!(openUser && index === 1 && role === 'USER')) {
                records.push(record('contentEnd', { contentId, stopReason: 'END_TURN' }, at + 20))
              }
            }
          }
          if (openUser) {
            records.push(record('contentEnd', { contentId: 'USER1', stopReason: 'END_TURN' }, 350))
            records.push(record('contentEnd', { contentId: 'USER1', stopReason: 'END_TURN' }, 360))
          }
          records.push(record('completionEnd', {}, 10_100))
          await drain(await client.send(command(records).request))
          const { llmobsSpans } = await getEvents(4)
          assert.equal(llmobsSpans.length, 4)
          for (let index = 0; index < 2; index++) {
            const { llm } = tree(llmobsSpans, index)
            assert.equal(llm.meta.input.messages[0].content, `USER${index}`)
            assert.equal(llm.meta.output.messages[0].content, `ASSISTANT${index}`)
            assert.equal(llm.start_ns + llm.duration, (EPOCH + index * 200 + 120) * MS)
            assert.equal(llm.meta.metadata.partial, false)
          }
        })
      }
    }

    for (const kind of ['audio', 'text', 'unfinished']) {
      for (const pending of ['speech', 'open-text', 'none']) {
        it(`attributes a later stream failure correctly (${kind}, pending=${pending})`, async () => {
          const records = kind === 'text'
            ? [
                record('contentStart', { contentId: 'answer', role: 'ASSISTANT', type: 'TEXT' }, 100),
                record('textOutput', { contentId: 'answer', content: 'done' }, 110),
                record('contentEnd', { contentId: 'answer', stopReason: 'END_TURN' }, 120),
              ]
            : kind === 'unfinished' ? speech().slice(0, 11) : speech()
          if (pending === 'speech') {
            records.push(
              record('userSpeechStart', { inputAudioOffsetMs: 1100 }, 4000),
              record('userSpeechEnd', { inputAudioOffsetMs: 1200 }, 4100))
          } else if (pending === 'open-text') {
            records.push(
              record('contentStart', { contentId: 'next-user', role: 'USER', type: 'TEXT' }, 4000),
              record('textOutput', { contentId: 'next-user', content: 'next question' }, 4100))
          }
          const failure = new Error('later stream failed')
          await assert.rejects(drain(await client.send(command(records, { failure }).request)), e => e === failure)
          const next = pending === 'speech' || (pending === 'open-text' && kind !== 'unfinished')
          const count = (kind === 'text' ? 2 : 4) + (next ? (pending === 'speech' ? 3 : 2) : 0)
          const { llmobsSpans } = await getEvents(count)
          const first = tree(llmobsSpans)
          for (const span of [first.root, ...first.children]) {
            assert.equal(span.status, next && kind !== 'unfinished' ? 'ok' : 'error')
          }
          if (next) {
            const second = tree(llmobsSpans, 1)
            for (const span of [second.root, ...second.children]) {
              assert.equal(span.status, 'error')
              assert.equal(span.meta['error.message'], failure.message)
            }
          }
        })
      }
    }

    for (const ending of ['END_TURN', 'INTERRUPTED', 'open']) {
      for (const fragmented of [false, true]) {
        it(`distinguishes literal interruption JSON (${ending}, fragmented=${fragmented})`, async () => {
          const records = speech({ outputMs: 2000 }).slice(0, 11)
          records.push(record('contentStart', {
            contentId: 'json', role: 'ASSISTANT', type: 'TEXT', additionalModelFields: { generationStage: 'FINAL' },
          }, 3200))
          if (fragmented) {
            records.push(record('textOutput', { contentId: 'json', content: '{"interrupted":' }, 3240))
          }
          records.push(record('textOutput', {
            contentId: 'json', content: fragmented ? 'true}' : '{"interrupted":true}',
          }, 3250))
          if (ending !== 'open') records.push(record('contentEnd', { contentId: 'json', stopReason: ending }, 3300))
          if (ending !== 'INTERRUPTED') {
            records.push(record('contentEnd', { contentId: 'audio1', stopReason: 'END_TURN' }, 3350))
          }
          records.push(record('completionEnd', {}, 6000))
          await drain(await client.send(command(records).request))
          const { llmobsSpans } = await getEvents(4)
          const { llm, children } = tree(llmobsSpans)
          const interrupted = ending === 'INTERRUPTED'
          assert.equal(llm.meta.metadata.interrupted, interrupted)
          assert.equal(llm.meta.output.messages[0].content, interrupted ? '[audio]' : '{"interrupted":true}')
          wav(llm.meta.output.messages[0].audio_parts[0], 24000, interrupted ? 12000 : 96000)
          const agent = named(children, 'agent speech')
          assert.equal(agent.start_ns + agent.duration, (EPOCH + (interrupted ? 3250 : 5000)) * MS)
        })
      }
    }

    for (const ending of ['END_TURN', 'INTERRUPTED', 'open']) {
      it(`preserves literal interruption JSON in text-only output (${ending})`, async () => {
        const records = [
          record('contentStart', { contentId: 'json', role: 'ASSISTANT', type: 'TEXT' }, 100),
          record('textOutput', { contentId: 'json', content: '{"interrupted":true}' }, 110),
        ]
        if (ending !== 'open') records.push(record('contentEnd', { contentId: 'json', stopReason: ending }, 120))
        records.push(record('completionEnd', {}, 1000))
        await drain(await client.send(command(records).request))
        const { llmobsSpans } = await getEvents(2)
        const { llm } = tree(llmobsSpans)
        assert.equal(llm.meta.output.messages[0].content, ending === 'INTERRUPTED' ? '' : '{"interrupted":true}')
        assert.equal(llm.meta.metadata.interrupted, ending === 'INTERRUPTED')
        assert.equal(llm.meta.metadata.partial, ending !== 'END_TURN')
      })
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
      const transport = serializedClient(accepted => {
        assert.deepEqual(accepted, outbound.map(r => JSON.parse(Buffer.from(r.value.chunk.bytes).toString())))
        assert.equal(closed, true)
        return (async function * () {
          for (const r of inbound) {
            clock.setSystemTime(EPOCH + r.at)
            yield r.value
          }
        })()
      })
      try {
        const request = new AWS.InvokeModelWithBidirectionalStreamCommand({ modelId: MODEL, body })
        const response = await transport.send(request)
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

    for (const model of [
      MODEL,
      `arn:aws:bedrock:us-east-1::foundation-model/${MODEL}`,
      `arn:aws-us-gov:bedrock:us-gov-west-1::foundation-model/${MODEL}`,
      `arn:aws-cn:bedrock:cn-north-1::foundation-model/${MODEL}`,
    ]) {
      it(`normalizes the captured model without changing the serialized identifier (${model})`, async () => {
        const records = speech()
        const outbound = records.filter(r => r.outbound)
        const body = (async function * () {
          for (const r of outbound) yield r.value
        })()
        const input = { modelId: model, body }
        const request = new AWS.InvokeModelWithBidirectionalStreamCommand(input)
        const transport = serializedClient(accepted => {
          assert.deepEqual(accepted, outbound.map(r => JSON.parse(r.value.chunk.bytes)))
          return (async function * () {
            for (const r of records.filter(r => !r.outbound)) {
              clock.setSystemTime(EPOCH + r.at)
              yield r.value
            }
          })()
        }, {}, model)
        try {
          await drain(await transport.send(request))
          assert.equal(request.input, input)
          assert.equal(input.modelId, model)
          const { apmSpans, llmobsSpans } = await getEvents(4)
          const { llm } = tree(llmobsSpans)
          assert.equal(llm.meta.model_name, MODEL)
          const sonicSpans = apmSpans.filter(span => span.name === 'aws.bedrockruntime.sonic')
          assert.equal(sonicSpans.length, 4)
          for (const span of sonicSpans) assert.equal(span.meta['aws.bedrock.request.model'], MODEL)
        } finally {
          transport.destroy()
        }
      })
    }

    for (const kind of ['user', 'speculative', 'final']) {
      for (const closed of [false, true]) {
        it(`preserves ${closed ? 'closed' : 'open'} ${kind} text at response rollover`, async () => {
          const first = speech()
          const contentId = kind === 'user' ? 'user1' : 'final1'
          if (kind === 'speculative') {
            first[12] = record('contentStart', {
              contentId, role: 'ASSISTANT', type: 'TEXT', additionalModelFields: { generationStage: 'SPECULATIVE' },
            }, 3060)
          }
          if (!closed) first.splice(kind === 'user' ? 8 : 14, 1)
          // Confirmed control blocks must never become transcripts at rollover.
          first.push(
            record('contentStart', {
              contentId: 'control',
              role: 'ASSISTANT',
              type: 'TEXT',
              additionalModelFields: { generationStage: 'FINAL' },
            }, 3100),
            record('textOutput', { contentId: 'control', content: '{"interrupted":true}' }, 3101),
            record('contentEnd', { contentId: 'control', stopReason: 'INTERRUPTED' }, 3102))
          const second = speech({ id: '2', offset: 1000, at: 4000 })
          // The next user's open text belongs to the new turn, not the retiring one.
          second.splice(8, 1)
          second.splice(9, 0,
            record('contentEnd', { contentId: 'user2' }, 6710),
            record('textOutput', { contentId, content: 'late text' }, 6720),
            record('contentEnd', { contentId }, 6730),
            record('contentEnd', { contentId }, 6740))
          const records = [...first, ...second, record('completionEnd', {}, 8000)]
          await drain(await client.send(command(records).request))
          const { llmobsSpans } = await getEvents(8)
          assert.equal(llmobsSpans.length, 8)
          for (let index = 0; index < 2; index++) {
            const { root, llm } = tree(llmobsSpans, index)
            assert.equal(llm.meta.input.messages[0].content, `question ${index + 1}`)
            assert.equal(llm.meta.output.messages[0].content, `answer ${index + 1}`)
            assert.equal(root.meta.input.value, `question ${index + 1}`)
            assert.equal(root.meta.output.value, `answer ${index + 1}`)
          }
        })
      }
    }

    for (const cacheMiddleware of [false, true]) {
      for (const reverse of [false, true]) {
        for (const callback of [false, true]) {
          const title = `isolates serialized sends (cache=${cacheMiddleware}, reverse=${reverse}, callback=${callback})`
          it(title, async () => {
            let iterations = 0
            const body = {
              async * [Symbol.asyncIterator] () {
                yield event('contentStart', { contentName: 'user', role: 'USER', type: 'TEXT', interactive: true })
                yield event('textInput', { contentName: 'user', content: `question ${++iterations}` })
                yield event('contentEnd', { contentName: 'user' })
              },
            }
            const input = { modelId: MODEL, body }
            const request = new AWS.InvokeModelWithBidirectionalStreamCommand(input)
            const owners = new Map()
            const expected = []
            const releases = []
            let ready
            const started = new Promise(resolve => { ready = resolve })
            let warmup = true
            const transport = serializedClient(async accepted => {
              if (warmup) return (async function * () {})()
              const owner = owners.get(tracer.scope().active())
              assert.notEqual(owner, undefined)
              const question = accepted.find(value => value.event.textInput).event.textInput.content
              expected[owner] = question
              if (owner < 2) {
                const released = new Promise(resolve => { releases[owner] = resolve })
                if (releases[0] && releases[1]) ready()
                await released
              }
              return (async function * () {
                yield event('contentStart', { contentId: 'answer', role: 'ASSISTANT', type: 'TEXT' })
                yield event('textOutput', { contentId: 'answer', content: `answer to ${question}` })
                yield event('contentEnd', { contentId: 'answer', stopReason: 'END_TURN' })
              })()
            }, { cacheMiddleware })
            const send = request => callback
              ? new Promise((resolve, reject) => {
                transport.send(request, (error, output) => error ? reject(error) : resolve(output))
              })
              : transport.send(request)
            const invoke = (id, request) => tracer.llmobs.trace({ kind: 'workflow', name: `invocation ${id}` }, () => {
              owners.set(tracer.scope().active(), id)
              return send(request)
            })
            try {
              // A handler resolved without capture must still obtain the session of later sends.
              tracer.use('aws-sdk', { llmobs: false })
              await drain(await send(request))
              tracer.use('aws-sdk', { llmobs: true })
              warmup = false
              const pending = [invoke(0, request), invoke(1, request)]
                .map(promise => promise.then(output => ({ output }), error => ({ error })))
              const both = Promise.all(pending)
              await started
              assert.equal(request.input, input, 'do not modify command input while sends are pending')
              for (const index of reverse ? [1, 0] : [0, 1]) {
                releases[index]()
                await pending[index]
              }
              const responses = await both
              for (const response of responses) assert.equal(response.error, undefined)
              await Promise.all(responses.map(response => drain(response.output)))
              // A new command of the same constructor can reuse the SDK's cached handler too.
              await drain(await invoke(2, new AWS.InvokeModelWithBidirectionalStreamCommand(input)))
              assert.equal(request.input, input)
              const { llmobsSpans } = await getEvents(9)
              const llms = llmobsSpans.filter(span => span.name === 'nova sonic response')
              assert.equal(llms.length, 3)
              assert.equal(new Set(expected).size, 3)
              for (let id = 0; id < 3; id++) {
                const parent = named(llmobsSpans, `invocation ${id}`)
                const turn = llmobsSpans.find(span => span.parent_id === parent.span_id)
                const llm = llms.find(span => span.parent_id === turn.span_id)
                assert.equal(llm.meta.input.messages[0].content, expected[id])
                assert.equal(llm.meta.output.messages[0].content, `answer to ${expected[id]}`)
              }
            } finally {
              tracer.use('aws-sdk', { llmobs: true })
              transport.destroy()
            }
          })
        }
      }
    }

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
            assert.equal(responses.reduce((n, s) => n + s.metrics[`${direction}_text_tokens`], 0),
              lastUsage.details.total[direction].textTokens)
            for (const response of responses) {
              assert.equal(response.metrics[`${direction}_text_tokens`] + response.metrics[`${direction}_audio_tokens`],
                response.metrics[`${direction}_tokens`])
            }
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
            request.middlewareStack.add(() => async args => {
              const id = releases.length
              await new Promise(resolve => releases.push(resolve))
              for await (const chunk of args.input.body) {
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

    for (const model of [
      'amazon.nova-sonic-v1:0',
      'amazon.nova-2-5-sonic',
      'amazon.nova-2-sonic-v2:0',
      `us.${MODEL}`,
      `global.${MODEL}`,
      'arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-2-5-sonic',
      `arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/${MODEL}`,
      `arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.${MODEL}`,
      `arn:aws:bedrock:us-east-1:123456789012:custom-model/${MODEL}`,
      `arn:aws:bedrock:us-east-1:123456789012:foundation-model/${MODEL}`,
      `arn:aws:sagemaker:us-east-1::foundation-model/${MODEL}`,
      `arn:aws:bedrock:::foundation-model/${MODEL}`,
      `prefix:arn:aws:bedrock:us-east-1::foundation-model/${MODEL}`,
      `arn:aws:bedrock:us-east-1::foundation-model/${MODEL}/extra`,
      `arn:aws:bedrock:us-east-1::foundation-model/${MODEL}\n`,
      `arn:aws:bedrock:us-east-1::foundation-model/${'x'.repeat(2048)}`,
      undefined, null, 42, {},
    ]) {
      it(`passes through unsupported or malformed model identifiers (${JSON.stringify(model)})`, async () => {
        const run = command(speech())
        run.request.input.modelId = model
        const input = run.request.input
        const response = await client.send(run.request)
        assert.deepEqual(await drain(response), speech().filter(r => !r.outbound).map(r => r.value))
        assert.equal(run.request.input, input)
        assert.equal(input.modelId, model)
        tracer.llmobs.trace({ kind: 'workflow', name: 'sentinel' }, () => {})
        const { llmobsSpans } = await getEvents(1)
        assert.deepEqual(llmobsSpans.map(span => span.name), ['sentinel'])
      })
    }

    for (const mode of ['disabled', 'disabled-arn', 'original-model']) {
      it(`passes through unchanged when ${mode}`, async () => {
        if (mode.startsWith('disabled')) tracer.use('aws-sdk', { llmobs: false })
        try {
          const model = mode === 'original-model'
            ? 'amazon.nova-sonic-v1:0'
            : mode === 'disabled-arn' ? `arn:aws:bedrock:us-east-1::foundation-model/${MODEL}` : MODEL
          const run = command(speech(), { model })
          const original = run.request.input
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

    it('captures frozen commands and input without modifying either', async () => {
      const run = command(speech())
      Object.freeze(run.request.input)
      Object.freeze(run.request)
      await drain(await client.send(run.request))
      assert.equal(run.request.input.body, run.body)
      const { llm } = tree((await getEvents(4)).llmobsSpans)
      assert.equal(llm.meta.input.messages[0].content, 'question 1')
    })

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
