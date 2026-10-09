'use strict'

const assert = require('node:assert/strict')
const { once } = require('node:events')
const { createServer } = require('node:http2')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { EPOCH, MODEL, event } = require('../../../../../datadog-instrumentations/test/nova-sonic/helpers')
const { useLlmObs } = require('../../util')
const { withVersions } = require('../../../setup/mocha')

withVersions('aws-sdk', '@aws-sdk/client-bedrock-runtime', '>=3.785.0', version => {
  describe(`Nova Sonic cancellation through HTTP/2 (${version})`, () => {
    const { getEvents } = useLlmObs({ plugin: 'aws-sdk' })
    let clock
    let server
    let client
    let AWS
    let dependencies
    const sessions = new Set()

    beforeEach(async () => {
      clock = sinon.useFakeTimers({ now: EPOCH, toFake: ['Date'] })
      dependencies = require(`../../../../../../versions/@aws-sdk/client-bedrock-runtime@${version}`)
      AWS = dependencies.get()
      const { NodeHttp2Handler } = dependencies.get('@smithy/node-http-handler')
      server = createServer()
      server.on('session', session => {
        sessions.add(session)
        session.once('close', () => sessions.delete(session))
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      client = new AWS.BedrockRuntimeClient({
        region: 'us-east-1',
        credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        endpoint: `http://127.0.0.1:${server.address().port}`,
        requestHandler: new NodeHttp2Handler(),
      })
    })

    afterEach(async () => {
      client.destroy()
      for (const session of sessions) session.destroy()
      await new Promise(resolve => server.close(resolve))
      clock.restore()
    })

    for (const legacy of [false, true]) {
      for (const callback of [false, true]) {
        for (const phase of ['complete', 'preaborted', 'pending', 'streaming']) {
          it(`preserves cancellation (legacy=${legacy}, callback=${callback}, phase=${phase})`, async () => {
            const Controller = legacy ? dependencies.get('@smithy/abort-controller').AbortController : AbortController
            const controller = new Controller()
            const { EventStreamCodec } = dependencies.get('@smithy/eventstream-codec')
            const codec = new EventStreamCodec(bytes => Buffer.from(bytes).toString(), text => Buffer.from(text))
            const output = [
              event('contentStart', { contentId: 'answer', role: 'ASSISTANT', type: 'TEXT' }),
              event('textOutput', { contentId: 'answer', content: 'partial answer' }),
            ]
            server.on('stream', stream => {
              stream.resume()
              if (phase === 'pending') return
              stream.respond({ ':status': 200, 'content-type': 'application/vnd.amazon.eventstream' })
              for (const value of output) {
                stream.write(codec.encode({
                  headers: {
                    ':message-type': { type: 'string', value: 'event' },
                    ':event-type': { type: 'string', value: 'chunk' },
                    ':content-type': { type: 'string', value: 'application/json' },
                  },
                  body: Buffer.from(JSON.stringify({ bytes: Buffer.from(value.chunk.bytes).toString('base64') })),
                }))
              }
              if (phase === 'complete') stream.end()
            })
            if (phase === 'preaborted') controller.abort()
            const request = new AWS.InvokeModelWithBidirectionalStreamCommand({
              modelId: MODEL, body: { async * [Symbol.asyncIterator] () {} },
            })
            const reached = phase === 'pending' ? once(server, 'stream') : undefined
            const result = callback
              ? new Promise((resolve, reject) => {
                client.send(request, { abortSignal: controller.signal },
                  (error, output) => error ? reject(error) : resolve(output))
              })
              : client.send(request, { abortSignal: controller.signal })
            if (phase === 'preaborted' || phase === 'pending') {
              const rejected = assert.rejects(result, { name: 'AbortError', message: 'Request aborted' })
              if (reached) {
                await reached
                controller.abort()
              }
              await rejected
            } else {
              const response = await result
              const iterator = response.body[Symbol.asyncIterator]()
              for (const value of output) {
                assert.deepEqual((await iterator.next()).value, { chunk: { bytes: new Uint8Array(value.chunk.bytes) } })
              }
              if (phase === 'streaming') controller.abort()
              assert.equal((await iterator.next()).done, true)
              if (phase === 'complete') controller.abort()
            }
            const { llmobsSpans } = await getEvents(2)
            assert.equal(llmobsSpans.length, 2, 'flush the partial turn exactly once')
            const llm = llmobsSpans.find(span => span.name === 'nova sonic response')
            assert.equal(llm.status, phase === 'complete' ? 'ok' : 'error')
            if (phase !== 'complete') assert.equal(llm.meta['error.type'], 'AbortError')
            if (phase === 'complete' || phase === 'streaming') {
              assert.equal(llm.meta.output.messages[0].content, 'partial answer')
            }
          })
        }
      }
    }
  })
})
