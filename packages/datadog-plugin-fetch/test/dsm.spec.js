'use strict'

const assert = require('node:assert/strict')

const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { storage } = require('../../datadog-core')
const { DsmPathwayCodec } = require('../../dd-trace/src/datastreams/pathway')
const { DataStreamsProcessor } = require('../../dd-trace/src/datastreams/processor')
const agent = require('../../dd-trace/test/plugins/agent')

const DSM_HEADER = 'dd-pathway-ctx-base64'

// Pathway hashes computed with dd-trace-java's own FNV64Hash, BaseHash and DataStreamsTags classes (compiled with
// stubbed configuration) for env `test`, with process tags off and no primary tag. The specs turn process tags off,
// because their serialized value depends on the entrypoint and the working directory.
const JAVA = {
  serviceAHttpOutRoot: '11849898521937609503',
  serviceBHttpInRoot: '11375375775841093325',
  serviceBHttpInFromServiceA: '11291553564431990061',
  serviceBHttpOutAfterHttpIn: '1707038938570633554',
}

// JAVA.serviceAHttpOutRoot with pathway start 1794500000000 ms and edge start 1794500000250 ms, encoded with ddsketch's
// VarEncodingHelper as dd-trace-java's DefaultPathwayContext.encode does.
const JAVA_HEADER = 'H4OEGOxLc6SA5MeIumj058eIumg='
const JAVA_PATHWAY_START_NS = 1794500000000 * 1e6

