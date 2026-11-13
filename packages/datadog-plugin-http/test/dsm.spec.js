'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { storage } = require('../../datadog-core')
const { DsmPathwayCodec } = require('../../dd-trace/src/datastreams/pathway')
const { DataStreamsProcessor } = require('../../dd-trace/src/datastreams/processor')
const agent = require('../../dd-trace/test/plugins/agent')
const { withVersions } = require('../../dd-trace/test/setup/mocha')

const DSM_HEADER = 'dd-pathway-ctx-base64'
const TLS = {
  key: fs.readFileSync(path.join(__dirname, 'ssl', 'test.key')),
  cert: fs.readFileSync(path.join(__dirname, 'ssl', 'test.crt')),
}

// Pathway hashes computed with dd-trace-java's own FNV64Hash, BaseHash and DataStreamsTags classes (compiled with
// stubbed configuration) for env `test`, with process tags off and no primary tag. The specs turn process tags off,
// because their serialized value depends on the entrypoint and the working directory.
const JAVA = {
  serviceAHttpOutRoot: '11849898521937609503',
  serviceBHttpInFromServiceA: '11291553564431990061',
  serviceBKafkaOutAfterHttpIn: '6144316448857745107',
  serviceBHttpOutAfterHttpIn: '1707038938570633554',
  serviceBHttpInRoot: '11375375775841093325',
}

// JAVA.serviceAHttpOutRoot with pathway start 1794500000000 ms and edge start 1794500000250 ms, encoded with ddsketch's
// VarEncodingHelper as dd-trace-java's DefaultPathwayContext.encode does.
const JAVA_HEADER = 'H4OEGOxLc6SA5MeIumj058eIumg='
const JAVA_PATHWAY_START_NS = 1794500000000 * 1e6

