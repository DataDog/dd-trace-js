'use strict'

// Wire-level regression for binary payload capture isolation. A local HTTP
// server stands in for S3 so the assertion can check the exact bytes that leave
// the process: a payload-controlled `slice`, `Symbol.species`, or metadata
// property must never change what the SDK sends or mutate the caller's bytes,
// whether or not payload capture is enabled.

const assert = require('node:assert/strict')
const http = require('node:http')

const { after, before, describe, it } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')
const { callViaCallback, setup } = require('./spec_helpers')

const bodyBytes = [97, 98, 99] // 'abc'

/**
 * One binary-body scenario. `makeBody` builds a fresh caller-owned body per
 * test and returns a hook that asserts payload-defined copy behavior was never
 * invoked.
 */
const cases = [
  {
    name: 'ordinary Uint8Array control',
    makeBody () {
      return { body: new Uint8Array(bodyBytes), assertHooks () {} }
    },
  },
  {
    name: 'shared-view slice override',
    makeBody () {
      const body = new Uint8Array(bodyBytes)
      let calls = 0
      Object.defineProperty(body, 'slice', {
        value () {
          calls++
          return this.subarray()
        },
      })
      return {
        body,
        assertHooks () {
          assert.strictEqual(calls, 0)
        },
      }
    },
  },
  {
    name: 'shared-storage species override',
    makeBody () {
      const body = new Uint8Array(bodyBytes)
      let calls = 0
      Object.defineProperty(body, 'constructor', {
        value: {
          [Symbol.species]: function () {
            calls++
            return new Uint8Array(body.buffer)
          },
        },
      })
      return {
        body,
        assertHooks () {
          assert.strictEqual(calls, 0)
        },
      }
    },
  },
]

/**
 * Bucket names must be valid S3 names and unique per test so span resource
 * matching cannot accept a stale span from a previous case.
 *
 * @param {string} prefix
 * @param {string} name
 */
function bucketFor (prefix, name) {
  return `${prefix}-${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`.slice(0, 63).replace(/-$/, '')
}

describe('Plugin', () => {
  describe('aws-sdk (s3 binary payload tagging)', function () {
    setup()
    this.timeout(30000)

    /** @type {Map<string, Buffer>} */
    const received = new Map()
    const server = http.createServer((req, res) => {
      // Path-style addressing: /<bucket>/<key>
      const bucket = (req.url ?? '').split('/')[1]
      /** @type {Buffer[]} */
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        received.set(bucket, Buffer.concat(chunks))
        res.writeHead(200, { etag: '"d41d8cd98f00b204e9800998ecf8427e"' })
        res.end()
      })
      req.on('error', () => {
        res.writeHead(400)
        res.end()
      })
    })
    let endpoint

    before(function (done) {
      server.listen(0, '127.0.0.1', () => {
        endpoint = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`
        done()
      })
    })

    after(function (done) {
      server.close(() => done())
    })

    for (const captureEnabled of [false, true]) {
      describe(`with payload capture ${captureEnabled ? 'enabled' : 'disabled'}`, () => {
        before(() => {
          return agent.load('aws-sdk', {}, captureEnabled
            ? { cloudPayloadTagging: { request: '$.Body[1]', maxDepth: 10 } }
            : {})
        })

        after(() => agent.close())

        for (const isV3 of [false, true]) {
          describe(isV3 ? 'aws-sdk v3' : 'aws-sdk v2', () => {
            let s3

            before(() => {
              // Load the SDK only after agent.load() so instrumentation hooks
              // are installed first.
              const AWS = isV3
                ? require('../../../versions/@aws-sdk/client-s3@3').get()
                : require('../../../versions/aws-sdk@2').get()
              const options = {
                endpoint,
                region: 'us-east-1',
                accessKeyId: 'access-key-id',
                secretAccessKey: 'secret-access-key',
              }
              if (isV3) {
                Object.assign(options, {
                  credentials: {
                    accessKeyId: 'access-key-id',
                    secretAccessKey: 'secret-access-key',
                  },
                  forcePathStyle: true,
                  maxAttempts: 1,
                  // Avoid optional checksum/trailer behavior.
                  requestChecksumCalculation: 'WHEN_REQUIRED',
                })
              } else {
                Object.assign(options, {
                  s3ForcePathStyle: true,
                  maxRetries: 0,
                  computeChecksums: false,
                })
              }
              s3 = new AWS.S3(options)
            })

            after(async () => {
              // v3 aggregated clients expose destroy(); v2 has none.
              if (typeof (/** @type {{ destroy?: () => void }} */ (s3).destroy) === 'function') {
                /** @type {{ destroy: () => void }} */ (s3).destroy()
              }
            })

            for (const { name, makeBody } of cases) {
              const bucket = bucketFor(captureEnabled ? 's3-bin-capture' : 's3-bin-nocapture', name)

              it(`sends the original bytes for a ${name} body`, async () => {
                const { body, assertHooks } = makeBody()

                const spanPromise = agent.assertFirstTraceSpan(span => {
                  // The operation itself must not be marked as failed.
                  assert.strictEqual(span.error, 0)
                  if (captureEnabled) {
                    // The snapshot's indexed tag is redacted; the wire body is
                    // unaffected either way.
                    assert.strictEqual(span.meta['aws.request.body.Body.0'], '97')
                    assert.notStrictEqual(span.meta['aws.request.body.Body.1'], '98')
                  } else {
                    assert.ok(!Object.keys(span.meta).some(key => key.startsWith('aws.request.body')))
                  }
                }, { timeoutMs: 20000, spanResourceMatch: new RegExp(`^putObject ${bucket}$`) })

                await Promise.all([
                  callViaCallback(s3, 'putObject', {
                    Bucket: bucket,
                    Key: 'body.bin',
                    Body: body,
                  }),
                  spanPromise,
                ])

                assertHooks()
                assert.deepStrictEqual(Array.from(body), bodyBytes)
                const sent = received.get(bucket)
                assert.ok(sent, 'the mock S3 server must receive the request')
                assert.deepStrictEqual(Array.from(sent), bodyBytes)
              })
            }
          })
        }
      })
    }
  })
})