describe('Plugin', () => {
  describe('fetch', () => {
    describe('data streams monitoring', () => {
      let http
      let recordCheckpoint
      let servers
      let downstreamHeaders

      function listen (handler) {
        const server = http.createServer(handler)
        servers.push(server)
        return new Promise(resolve => {
          server.listen(0, 'localhost', () => resolve(server.address().port))
        })
      }

      async function fetch (port, headers) {
        const response = await globalThis.fetch(`http://localhost:${port}/`, { headers })
        await response.arrayBuffer()
      }

      // Sends the request the way the tracer sends its own intake requests, so only the server checkpoints.
      function getUntraced (port, headers) {
        return storage('legacy').run({ noop: true }, () => new Promise((resolve, reject) => {
          http.get({ host: 'localhost', port, headers }, res => {
            res.resume()
            res.on('end', resolve)
          }).on('error', reject)
        }))
      }

      async function startChain () {
        const downstreamPort = await listen((req, res) => {
          downstreamHeaders = req.headers
          res.end()
        })
        return listen(async (req, res) => {
          await fetch(downstreamPort)
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

      function decodedHeader (headers) {
        assert.ok(headers?.[DSM_HEADER], `${DSM_HEADER} header missing`)
        return DsmPathwayCodec.decode(headers)
      }

      function hashOf (buffer) {
        return buffer.readBigUInt64LE().toString()
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
      })

      afterEach(async () => {
        recordCheckpoint?.restore()
        recordCheckpoint = undefined
        await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
        await agent.close()
        delete process.env.DD_DATA_STREAMS_ENABLED
        delete process.env.DD_DATA_STREAMS_HTTP_ENABLED
        delete process.env.DD_EXPERIMENTAL_PROPAGATE_PROCESS_TAGS_ENABLED
      })

      describe('when enabled', () => {
        async function load (service) {
          process.env.DD_DATA_STREAMS_ENABLED = 'true'
          await agent.load(['http', 'fetch'], {}, { service, env: 'test' })
          http = require('node:http')
          recordCheckpoint = sinon.spy(DataStreamsProcessor.prototype, 'recordCheckpoint')
        }

        it('records one out checkpoint per request and injects it', async () => {
          await load('service-a')
          const port = await listen((req, res) => {
            downstreamHeaders = req.headers
            res.end()
          })

          await fetch(port)

          const outs = checkpoints('out', 1)
          const ins = checkpoints('in', 1)
          assert.deepStrictEqual(outs[0].edgeTags, ['direction:out', 'type:http'])
          assert.strictEqual(hashOf(outs[0].parentHash), '0')
          assert.strictEqual(hashOf(outs[0].hash), JAVA.serviceAHttpOutRoot)
          assert.strictEqual(hashOf(decodedHeader(downstreamHeaders).hash), JAVA.serviceAHttpOutRoot)
          assert.strictEqual(hashOf(ins[0].parentHash), JAVA.serviceAHttpOutRoot)
        })

        it('parents a handler fetch on a server checkpoint from a dd-trace-java pathway', async () => {
          await load('service-b')
          const port = await startChain()

          await getUntraced(port, { [DSM_HEADER]: JAVA_HEADER })

          const [serverIn] = checkpoints('in', 2)
          const outs = checkpoints('out', 1)
          assert.strictEqual(hashOf(serverIn.parentHash), JAVA.serviceAHttpOutRoot)
          assert.strictEqual(hashOf(outs[0].parentHash), JAVA.serviceBHttpInFromServiceA)
          assert.strictEqual(decodedHeader(downstreamHeaders).pathwayStartNs, JAVA_PATHWAY_START_NS)
        })

        it('chains a handler fetch from the server checkpoint and measures edge latency per hop', async () => {
          await load('service-b')
          const port = await startChain()
          const pathwayStartNs = (Date.now() - 60_000) * 1e6

          await getUntraced(port, {
            [DSM_HEADER]: headerFor(JAVA.serviceAHttpOutRoot, pathwayStartNs, pathwayStartNs),
          })

          const [serverIn, downstreamIn] = checkpoints('in', 2)
          const [out] = checkpoints('out', 1)
          assert.strictEqual(hashOf(out.parentHash), JAVA.serviceBHttpInFromServiceA)
          assert.strictEqual(hashOf(out.hash), JAVA.serviceBHttpOutAfterHttpIn)
          assert.strictEqual(hashOf(downstreamIn.parentHash), JAVA.serviceBHttpOutAfterHttpIn)
          assert.strictEqual(out.edgeLatencyNs, out.currentTimestamp - serverIn.currentTimestamp)
          assert.strictEqual(out.pathwayLatencyNs, out.currentTimestamp - pathwayStartNs)
          assert.ok(out.edgeLatencyNs < out.pathwayLatencyNs)
        })

        it('replaces a pathway header the caller forwards', async () => {
          await load('service-a')
          const port = await listen((req, res) => {
            downstreamHeaders = req.headers
            res.end()
          })
          const now = Date.now() * 1e6

          await fetch(port, { [DSM_HEADER]: headerFor(JAVA.serviceBHttpInRoot, now, now) })

          const [out] = checkpoints('out', 1)
          assert.strictEqual(hashOf(out.parentHash), '0')
          assert.doesNotMatch(downstreamHeaders[DSM_HEADER], /,/)
          assert.strictEqual(hashOf(decodedHeader(downstreamHeaders).hash), JAVA.serviceAHttpOutRoot)
        })

        it('leaves AWS SDK requests without a checkpoint or pathway header', async () => {
          await load('service-a')
          const received = []
          const port = await listen((req, res) => {
            received.push(req.headers)
            res.end()
          })

          await fetch(port, { 'amz-sdk-invocation-id': '6c2c0b0e-2c79-4d45-9d3b-6f3c4c8b1a2e' })
          await fetch(port)

          checkpoints('out', 1)
          assert.strictEqual(received[0][DSM_HEADER], undefined)
          assert.ok(received[0]['x-datadog-trace-id'], 'trace headers missing')
          assert.ok(received[1][DSM_HEADER], 'pathway header missing')
        })

        describe('with DD_DATA_STREAMS_HTTP_ENABLED=false', () => {
          beforeEach(() => {
            process.env.DD_DATA_STREAMS_HTTP_ENABLED = 'false'
            return load('service-a')
          })

          it('records no checkpoint and injects no pathway header', async () => {
            const port = await listen((req, res) => {
              downstreamHeaders = req.headers
              res.end()
            })

            await fetch(port)

            assert.strictEqual(recordCheckpoint.callCount, 0)
            assert.ok(downstreamHeaders['x-datadog-trace-id'])
            assert.strictEqual(downstreamHeaders[DSM_HEADER], undefined)
          })
        })
      })

      describe('when disabled', () => {
        let setCheckpoint

        beforeEach(async () => {
          await agent.load(['http', 'fetch'], {}, { service: 'service-a', env: 'test' })
          http = require('node:http')
          setCheckpoint = sinon.spy(DataStreamsProcessor.prototype, 'setCheckpoint')
        })

        afterEach(() => {
          setCheckpoint.restore()
        })

        it('records no checkpoints and injects no pathway header', async () => {
          const port = await startChain()

          await getUntraced(port, { [DSM_HEADER]: JAVA_HEADER })

          assert.strictEqual(setCheckpoint.callCount, 0)
          assert.ok(downstreamHeaders)
          assert.strictEqual(downstreamHeaders[DSM_HEADER], undefined)
        })
      })
    })
  })
})