describe('Plugin', () => {
  describe('http', () => {
    describe('data streams monitoring', () => {
      let http
      let tracer
      let recordCheckpoint
      let servers
      let downstreamHeaders
      let handlerContext

      function listen (handler, server = http.createServer(handler)) {
        servers.push(server)
        return new Promise(resolve => {
          server.listen(0, 'localhost', () => resolve(server.address().port))
        })
      }

      function get (port, headers, path = '/', client = http) {
        return new Promise((resolve, reject) => {
          client.get({ host: 'localhost', port, path, headers, rejectUnauthorized: false }, res => {
            res.resume()
            res.on('end', resolve)
          }).on('error', reject)
        })
      }

      // Runs the request the way the tracer runs its own intake requests, so only the server checkpoints.
      function getUntraced (port, headers) {
        return storage('legacy').run({ noop: true }, () => get(port, headers))
      }

      async function startChain () {
        const downstreamPort = await listen((req, res) => {
          downstreamHeaders = req.headers
          res.end()
        })
        return listen(async (req, res) => {
          await get(downstreamPort)
          handlerContext = storage('legacy').getStore()?.dataStreamsContext
          res.end()
        })
      }

      /**
       * @param {'in' | 'out'} direction
       * @param {number} count
       */
      function checkpoints (direction, count) {
        const recorded = recordCheckpoint.args.map(([checkpoint]) => checkpoint)
          .filter(checkpoint => checkpoint.edgeTags.includes(`direction:${direction}`))
        assert.strictEqual(recorded.length, count, `${direction} checkpoints`)
        return recorded
      }

      function hashOf (buffer) {
        return buffer.readBigUInt64LE().toString()
      }

      function decodedHeader (headers) {
        assert.ok(headers?.[DSM_HEADER], `${DSM_HEADER} header missing`)
        return DsmPathwayCodec.decode(headers)
      }

      function headerFor (hash, pathwayStartNs, edgeStartNs) {
        const buffer = Buffer.alloc(8)
        buffer.writeBigUInt64LE(BigInt(hash))
        return DsmPathwayCodec.encode({ hash: buffer, pathwayStartNs, edgeStartNs })[DSM_HEADER]
      }

      beforeEach(() => {
        process.env.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED = 'false'
        servers = []
        downstreamHeaders = undefined
        handlerContext = undefined
      })

      afterEach(async () => {
        recordCheckpoint?.restore()
        recordCheckpoint = undefined
        // Clients keep connections alive, and before Node.js 19 server.close() waits for them.
        for (const server of servers) server.closeAllConnections?.()
        await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
        await agent.close()
        delete process.env.DD_DATA_STREAMS_ENABLED
        delete process.env.DD_DATA_STREAMS_HTTP_ENABLED
        delete process.env.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED
      })

      describe('when enabled', () => {
        async function load (service, pluginConfig = {}) {
          process.env.DD_DATA_STREAMS_ENABLED = 'true'
          tracer = await agent.load('http', pluginConfig, { service, env: 'test' })
          http = require('node:http')
          recordCheckpoint = sinon.spy(DataStreamsProcessor.prototype, 'recordCheckpoint')
        }

        describe('as service-a', () => {
          beforeEach(() => load('service-a'))

          it('starts a pathway with an out checkpoint and injects it into the request', async () => {
            const port = await listen((req, res) => {
              downstreamHeaders = req.headers
              res.end()
            })

            await get(port)

            const [out] = checkpoints('out', 1)
            assert.deepStrictEqual(out.edgeTags, ['direction:out', 'type:http'])
            assert.strictEqual(hashOf(out.parentHash), '0')
            assert.strictEqual(hashOf(out.hash), JAVA.serviceAHttpOutRoot)
            assert.strictEqual(out.payloadSize, 0)
            assert.strictEqual(hashOf(decodedHeader(downstreamHeaders).hash), JAVA.serviceAHttpOutRoot)
          })

          it('chains a request over https', async () => {
            const https = require('node:https')
            const port = await listen(undefined, https.createServer(TLS, (req, res) => {
              downstreamHeaders = req.headers
              res.end()
            }))

            await get(port, undefined, '/', https)

            const [out] = checkpoints('out', 1)
            const [serverIn] = checkpoints('in', 1)
            assert.strictEqual(hashOf(out.hash), JAVA.serviceAHttpOutRoot)
            assert.strictEqual(hashOf(serverIn.parentHash), JAVA.serviceAHttpOutRoot)
            assert.strictEqual(hashOf(decodedHeader(downstreamHeaders).hash), JAVA.serviceAHttpOutRoot)
          })

          it('replaces a pathway header the caller forwards', async () => {
            const port = await listen((req, res) => {
              downstreamHeaders = req.headers
              res.end()
            })

            const now = Date.now() * 1e6
            await get(port, { [DSM_HEADER]: headerFor(JAVA.serviceBHttpInRoot, now, now) })

            const [out] = checkpoints('out', 1)
            assert.strictEqual(hashOf(out.parentHash), '0')
            assert.doesNotMatch(downstreamHeaders[DSM_HEADER], /,/)
            assert.strictEqual(hashOf(decodedHeader(downstreamHeaders).hash), JAVA.serviceAHttpOutRoot)
          })

          it('leaves AWS SDK requests without a checkpoint or pathway header', async () => {
            const received = []
            const port = await listen((req, res) => {
              received.push(req.headers)
              res.end()
            })

            await get(port, { 'amz-sdk-invocation-id': '6c2c0b0e-2c79-4d45-9d3b-6f3c4c8b1a2e' })
            await get(port)

            checkpoints('out', 1)
            assert.strictEqual(received[0][DSM_HEADER], undefined)
            assert.ok(received[0]['x-datadog-trace-id'], 'trace headers missing')
            assert.ok(received[1][DSM_HEADER], 'pathway header missing')
          })
        })

        describe('as service-b', () => {
          beforeEach(() => load('service-b'))

          it('parents the server checkpoint on a dd-trace-java pathway and keeps its start time', async () => {
            const port = await startChain()

            await getUntraced(port, { [DSM_HEADER]: JAVA_HEADER })

            const [serverIn] = checkpoints('in', 2)
            assert.deepStrictEqual(serverIn.edgeTags, ['direction:in', 'type:http'])
            assert.strictEqual(hashOf(serverIn.parentHash), JAVA.serviceAHttpOutRoot)
            assert.strictEqual(hashOf(serverIn.hash), JAVA.serviceBHttpInFromServiceA)
            assert.strictEqual(serverIn.currentTimestamp - serverIn.pathwayLatencyNs, JAVA_PATHWAY_START_NS)
            assert.strictEqual(decodedHeader(downstreamHeaders).pathwayStartNs, JAVA_PATHWAY_START_NS)
          })

          it('chains a handler out checkpoint from the server checkpoint and leaves the handler context', async () => {
            const port = await startChain()

            await getUntraced(port, { [DSM_HEADER]: JAVA_HEADER })

            const [serverIn, downstreamIn] = checkpoints('in', 2)
            const [out] = checkpoints('out', 1)
            assert.strictEqual(hashOf(serverIn.hash), JAVA.serviceBHttpInFromServiceA)
            assert.strictEqual(hashOf(out.parentHash), JAVA.serviceBHttpInFromServiceA)
            assert.strictEqual(hashOf(out.hash), JAVA.serviceBHttpOutAfterHttpIn)
            assert.strictEqual(hashOf(downstreamIn.parentHash), JAVA.serviceBHttpOutAfterHttpIn)
            assert.ok(handlerContext, 'handler has no data streams context')
            assert.strictEqual(hashOf(handlerContext.hash), JAVA.serviceBHttpInFromServiceA)
          })

          it('tags the server and client spans with their pathway hashes', async () => {
            // An untraced downstream keeps the server and client spans in one trace payload.
            const downstreamPort = await listen(undefined, net.createServer(socket => {
              socket.once('data', () => socket.end('HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n'))
            }))
            const port = await listen(async (req, res) => {
              await get(downstreamPort)
              res.end()
            })
            const tracesReceived = agent.assertSomeTraces(traces => {
              const spans = traces.flat()
              const server = spans.find(span => span.meta['span.kind'] === 'server' && String(span.parent_id) === '0')
              const client = spans.find(span => span.meta['span.kind'] === 'client')
              assert.ok(server, 'server span missing')
              assert.ok(client, 'client span missing')
              assert.strictEqual(server.meta['pathway.hash'], JAVA.serviceBHttpInFromServiceA)
              assert.strictEqual(client.meta['pathway.hash'], JAVA.serviceBHttpOutAfterHttpIn)
            })

            await Promise.all([tracesReceived, getUntraced(port, { [DSM_HEADER]: JAVA_HEADER })])
          })

          it('records one server checkpoint when a request is dispatched to a second server', async () => {
            const inner = http.createServer((req, res) => res.end())
            const port = await listen((req, res) => inner.emit('request', req, res))

            await getUntraced(port, { [DSM_HEADER]: JAVA_HEADER })

            const [serverIn] = checkpoints('in', 1)
            assert.strictEqual(hashOf(serverIn.hash), JAVA.serviceBHttpInFromServiceA)
          })

          it('sends the server checkpoint and a queue checkpoint chained from it to the agent', async () => {
            const port = await listen((req, res) => {
              tracer.dataStreamsCheckpointer.setProduceCheckpoint('kafka', 'T', {})
              res.end()
            })
            const statsReceived = agent.expectPipelineStats(dsmStats => {
              const points = dsmStats.flatMap(({ Stats }) => Stats.flatMap(bucket => bucket.Stats))
              const produce = points.find(point => point.EdgeTags.includes('type:kafka'))
              assert.ok(produce, 'kafka checkpoint missing')
              assert.strictEqual(produce.ParentHash.toString(), JAVA.serviceBHttpInFromServiceA)
              assert.strictEqual(produce.Hash.toString(), JAVA.serviceBKafkaOutAfterHttpIn)
              const serverIn = points.find(point => point.Hash.toString() === JAVA.serviceBHttpInFromServiceA)
              assert.ok(serverIn, 'http in checkpoint missing')
              assert.deepStrictEqual(serverIn.EdgeTags, ['direction:in', 'type:http'])
              assert.strictEqual(serverIn.ParentHash.toString(), JAVA.serviceAHttpOutRoot)
            }, { timeoutMs: 2000 })

            await Promise.all([statsReceived, getUntraced(port, { [DSM_HEADER]: JAVA_HEADER })])
          })

          it('parents concurrent requests from one handler on the handler context', async () => {
            const setCheckpoint = sinon.spy(DataStreamsProcessor.prototype, 'setCheckpoint')
            try {
              const downstreamPort = await listen((req, res) => res.end())
              const port = await listen(async (req, res) => {
                await Promise.all([get(downstreamPort), get(downstreamPort)])
                res.end()
              })

              await getUntraced(port)

              const calls = setCheckpoint.getCalls()
              const outs = calls.filter(call => call.args[0].includes('direction:out'))
              assert.strictEqual(outs.length, 2)
              const serverIn = calls.find(call => call.args[0].includes('direction:in'))
              assert.ok(serverIn, 'server checkpoint missing')
              for (const out of outs) {
                assert.strictEqual(out.args[2], serverIn.returnValue)
              }
            } finally {
              setCheckpoint.restore()
            }
          })

          it('starts a pathway at a server request without a pathway header', async () => {
            const port = await listen((req, res) => res.end())

            await getUntraced(port)

            const [serverIn] = checkpoints('in', 1)
            assert.strictEqual(hashOf(serverIn.parentHash), '0')
            assert.strictEqual(hashOf(serverIn.hash), JAVA.serviceBHttpInRoot)
            checkpoints('out', 0)
          })

          it('measures edge latency per hop', async () => {
            const port = await startChain()
            const pathwayStartNs = (Date.now() - 60_000) * 1e6

            await getUntraced(port, {
              [DSM_HEADER]: headerFor(JAVA.serviceAHttpOutRoot, pathwayStartNs, pathwayStartNs),
            })

            const [serverIn, downstreamIn] = checkpoints('in', 2)
            const [out] = checkpoints('out', 1)
            assert.strictEqual(serverIn.edgeLatencyNs, serverIn.currentTimestamp - pathwayStartNs)
            assert.strictEqual(out.edgeLatencyNs, out.currentTimestamp - serverIn.currentTimestamp)
            assert.strictEqual(downstreamIn.edgeLatencyNs, downstreamIn.currentTimestamp - out.currentTimestamp)
            assert.strictEqual(downstreamIn.pathwayLatencyNs, downstreamIn.currentTimestamp - pathwayStartNs)
            assert.ok(downstreamIn.edgeLatencyNs < downstreamIn.pathwayLatencyNs)
          })
        })

        for (const [name, client] of [
          ['propagationBlocklist', { propagationBlocklist: [/\/skipped/] }],
          ['blocklist', { blocklist: [/\/skipped/] }],
        ]) {
          describe(`with a matching ${name}`, () => {
            beforeEach(() => load('service-a', { client }))

            it('records no out checkpoint and injects no pathway header for the matching URL only', async () => {
              const received = []
              const port = await listen((req, res) => {
                received.push(req.headers)
                res.end()
              })

              await get(port, undefined, '/allowed')
              await get(port, undefined, '/skipped')

              checkpoints('out', 1)
              assert.ok(received[0][DSM_HEADER], 'allowed request has no pathway header')
              assert.strictEqual(received[1][DSM_HEADER], undefined)
            })
          })
        }

        describe('with DD_DATA_STREAMS_HTTP_ENABLED=false', () => {
          beforeEach(() => {
            process.env.DD_DATA_STREAMS_HTTP_ENABLED = 'false'
            return load('service-b')
          })

          it('leaves queue checkpoints in a handler unparented and skips http checkpoints and headers', async () => {
            const downstreamPort = await listen((req, res) => {
              downstreamHeaders = req.headers
              res.end()
            })
            const port = await listen(async (req, res) => {
              tracer.dataStreamsCheckpointer.setProduceCheckpoint('kafka', 'T', {})
              await get(downstreamPort)
              res.end()
            })

            await getUntraced(port, { [DSM_HEADER]: JAVA_HEADER })

            const recorded = recordCheckpoint.args.map(([checkpoint]) => checkpoint)
            assert.strictEqual(recorded.length, 1)
            assert.ok(recorded[0].edgeTags.includes('type:kafka'))
            assert.strictEqual(hashOf(recorded[0].parentHash), '0')
            assert.ok(downstreamHeaders['x-datadog-trace-id'], 'trace headers missing')
            assert.strictEqual(downstreamHeaders[DSM_HEADER], undefined)
          })
        })

        describe('with axios', () => {
          withVersions('http', 'axios', version => {
            let axios

            beforeEach(async () => {
              await load('service-a')
              axios = require(`../../../versions/axios@${version}`).get()
            })

            it('records one out checkpoint per request', async () => {
              const port = await listen((req, res) => res.end())

              await axios.get(`http://localhost:${port}/`)

              const [out] = checkpoints('out', 1)
              const [serverIn] = checkpoints('in', 1)
              assert.strictEqual(hashOf(out.hash), JAVA.serviceAHttpOutRoot)
              assert.strictEqual(hashOf(serverIn.parentHash), JAVA.serviceAHttpOutRoot)
            })
          })
        })
      })

      describe('when disabled', () => {
        let setCheckpoint

        beforeEach(async () => {
          await agent.load('http', {}, { service: 'service-a', env: 'test' })
          http = require('node:http')
          setCheckpoint = sinon.spy(DataStreamsProcessor.prototype, 'setCheckpoint')
        })

        afterEach(() => {
          setCheckpoint.restore()
        })

        it('records no checkpoints and injects no pathway header', async () => {
          const port = await startChain()

          await get(port, { [DSM_HEADER]: JAVA_HEADER })

          assert.strictEqual(setCheckpoint.callCount, 0)
          assert.ok(downstreamHeaders)
          assert.strictEqual(downstreamHeaders[DSM_HEADER], undefined)
        })
      })
    })
  })
})
