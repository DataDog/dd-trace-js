'use strict'

const assert = require('node:assert')
const semver = require('semver')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const { storage } = require('../../datadog-core')
const { assertObjectContains } = require('../../../integration-tests/helpers')
const { ERROR_MESSAGE, ERROR_TYPE } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { breakThen, unbreakThen } = require('../../dd-trace/test/plugins/helpers')
const { withNamingSchema, withPeerService, withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectedSchema, rawExpectedSchema } = require('./naming')

// @redis/client >= 5.12.0 uses built-in TracingChannel on Node.js >= 19.9 / 20.2, which
// sanitizes command args and does not expose the connection name.
const hasDcTracingChannel = typeof require('node:diagnostics_channel').tracingChannel === 'function'

describe('Plugin', () => {
  describe('redis', () => {
    withVersions('redis', ['@node-redis/client', '@redis/client'], (version, moduleName, resolvedVersion) => {
      // @redis/client >= 5.12.0 on Node.js >= 20.2 uses built-in TracingChannel which sanitizes
      // SET/MSET values and does not expose connectionName, so splitByInstance has no effect.
      const isBuiltinDcVersion = moduleName === '@redis/client' &&
        hasDcTracingChannel && semver.satisfies(resolvedVersion, '>=5.12.0')

      let redis
      let client
      let tracer
      describe('client basics', () => {
        beforeEach(async () => {
          tracer = require('../../dd-trace')
          redis = require(`../../../versions/${moduleName}@${version}`).get()
        })

        it('should support queue options', async () => {
          tracer = require('../../dd-trace')
          redis = require(`../../../versions/${moduleName}@${version}`).get()
          const client = redis.createClient({ url: 'redis://127.0.0.1:6379', commandsQueueMaxLength: 1 })
          const connectPromise = client.connect()
          const passingPromise = client.get('foo')
          await assert.rejects(Promise.all([
            passingPromise,
            client.get('bar'),
            connectPromise,
          ]), {
            message: /queue/,
          })
          await passingPromise
          await client.quit()
        })
      })

      describe('without configuration', () => {
        before(() => {
          return agent.load('redis')
        })

        after(() => {
          return agent.close()
        })

        beforeEach(async () => {
          tracer = require('../../dd-trace')
          redis = require(`../../../versions/${moduleName}@${version}`).get()
          client = redis.createClient({ url: 'redis://127.0.0.1:6379' })

          await client.connect()
        })

        afterEach(async () => {
          unbreakThen(Promise.prototype)
          await client.quit()
        })

        it('should do automatic instrumentation when using callbacks', async () => {
          const promise = agent
            .assertSomeTraces(traces => {
              assertObjectContains(traces[0][0], {
                name: expectedSchema.outbound.opName,
                service: expectedSchema.outbound.serviceName,
                resource: 'GET',
                type: 'redis',
                meta: {
                  'db.type': 'redis',
                  'span.kind': 'client',
                  'redis.raw_command': 'GET foo',
                  component: 'redis',
                  '_dd.integration': 'redis',
                  'out.host': '127.0.0.1',
                },
                metrics: {
                  'network.destination.port': 6379,
                },
              })
            }, { spanResourceMatch: /^GET$/ })

          await Promise.all([client.get('foo'), promise])
        })

        it('keeps every arg when formatting a multi-arg command', async () => {
          // Built-in TracingChannel sanitizes SET values; only the key is kept.
          const expectedRawCommand = isBuiltinDcVersion ? 'SET multi-arg-key ?' : 'SET multi-arg-key multi-arg-value'
          const promise = agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].meta['redis.raw_command'], expectedRawCommand)
          }, { spanResourceMatch: /^SET$/ })

          await Promise.all([client.set('multi-arg-key', 'multi-arg-value'), promise])
        })

        it('trims a string arg longer than 100 chars', async () => {
          const longValue = 'x'.repeat(150)
          const promise = agent.assertSomeTraces(traces => {
            const rawCommand = traces[0][0].meta['redis.raw_command']
            if (isBuiltinDcVersion) {
              // Built-in TracingChannel sanitizes SET values to '?'.
              assert.strictEqual(rawCommand, 'SET long-key ?')
            } else {
              assert.strictEqual(rawCommand, `SET long-key ${'x'.repeat(97)}...`)
              assert.strictEqual(rawCommand.length, 'SET long-key '.length + 100)
            }
          }, { spanResourceMatch: /^SET$/ })

          await Promise.all([client.set('long-key', longValue), promise])
        })

        it('redacts the AUTH password from the raw command', async () => {
          const promise = agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].meta['redis.raw_command'], 'AUTH')
          }, { spanResourceMatch: /^AUTH$/ })

          await Promise.all([
            client.sendCommand(['AUTH', 'super-secret-password']).catch(() => {}),
            promise,
          ])
        })

        it('caps the joined raw command at 1000 chars across many args', async () => {
          const args = []
          for (let index = 0; index < 200; index++) {
            args.push(`key${index}`, `value${index}`)
          }
          const promise = agent.assertSomeTraces(traces => {
            const rawCommand = traces[0][0].meta['redis.raw_command']
            assert.match(rawCommand, /^MSET /)
            if (isBuiltinDcVersion) {
              // Built-in TracingChannel sanitizes all MSET values to '?'; the result is shorter
              // than 1000 chars and does not end with '...'.
              assert.ok(rawCommand.length < 1000)
              assert.match(rawCommand, / \?$/)
            } else {
              assert.strictEqual(rawCommand.length, 1000)
              assert.match(rawCommand, /\.\.\.$/)
            }
          }, { spanResourceMatch: /^MSET$/ })

          await Promise.all([client.sendCommand(['MSET', ...args]), promise])
        })

        withPeerService(
          () => tracer,
          'redis',
          () => client.get('bar'),
          '127.0.0.1',
          'out.host'
        )

        it('should handle errors', async () => {
          let error

          const promise = agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].meta[ERROR_TYPE], error.name)
            assert.strictEqual(traces[0][0].meta[ERROR_MESSAGE], error.message)
            assert.strictEqual(traces[0][0].meta.component, 'redis')
            // stack trace is not available in newer versions
          })

          const commandPromise = client.sendCommand('invalid').then(
            () => { },
            (e) => { error = e }
          )

          await Promise.all([commandPromise, promise])
        })

        it('should work with userland promises', async () => {
          const promise = agent
            .assertSomeTraces(traces => {
              assertObjectContains(traces[0][0], {
                name: expectedSchema.outbound.opName,
                service: expectedSchema.outbound.serviceName,
                resource: 'GET',
                type: 'redis',
                meta: {
                  'db.type': 'redis',
                  'span.kind': 'client',
                  'redis.raw_command': 'GET foo',
                  component: 'redis',
                },
              })
            })

          breakThen(Promise.prototype)

          await Promise.all([client.get('foo'), promise])
        })

        withNamingSchema(
          async () => client.get('foo'),
          rawExpectedSchema.outbound
        )

        it('should restore the parent context in the callback', async () => {
          const span = tracer._tracer.startSpan('test')
          storage('legacy').run({ span }, () => {
            client.get('foo', () => {
              assert.strictEqual(storage('legacy').getStore()?.span, span)
            })
          })
        })
      })

      describe('with configuration', () => {
        before(() => {
          return agent.load('redis', {
            service: 'custom',
            allowlist: ['GET'],
          })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(async () => {
          redis = require(`../../../versions/${moduleName}@${version}`).get()
          client = redis.createClient()

          await client.connect()
        })

        afterEach(async () => {
          await client.quit()
        })

        it('should be configured with the correct values', async () => {
          const promise = agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].service, 'custom')
            assert.strictEqual(traces[0][0].meta['out.host'], 'localhost')
            assert.strictEqual(traces[0][0].metrics['network.destination.port'], 6379)
          })

          await Promise.all([client.get('foo'), promise])
        })

        withPeerService(
          () => tracer,
          'redis',
          () => client.get('bar'),
          'localhost', 'out.host')

        it('should be able to filter commands', async () => {
          const promise = agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].resource, 'GET')
          })

          await Promise.all([client.get('foo'), promise])
        })

        withNamingSchema(
          async () => client.get('foo'),
          {
            v0: {
              opName: 'redis.command',
              serviceName: 'custom',
            },
            v1: {
              opName: 'redis.command',
              serviceName: 'custom',
            },
          }
        )
      })

      describe('with splitByInstance configuration', () => {
        before(() => {
          return agent.load('redis', {
            service: 'custom',
            splitByInstance: true,
            allowlist: ['GET'],
          })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(async () => {
          redis = require(`../../../versions/${moduleName}@${version}`).get()
          client = redis.createClient({ name: 'test' })

          await client.connect()
        })

        afterEach(async () => {
          await client.quit()
        })

        it('should set service name based on connection name', async () => {
          // Built-in TracingChannel does not expose connectionName, so splitByInstance has no effect.
          const expectedService = isBuiltinDcVersion ? 'custom' : 'custom-test'
          const promise = agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].service, expectedService)
          })

          await Promise.all([client.get('foo'), promise])
        })

        it('should set service source tag to split-by-instance', async () => {
          // Built-in TracingChannel does not expose connectionName, so splitByInstance has no effect
          // and the source tag is 'opt.plugin' (from the configured service) instead.
          const expectedSvcSrc = isBuiltinDcVersion ? 'opt.plugin' : 'opt.split_by_instance'
          const promise = agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].meta['_dd.svc_src'], expectedSvcSrc)
          })

          await Promise.all([client.get('foo'), promise])
        })

        withNamingSchema(
          async () => client.get('foo'),
          {
            v0: {
              opName: 'redis.command',
              // Built-in TracingChannel does not expose connectionName, so splitByInstance has no effect.
              serviceName: isBuiltinDcVersion ? 'custom' : 'custom-test',
            },
            v1: {
              opName: 'redis.command',
              serviceName: 'custom',
            },
          }
        )
      })

      describe('with blocklist', () => {
        before(() => {
          return agent.load('redis', {
            blocklist: [
              'Set', // this should block set and SET commands
              'FOO',
            ],
          })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(async () => {
          redis = require(`../../../versions/${moduleName}@${version}`).get()
          client = redis.createClient()

          await client.connect()
        })

        afterEach(async () => {
          await client.quit()
        })

        it('should be able to filter commands on a case-insensitive basis', async () => {
          const promise = agent.assertSomeTraces(traces => {
            assert.strictEqual(traces[0][0].resource, 'GET')
          })

          await client.set('turtle', 'like')
          await Promise.all([client.get('turtle'), promise])
        })
      })

      describe('with filter', () => {
        before(() => {
          return agent.load('redis', {
            filter: (command) => command !== 'SET' && command !== 'CLIENT',
          })
        })

        after(() => {
          return agent.close()
        })

        beforeEach(async () => {
          redis = require(`../../../versions/${moduleName}@${version}`).get()
          client = redis.createClient()

          await client.connect()
        })

        it('should be able to filter commands', (done) => {
          const timer = setTimeout(done, 200)

          agent
            .assertSomeTraces((traces) => {
              clearTimeout(timer)
              done(new Error('Filtered commands should not be recorded.'))
            })
            .catch(done)

          client.set('turtle', 'like')
        })
      })
    })
  })
})
