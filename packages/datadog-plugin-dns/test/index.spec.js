'use strict'

const assert = require('node:assert/strict')
const { promisify } = require('node:util')

const dc = require('dc-polyfill')
const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const { storage } = require('../../datadog-core')
const { ERROR_TYPE, ERROR_MESSAGE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { startDnsServer } = require('./dns-server')

const PLUGINS = ['dns', 'node:dns']

describe('Plugin', () => {
  let dns
  let dnsServer
  let originalPromiseServers
  let originalServers
  let tracer

  before(async () => {
    dnsServer = await startDnsServer()
  })

  after(() => dnsServer?.close())

  /**
   * @template T
   * @param {T & { setServers: (servers: string[]) => void }} resolver
   * @returns {T}
   */
  function useTestServer (resolver) {
    resolver.setServers([dnsServer.address])
    return resolver
  }

  PLUGINS.forEach(plugin => {
    describe(plugin, () => {
      afterEach(async () => {
        dns.setServers(originalServers)
        dns.promises.setServers(originalPromiseServers)
        await agent.close()
      })

      beforeEach(async () => {
        await agent.load('dns')
        dns = require(plugin)
        originalServers = dns.getServers()
        originalPromiseServers = dns.promises.getServers()
        dns.setServers([dnsServer.address])
        dns.promises.setServers([dnsServer.address])
        tracer = require('../../dd-trace')
      })

      it('should instrument lookup', () => {
        return agent.assertSomeTraces(traces => {
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
        }, { trigger: () => promisify(dns.lookup)('localhost', 4) })
      })

      it('should instrument lookup with all addresses', () => {
        return agent.assertSomeTraces(traces => {
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
        }, { trigger: () => promisify(dns.lookup)('localhost', { all: true }) })
      })

      it('should instrument errors correctly', () => {
        return agent.assertSomeTraces(traces => {
          assertObjectContains(traces[0][0], {
            name: 'dns.lookup',
            service: 'test',
            resource: 'invalid..hostname',
            error: 1,
          })
          assertObjectContains(traces[0][0].meta, {
            component: 'dns',
            'span.kind': 'client',
            'dns.hostname': 'invalid..hostname',
            [ERROR_TYPE]: 'Error',
            [ERROR_MESSAGE]: 'getaddrinfo ENOTFOUND invalid..hostname',
          })
        }, { trigger: () => assert.rejects(promisify(dns.lookup)('invalid..hostname', 4)) })
      })

      it('should instrument lookupService', () => {
        return agent.assertSomeTraces(traces => {
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
        }, { trigger: () => promisify(dns.lookupService)('127.0.0.1', 22) })
      })

      it('should instrument resolve', () => {
        return agent.assertSomeTraces(traces => {
          assertObjectContains(traces[0][0], {
            name: 'dns.resolve',
            service: 'test',
            resource: 'A trace.test',
          })
          assertObjectContains(traces[0][0].meta, {
            component: 'dns',
            'span.kind': 'client',
            'dns.hostname': 'trace.test',
            'dns.rrtype': 'A',
          })
        }, { trigger: () => promisify(dns.resolve)('trace.test') })
      })

      it('should instrument resolve shorthands', () => {
        return agent.assertSomeTraces(traces => {
          assertObjectContains(traces[0][0], {
            name: 'dns.resolve',
            service: 'test',
            resource: 'ANY trace.test',
          })
          assertObjectContains(traces[0][0].meta, {
            component: 'dns',
            'span.kind': 'client',
            'dns.hostname': 'trace.test',
            'dns.rrtype': 'ANY',
          })
        }, { trigger: () => promisify(dns.resolveAny)('trace.test') })
      })

      it('should preserve the shorthand rrtype when callback options are passed', () => {
        return agent.assertSomeTraces(traces => {
          assertObjectContains(traces[0][0], {
            name: 'dns.resolve',
            service: 'test',
            resource: 'AAAA fakedomain.faketld',
          })
          assertObjectContains(traces[0][0].meta, {
            component: 'dns',
            'span.kind': 'client',
            'dns.hostname': 'fakedomain.faketld',
            'dns.rrtype': 'AAAA',
          })
        }, { trigger: () => assert.rejects(promisify(dns.resolve6)('fakedomain.faketld', { ttl: true })) })
      })

      it('should instrument resolveCaa with options', () => {
        return agent.assertSomeTraces(traces => {
          assertObjectContains(traces[0][0], {
            name: 'dns.resolve',
            service: 'test',
            resource: 'CAA fakedomain.faketld',
          })
          assertObjectContains(traces[0][0].meta, {
            component: 'dns',
            'span.kind': 'client',
            'dns.hostname': 'fakedomain.faketld',
            'dns.rrtype': 'CAA',
          })
        }, { trigger: () => assert.rejects(promisify(dns.resolveCaa)('fakedomain.faketld', { ttl: true })) })
      })

      it('should preserve the shorthand rrtype on callback Resolver instances when options are passed', () => {
        const resolver = useTestServer(new dns.Resolver())

        return agent.assertSomeTraces(traces => {
          assertObjectContains(traces[0][0], {
            name: 'dns.resolve',
            service: 'test',
            resource: 'AAAA fakedomain.faketld',
          })
          assertObjectContains(traces[0][0].meta, {
            component: 'dns',
            'span.kind': 'client',
            'dns.hostname': 'fakedomain.faketld',
            'dns.rrtype': 'AAAA',
          })
        }, {
          trigger: () => assert.rejects(
            promisify(resolver.resolve6).call(resolver, 'fakedomain.faketld', { ttl: true })
          ),
        })
      })

      it('should instrument reverse', () => {
        return agent.assertSomeTraces(traces => {
          assertObjectContains(traces[0][0], {
            name: 'dns.reverse',
            service: 'test',
            resource: '127.0.0.1',
          })
          assertObjectContains(traces[0][0].meta, {
            component: 'dns',
            'span.kind': 'client',
            'dns.ip': '127.0.0.1',
          })
        }, { trigger: () => promisify(dns.reverse)('127.0.0.1') })
      })

      it('should preserve the parent scope in the callback', () => {
        const span = tracer.startSpan('dummySpan', {})

        return new Promise((resolve, reject) => {
          tracer.scope().activate(span, () => {
            dns.lookup('localhost', 4, (error) => {
              if (error) return reject(error)

              assert.strictEqual(tracer.scope().active(), span)

              resolve()
            })
          })
        })
      })

      it('should work with promisify', async () => {
        const lookup = promisify(dns.lookup)
        const { address, family } = await lookup('localhost', 4)

        assert.strictEqual(address, '127.0.0.1')
        assert.strictEqual(family, 4)
      })

      it('should instrument Resolver', () => {
        const resolver = useTestServer(new dns.Resolver())

        return agent.assertSomeTraces(traces => {
          assertObjectContains(traces[0][0], {
            name: 'dns.resolve',
            service: 'test',
            resource: 'A trace.test',
          })
          assertObjectContains(traces[0][0].meta, {
            component: 'dns',
            'dns.hostname': 'trace.test',
            'dns.rrtype': 'A',
          })
        }, { trigger: () => promisify(resolver.resolve).call(resolver, 'trace.test') })
      })

      it('should skip instrumentation for noop context', () => {
        const resolver = useTestServer(new dns.Resolver())

        return agent.assertNoTraces(() => {
          throw new Error('Resolve was traced.')
        }, {
          timeoutMs: 200,
          trigger: () => storage('legacy').run(
            { noop: true },
            () => promisify(resolver.resolve).call(resolver, 'trace.test')
          ),
        })
      })

      describe('promises', () => {
        it('should instrument lookup', () => {
          return agent.assertSomeTraces(traces => {
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
          }, {
            trigger: async () => {
              const { address, family } = await dns.promises.lookup('localhost', 4)

              assert.strictEqual(address, '127.0.0.1')
              assert.strictEqual(family, 4)
            },
          })
        })

        it('should instrument lookup with all addresses', () => {
          return agent.assertSomeTraces(traces => {
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
          }, { trigger: () => dns.promises.lookup('localhost', { all: true }) })
        })

        it('should instrument errors correctly', () => {
          return agent.assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.lookup',
              service: 'test',
              resource: 'invalid..hostname',
              error: 1,
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.hostname': 'invalid..hostname',
              [ERROR_TYPE]: 'Error',
              [ERROR_MESSAGE]: 'getaddrinfo ENOTFOUND invalid..hostname',
            })
          }, { trigger: () => assert.rejects(dns.promises.lookup('invalid..hostname', 4)) })
        })

        it('should instrument lookupService', () => {
          return agent.assertSomeTraces(traces => {
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
          }, { trigger: () => dns.promises.lookupService('127.0.0.1', 22) })
        })

        it('should instrument resolve', () => {
          return agent.assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.resolve',
              service: 'test',
              resource: 'A trace.test',
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.hostname': 'trace.test',
              'dns.rrtype': 'A',
            })
          }, { trigger: () => dns.promises.resolve('trace.test') })
        })

        it('should instrument resolve shorthands', () => {
          return agent.assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.resolve',
              service: 'test',
              resource: 'ANY trace.test',
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.hostname': 'trace.test',
              'dns.rrtype': 'ANY',
            })
          }, { trigger: () => dns.promises.resolveAny('trace.test') })
        })

        it('should preserve the shorthand rrtype when promise options are passed', () => {
          return agent.assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.resolve',
              service: 'test',
              resource: 'AAAA fakedomain.faketld',
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.hostname': 'fakedomain.faketld',
              'dns.rrtype': 'AAAA',
            })
          }, {
            trigger: () => assert.rejects(dns.promises.resolve6('fakedomain.faketld', { ttl: true })),
          })
        })

        it('should instrument resolveTlsa with options when supported', function () {
          if (typeof dns.promises.resolveTlsa !== 'function') {
            this.skip()
          }

          return agent.assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.resolve',
              service: 'test',
              resource: 'TLSA fakedomain.faketld',
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.hostname': 'fakedomain.faketld',
              'dns.rrtype': 'TLSA',
            })
          }, {
            trigger: () => assert.rejects(dns.promises.resolveTlsa('fakedomain.faketld', { ttl: true })),
          })
        })

        it('should preserve the shorthand rrtype on promise Resolver instances when options are passed', () => {
          const resolver = useTestServer(new dns.promises.Resolver())

          return agent.assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.resolve',
              service: 'test',
              resource: 'AAAA fakedomain.faketld',
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.hostname': 'fakedomain.faketld',
              'dns.rrtype': 'AAAA',
            })
          }, {
            trigger: () => assert.rejects(resolver.resolve6('fakedomain.faketld', { ttl: true })),
          })
        })

        it('should instrument reverse', () => {
          return agent.assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.reverse',
              service: 'test',
              resource: '127.0.0.1',
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'span.kind': 'client',
              'dns.ip': '127.0.0.1',
            })
          }, { trigger: () => dns.promises.reverse('127.0.0.1') })
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
          const resolver = useTestServer(new dns.promises.Resolver())

          return agent.assertSomeTraces(traces => {
            assertObjectContains(traces[0][0], {
              name: 'dns.resolve',
              service: 'test',
              resource: 'A trace.test',
            })
            assertObjectContains(traces[0][0].meta, {
              component: 'dns',
              'dns.hostname': 'trace.test',
              'dns.rrtype': 'A',
            })
          }, { trigger: () => resolver.resolve('trace.test') })
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
