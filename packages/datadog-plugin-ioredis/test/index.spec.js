'use strict'

const assert = require('node:assert/strict')
const semver = require('semver')

const { after, afterEach, before, beforeEach, describe, it } = require('mocha')

const { ERROR_MESSAGE, ERROR_TYPE, ERROR_STACK } = require('../../dd-trace/src/constants')
const agent = require('../../dd-trace/test/plugins/agent')
const { breakThen, unbreakThen } = require('../../dd-trace/test/plugins/helpers')
const { withNamingSchema, withVersions } = require('../../dd-trace/test/setup/mocha')
const { expectedSchema, rawExpectedSchema } = require('./naming')

// ioredis >= 5.11.0 uses built-in TracingChannel on Node.js >= 19.9 / 20.2, which
// does not expose the connection name, so splitByInstance has no effect.
// eslint-disable-next-line n/no-unsupported-features/node-builtins
const hasDcTracingChannel = typeof require('node:diagnostics_channel').tracingChannel === 'function'

describe('Plugin', () => {
  let Redis
  let redis
  let tracer

  describe('ioredis', () => {
    withVersions('ioredis', 'ioredis', version => {
      beforeEach(() => {
        tracer = require('../../dd-trace')
        Redis = require(`../../../versions/ioredis@${version}`).get()
        redis = new Redis({ connectionName: 'test' })
      })

      afterEach(() => {
        unbreakThen(Promise.prototype)
        redis.quit()
      })

      describe('without configuration', () => {
        beforeEach(() => agent.load(['ioredis']))

        afterEach(() => agent.close())

        it('should do automatic instrumentation when using callbacks', async () => {
          await redis.get('foo')

          await agent.assertFirstTraceSpan({
            name: expectedSchema.outbound.opName,
            service: expectedSchema.outbound.serviceName,
            resource: 'get',
            type: 'redis',
            meta: {
              component: 'ioredis',
              'db.type': 'redis',
              'span.kind': 'client',
              'out.host': 'localhost',
              'redis.raw_command': 'GET foo',
            },
            metrics: {
              'network.destination.port': 6379,
            },
          }, { spanResourceMatch: /^get$/ })
        })

        it('formats numeric args without coercing to ?', async () => {
          await redis.expire('foo', 60)

          await agent.assertFirstTraceSpan({
            meta: { 'redis.raw_command': 'EXPIRE foo 60' },
          }, { spanResourceMatch: /^expire$/ })
        })

        it('redacts non-string non-number args as ?', async () => {
          await redis.set('foo', Buffer.from('binary-value'))

          await agent.assertFirstTraceSpan({
            meta: { 'redis.raw_command': 'SET foo ?' },
          }, { spanResourceMatch: /^set$/ })
        })

        // Regression for https://github.com/DataDog/dd-trace-js/issues/5615.
        it('should not set db.name on Redis spans', async () => {
          await redis.get('foo')

          await agent.assertFirstTraceSpan((span) => {
            assert.ok(
              !Object.hasOwn(span.meta, 'db.name'),
              `expected no db.name on Redis span; got '${span.meta['db.name']}'`
            )
            assert.strictEqual(span.meta['out.host'], 'localhost')
          }, { spanResourceMatch: /^get$/ })
        })

        it('should run the callback in the parent context', () => {
          const span = tracer.startSpan('test')

          return tracer.scope().activate(span, async () => {
            await redis.get('foo')
            assert.strictEqual(tracer.scope().active(), span)
          })
        })

        it('should handle errors', async () => {
          let error

          try {
            await redis.set('foo', 123, 'bar')
          } catch (err) {
            error = err
          }

          await agent.assertFirstTraceSpan({
            error: 1,
            meta: {
              [ERROR_TYPE]: error.name,
              [ERROR_MESSAGE]: error.message,
              [ERROR_STACK]: error.stack,
              component: 'ioredis',
            },
          })
        })

        it('should work with userland promises', async () => {
          breakThen(Promise.prototype)

          await redis.get('foo')

          await agent.assertFirstTraceSpan({
            name: expectedSchema.outbound.opName,
            service: expectedSchema.outbound.serviceName,
            resource: 'get',
            type: 'redis',
            meta: {
              'db.type': 'redis',
              'span.kind': 'client',
              'out.host': 'localhost',
              'redis.raw_command': 'GET foo',
              component: 'ioredis',
            },
            metrics: {
              'network.destination.port': 6379,
            },
          }, { spanResourceMatch: /^get$/ })
        })

        withNamingSchema(
          done => redis.get('foo').catch(done),
          rawExpectedSchema.outbound
        )
      })

      describe('with configuration', () => {
        before(() => agent.load('ioredis', {
          service: 'custom',
          splitByInstance: true,
          allowlist: ['get'],
        }))

        after(() => agent.close())

        it('should be configured with the correct values', async () => {
          await redis.get('foo')

          // ioredis >= 5.11.0 on Node.js >= 20.2 uses built-in TracingChannel which does not
          // expose connectionName, so splitByInstance has no effect and the service is 'custom'.
          // `version` may be a range string like '>=5.11.0', so coerce before comparing.
          const expectedService = hasDcTracingChannel && semver.satisfies(semver.coerce(version), '>=5.11.0')
            ? 'custom'
            : 'custom-test'

          await agent.assertFirstTraceSpan({
            service: expectedService,
          })
        })

        it('should be able to filter commands', async () => {
          await redis.get('foo')

          await agent.assertFirstTraceSpan({
            resource: 'get',
          })
        })

        withNamingSchema(
          done => redis.get('foo').catch(done),
          {
            v0: {
              opName: 'redis.command',
              // ioredis >= 5.11.0 on Node.js >= 20.2 uses built-in TracingChannel which does not
              // expose connectionName, so splitByInstance has no effect and the service is 'custom'.
              // `version` may be a range string like '>=5.11.0', so coerce before comparing.
              serviceName: hasDcTracingChannel && semver.satisfies(semver.coerce(version), '>=5.11.0')
                ? 'custom'
                : 'custom-test',
            },
            v1: {
              opName: 'redis.command',
              serviceName: 'custom',
            },
          }
        )
      })

      describe('with legacy configuration', () => {
        before(() => agent.load('ioredis', {
          whitelist: ['get'],
        }))

        after(() => agent.close())

        it('should be able to filter commands', async () => {
          await redis.get('foo')

          await agent.assertFirstTraceSpan({
            resource: 'get',
          })
        })
      })
    })
  })
})
