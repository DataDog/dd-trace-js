'use strict'

const assert = require('node:assert/strict')
const { promisify } = require('node:util')

const dc = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')

const { storage } = require('../../datadog-core')
const { ERROR_TYPE, ERROR_MESSAGE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { assertObjectContains } = require('../../../integration-tests/helpers')

const INVALID_HOSTNAME = 'invalid..hostname'
const LOOPBACK_DNS_SERVER = '127.0.0.1:1'
const PLUGINS = ['dns', 'node:dns']
const TEST_IP = '192.0.2.1'

describe('Plugin', () => {
  let dns
  let tracer
  PLUGINS.forEach(plugin => {
    describe(plugin, () => {
      afterEach(() => {
        return agent.close()
      })

      beforeEach(() => {
        return agent.load('dns')
          .then(() => {
            dns = require(plugin)
            tracer = require('../../dd-trace')
          })
      })

      it('should instrument lookup', done => {
        agent
          .assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.lookup',
              service: 'test',
              resource: 'localhost',
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.hostname': 'localhost',
              'dns.address': '127.0.0.1',
            })
          })
          .then(done)
          .catch(done)

        dns.lookup('localhost', 4, (err, address, family) => err && done(err))
      })

      it('should instrument lookup with all addresses', done => {
        agent
          .assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.lookup',
              service: 'test',
              resource: 'localhost',
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.hostname': 'localhost',
              'dns.address': '127.0.0.1',
              'dns.addresses': '127.0.0.1,::1',
            })
          })
          .then(done)
          .catch(done)

        dns.lookup('localhost', { all: true }, (err, address, family) => err && done(err))
      })

      it('should instrument errors correctly', () => {
        const lookup = promisify(dns.lookup)
        const tracePromise = agent.assertSomeTraces(traces => {
          assertObjectContains(traces[0][0], {
            name: 'dns.lookup',
            service: 'test',
            resource: INVALID_HOSTNAME,
            error: 1,
          })
          assertObjectContains(traces[0][0].meta, {
            component: 'dns',
            'span.kind': 'client',
            'dns.hostname': INVALID_HOSTNAME,
            [ERROR_TYPE]: 'Error',
            [ERROR_MESSAGE]: `getaddrinfo ENOTFOUND ${INVALID_HOSTNAME}`,
          })
        })

        return Promise.all([
          tracePromise,
          assert.rejects(lookup(INVALID_HOSTNAME, 4), { code: 'ENOTFOUND' }),
        ])
      })

      it('should instrument lookupService', done => {
        agent
          .assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.lookup_service',
              service: 'test',
              resource: '127.0.0.1:22',
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.address': '127.0.0.1',
            })
            assertObjectContains(traces[0][0].metrics, {
              'dns.port': 22,
            })
          })
          .then(done)
          .catch(done)

        dns.lookupService('127.0.0.1', 22, err => err && done(err))
      })

      it('should instrument resolve', () => {
        const resolve = promisify(dns.resolve)
        const tracePromise = agent.assertSomeTraces(traces => {
          assertObjectContains(traces[0][0], {
            name: 'dns.resolve',
            service: 'test',
            resource: `A ${INVALID_HOSTNAME}`,
          })
          assertObjectContains(traces[0][0].meta, {
            component: 'dns',
            'span.kind': 'client',
            'dns.hostname': INVALID_HOSTNAME,
            'dns.rrtype': 'A',
          })
        })

        return Promise.all([
          tracePromise,
          assert.rejects(resolve(INVALID_HOSTNAME), { code: 'EBADNAME' }),
        ])
      })

      it('should instrument resolve shorthands', () => {
        const resolveAny = promisify(dns.resolveAny)
        const tracePromise = agent.assertSomeTraces(traces => {
          assertObjectContains(traces[0][0], {
            name: 'dns.resolve',
            service: 'test',
            resource: `ANY ${INVALID_HOSTNAME}`,
          })
          assertObjectContains(traces[0][0].meta, {
            component: 'dns',
            'span.kind': 'client',
            'dns.hostname': INVALID_HOSTNAME,
            'dns.rrtype': 'ANY',
          })
        })

        return Promise.all([
          tracePromise,
          assert.rejects(resolveAny(INVALID_HOSTNAME), { code: 'EBADNAME' }),
        ])
      })

      it('should preserve the shorthand rrtype when callback options are passed', () => {
        const resolve6 = promisify(dns.resolve6)
        const tracePromise = agent.assertSomeTraces(traces => {
          assertObjectContains(traces[0][0], {
            name: 'dns.resolve',
            service: 'test',
            resource: `AAAA ${INVALID_HOSTNAME}`,
          })
          assertObjectContains(traces[0][0].meta, {
            component: 'dns',
            'span.kind': 'client',
            'dns.hostname': INVALID_HOSTNAME,
            'dns.rrtype': 'AAAA',
          })
        })

        return Promise.all([
          tracePromise,
          assert.rejects(resolve6(INVALID_HOSTNAME, { ttl: true }), { code: 'EBADNAME' }),
        ])
      })

      it('should instrument resolveCaa with options', () => {
        const resolveCaa = promisify(dns.resolveCaa)
        const tracePromise = agent.assertSomeTraces(traces => {
          assertObjectContains(traces[0][0], {
            name: 'dns.resolve',
            service: 'test',
            resource: `CAA ${INVALID_HOSTNAME}`,
          })
          assertObjectContains(traces[0][0].meta, {
            component: 'dns',
            'span.kind': 'client',
            'dns.hostname': INVALID_HOSTNAME,
            'dns.rrtype': 'CAA',
          })
        })

        return Promise.all([
          tracePromise,
          assert.rejects(resolveCaa(INVALID_HOSTNAME, { ttl: true }), { code: 'EBADNAME' }),
        ])
      })

      it('should preserve the shorthand rrtype on callback Resolver instances when options are passed', () => {
        const resolver = new dns.Resolver()
        const resolve6 = promisify(resolver.resolve6.bind(resolver))

        const tracePromise = agent.assertSomeTraces(traces => {
          assertObjectContains(traces[0][0], {
            name: 'dns.resolve',
            service: 'test',
            resource: `AAAA ${INVALID_HOSTNAME}`,
          })
          assertObjectContains(traces[0][0].meta, {
            component: 'dns',
            'span.kind': 'client',
            'dns.hostname': INVALID_HOSTNAME,
            'dns.rrtype': 'AAAA',
          })
        })

        return Promise.all([
          tracePromise,
          assert.rejects(
            resolve6(INVALID_HOSTNAME, { ttl: true }),
            { code: 'EBADNAME' }
          ),
        ])
      })

      it('should instrument reverse', () => {
        const resolver = new dns.Resolver()
        resolver.setServers([LOOPBACK_DNS_SERVER])
        const reverse = promisify(resolver.reverse.bind(resolver))

        const tracePromise = agent.assertSomeTraces(traces => {
          assertObjectContains(traces[0][0], {
            name: 'dns.reverse',
            service: 'test',
            resource: TEST_IP,
            error: 1,
          })
          assertObjectContains(traces[0][0].meta, {
            component: 'dns',
            'span.kind': 'client',
            'dns.ip': TEST_IP,
          })
        })

        const reversePromise = reverse(TEST_IP)
        const rejectionPromise = assert.rejects(reversePromise)
        resolver.cancel()

        return Promise.all([tracePromise, rejectionPromise])
      })

      it('should preserve the parent scope in the callback', done => {
        const span = tracer.startSpan('dummySpan', {})

        tracer.scope().activate(span, () => {
          dns.lookup('localhost', 4, (err) => {
            if (err) return done(err)

            assert.strictEqual(tracer.scope().active(), span)

            done()
          })
        })
      })

      it('should work with promisify', () => {
        const lookup = promisify(dns.lookup)

        return lookup('localhost', 4).then(({ address, family }) => {
          assert.strictEqual(address, '127.0.0.1')
          assert.strictEqual(family, 4)
        })
      })

      it('should instrument Resolver', () => {
        const resolver = new dns.Resolver()
        const resolve = promisify(resolver.resolve.bind(resolver))

        const tracePromise = agent.assertSomeTraces(traces => {
          assertObjectContains(traces[0][0], {
            name: 'dns.resolve',
            service: 'test',
            resource: `A ${INVALID_HOSTNAME}`,
          })
          assertObjectContains(traces[0][0].meta, {
            component: 'dns',
            'dns.hostname': INVALID_HOSTNAME,
            'dns.rrtype': 'A',
          })
        })

        return Promise.all([
          tracePromise,
          assert.rejects(
            resolve(INVALID_HOSTNAME),
            { code: 'EBADNAME' }
          ),
        ])
      })

      it('should skip instrumentation for noop context', () => {
        const resolver = new dns.Resolver()
        const resolve = promisify(resolver.resolve.bind(resolver))

        const noTracePromise = agent.assertNoTraces(() => {
          throw new Error('Resolve was traced.')
        }, { timeoutMs: 200 })

        const resolvePromise = storage('legacy').run(
          { noop: true },
          () => assert.rejects(
            resolve(INVALID_HOSTNAME),
            { code: 'EBADNAME' }
          )
        )

        return Promise.all([noTracePromise, resolvePromise])
      })

      describe('promises', () => {
        it('should instrument lookup', () => {
          const tracePromise = agent.assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.lookup',
              service: 'test',
              resource: 'localhost',
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.hostname': 'localhost',
              'dns.address': '127.0.0.1',
            })
          })

          return Promise.all([
            tracePromise,
            dns.promises.lookup('localhost', 4).then(({ address, family }) => {
              assert.strictEqual(address, '127.0.0.1')
              assert.strictEqual(family, 4)
            }),
          ])
        })

        it('should instrument lookup with all addresses', () => {
          const tracePromise = agent.assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.lookup',
              service: 'test',
              resource: 'localhost',
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.hostname': 'localhost',
              'dns.address': '127.0.0.1',
              'dns.addresses': '127.0.0.1,::1',
            })
          })

          return Promise.all([
            tracePromise,
            dns.promises.lookup('localhost', { all: true }),
          ])
        })

        it('should instrument errors correctly', () => {
          const tracePromise = agent.assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.lookup',
              service: 'test',
              resource: INVALID_HOSTNAME,
              error: 1,
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.hostname': INVALID_HOSTNAME,
              [ERROR_TYPE]: 'Error',
              [ERROR_MESSAGE]: `getaddrinfo ENOTFOUND ${INVALID_HOSTNAME}`,
            })
          })

          return Promise.all([
            tracePromise,
            assert.rejects(dns.promises.lookup(INVALID_HOSTNAME, 4), { code: 'ENOTFOUND' }),
          ])
        })

        it('should instrument lookupService', () => {
          const tracePromise = agent.assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.lookup_service',
              service: 'test',
              resource: '127.0.0.1:22',
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.address': '127.0.0.1',
            })
            assertObjectContains(traces[0][0].metrics, {
              'dns.port': 22,
            })
          })

          return Promise.all([
            tracePromise,
            dns.promises.lookupService('127.0.0.1', 22),
          ])
        })

        it('should instrument resolve', () => {
          const tracePromise = agent.assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.resolve',
              service: 'test',
              resource: `A ${INVALID_HOSTNAME}`,
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.hostname': INVALID_HOSTNAME,
              'dns.rrtype': 'A',
            })
          })

          return Promise.all([
            tracePromise,
            assert.rejects(dns.promises.resolve(INVALID_HOSTNAME), { code: 'EBADNAME' }),
          ])
        })

        it('should instrument resolve shorthands', () => {
          const tracePromise = agent.assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.resolve',
              service: 'test',
              resource: `ANY ${INVALID_HOSTNAME}`,
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.hostname': INVALID_HOSTNAME,
              'dns.rrtype': 'ANY',
            })
          })

          return Promise.all([
            tracePromise,
            assert.rejects(dns.promises.resolveAny(INVALID_HOSTNAME), { code: 'EBADNAME' }),
          ])
        })

        it('should preserve the shorthand rrtype when promise options are passed', () => {
          const tracePromise = agent.assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.resolve',
              service: 'test',
              resource: `AAAA ${INVALID_HOSTNAME}`,
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.hostname': INVALID_HOSTNAME,
              'dns.rrtype': 'AAAA',
            })
          })

          return Promise.all([
            tracePromise,
            assert.rejects(dns.promises.resolve6(INVALID_HOSTNAME, { ttl: true }), { code: 'EBADNAME' }),
          ])
        })

        it('should instrument resolveTlsa with options when supported', function () {
          if (typeof dns.promises.resolveTlsa !== 'function') {
            this.skip()
          }

          const tracePromise = agent.assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.resolve',
              service: 'test',
              resource: `TLSA ${INVALID_HOSTNAME}`,
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.hostname': INVALID_HOSTNAME,
              'dns.rrtype': 'TLSA',
            })
          })

          return Promise.all([
            tracePromise,
            assert.rejects(dns.promises.resolveTlsa(INVALID_HOSTNAME, { ttl: true }), { code: 'EBADNAME' }),
          ])
        })

        it('should preserve the shorthand rrtype on promise Resolver instances when options are passed', () => {
          const resolver = new dns.promises.Resolver()

          const tracePromise = agent.assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.resolve',
              service: 'test',
              resource: `AAAA ${INVALID_HOSTNAME}`,
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.hostname': INVALID_HOSTNAME,
              'dns.rrtype': 'AAAA',
            })
          })

          return Promise.all([
            tracePromise,
            assert.rejects(resolver.resolve6(INVALID_HOSTNAME, { ttl: true }), { code: 'EBADNAME' }),
          ])
        })

        it('should instrument reverse', () => {
          const resolver = new dns.promises.Resolver()
          resolver.setServers([LOOPBACK_DNS_SERVER])

          const tracePromise = agent.assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.reverse',
              service: 'test',
              resource: TEST_IP,
              error: 1,
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.ip': TEST_IP,
            })
          })

          const reversePromise = resolver.reverse(TEST_IP)
          const rejectionPromise = assert.rejects(reversePromise)
          resolver.cancel()

          return Promise.all([tracePromise, rejectionPromise])
        })

        it('should preserve the parent scope across await', async () => {
          const span = tracer.startSpan('dummySpan', {})

          await tracer.scope().activate(span, async () => {
            await dns.promises.lookup('localhost', 4)
            assert.strictEqual(tracer.scope().active(), span)
          })
        })

        it('should rethrow synchronous errors from the underlying call', () => {
          assert.throws(() => dns.promises.lookup({}), { code: 'ERR_INVALID_ARG_TYPE' })
          assert.throws(() => dns.promises.resolve6(), { code: 'ERR_INVALID_ARG_TYPE' })
        })

        it('should instrument Resolver instances', () => {
          const resolver = new dns.promises.Resolver()

          const tracePromise = agent.assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.resolve',
              service: 'test',
              resource: `A ${INVALID_HOSTNAME}`,
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'dns.hostname': INVALID_HOSTNAME,
              'dns.rrtype': 'A',
            })
          })

          return Promise.all([
            tracePromise,
            assert.rejects(resolver.resolve(INVALID_HOSTNAME), { code: 'EBADNAME' }),
          ])
        })

        // Loading both `dns` and `dns/promises` reaches the same exports object through
        // two ritm hooks. Without a WeakSet guard, the second hook to fire would stack a
        // second wrap layer and publish `apm:dns:*` events twice per call.
        it('does not double-wrap when both dns and dns/promises are loaded', async () => {
          const startCh = dc.channel('apm:dns:lookup:start')
          let startCount = 0
          const handler = () => { startCount++ }
          startCh.subscribe(handler)
          try {
            const viaDns = require('dns').promises
            const viaNodeDns = require('node:dns').promises
            const viaSubpath = require('dns/promises')
            const viaNodeSubpath = require('node:dns/promises')

            // All four CJS access shapes resolve to the same exports object.
            assert.strictEqual(viaDns, viaNodeDns)
            assert.strictEqual(viaDns, viaSubpath)
            assert.strictEqual(viaDns, viaNodeSubpath)

            // Same wrapped function reference across access shapes — a second wrap
            // layer would produce a different function identity.
            assert.strictEqual(viaDns.lookup, viaSubpath.lookup)

            const shapes = [
              ['require("dns").promises', viaDns],
              ['require("node:dns").promises', viaNodeDns],
              ['require("dns/promises")', viaSubpath],
              ['require("node:dns/promises")', viaNodeSubpath],
            ]

            for (const [label, api] of shapes) {
              const before = startCount
              await api.lookup('localhost', 4)
              await new Promise(setImmediate)
              const fired = startCount - before
              assert.strictEqual(fired, 1,
                `expected 1 start event for one lookup via ${label}; got ${fired}`)
            }
          } finally {
            startCh.unsubscribe(handler)
          }
        })
      })
    })
  })
})
