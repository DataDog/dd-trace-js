'use strict'

const assert = require('node:assert/strict')
const { inspect } = require('node:util')

const axios = require('axios')
const semver = require('semver')
const {
  FakeAgent,
  sandboxCwd,
  useSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc,
  stopProc,
} = require('../../../../integration-tests/helpers')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

describe('Plugin (ESM)', () => {
  describe('graphql (ESM)', () => {
    let agent
    let proc

    withVersions('graphql', ['graphql'], (version, moduleName, resolvedVersion) => {
      useSandbox([`'graphql@${resolvedVersion}'`, "'graphql-yoga@3.6.0'"], false, [
        './packages/datadog-plugin-graphql/test/esm-test/*'])

      beforeEach(async () => {
        agent = await new FakeAgent().start()
      })

      afterEach(async () => {
        await stopProc(proc)
        await agent.stop()
      })

      it('should instrument GraphQL execution with ESM', async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(checkSpansForServiceName(payload, 'graphql.execute'), true)
        })

        proc = await spawnPluginIntegrationTestProc(
          sandboxCwd(),
          'esm-graphql-server.mjs',
          agent.port,
          { NODE_OPTIONS: '--no-warnings --loader=dd-trace/loader-hook.mjs' }
        )

        // Make a GraphQL request
        const query = `
          query MyQuery {
            hello(name: "world")
          }
        `

        try {
          await axios.post(`${proc.url}/graphql`, {
            query,
          })
        } catch (error) {
          // Server might not respond correctly, but we care about tracing
        }

        await res
      }).timeout(50000)

      // Only run GraphQL Yoga test for newer GraphQL versions (>= 15.0.0)
      // GraphQL Yoga 3.6.0 requires newer GraphQL versions that have versionInfo export
      // Extract version number from range strings like ">=0.10" or "^15.2.0"
      const cleanVersion = resolvedVersion.replace(/^[>=^~]+/, '')
      const coercedVersion = semver.coerce(cleanVersion)
      if (coercedVersion && semver.gte(coercedVersion, '15.0.0')) {
        it('should instrument GraphQL Yoga execution with ESM', async () => {
          const res = agent.assertMessageReceived(({ headers, payload }) => {
            assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
            assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
            assert.strictEqual(checkSpansForServiceName(payload, 'graphql.execute'), true)
          })

          proc = await spawnPluginIntegrationTestProc(
            sandboxCwd(),
            'esm-graphql-yoga-server.mjs',
            agent.port,
            { NODE_OPTIONS: '--no-warnings --loader=dd-trace/loader-hook.mjs' }
          )

          // Make a GraphQL request to Yoga server
          const query = `
            query MyQuery {
              hello(name: "yoga")
            }
          `

          try {
            await axios.post(`${proc.url}/graphql`, {
              query,
            })
          } catch (error) {
            // Server might not respond correctly, but we care about tracing
          }

          await res
        }).timeout(50000)

        it('should instrument GraphQL Yoga subscriptions with ESM', async () => {
          const res = agent.assertMessageReceived(({ headers, payload }) => {
            assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
            assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
            assert.strictEqual(checkSpansForServiceName(payload, 'graphql.execute'), true)
          })

          proc = await spawnPluginIntegrationTestProc(
            sandboxCwd(),
            'esm-graphql-yoga-server.mjs',
            agent.port,
            { NODE_OPTIONS: '--no-warnings --loader=dd-trace/loader-hook.mjs' }
          )

          const query = `
            subscription CountSubscription {
              count
            }
          `

          try {
            await axios.post(`${proc.url}/graphql`, {
              query,
            }, {
              headers: {
                accept: 'text/event-stream',
              },
            })
          } catch (error) {
            // Server might not respond correctly, but we care about tracing
          }

          await res
        }).timeout(50000)
      }
    })
  })

  describe('graphql-jit (ESM)', () => {
    let agent
    let proc

    withVersions('graphql', 'graphql-jit', '0.8.5 || 0.8.7 || 0.8.8', (version, moduleName, resolvedVersion) => {
      useSandbox([`'graphql-jit@${resolvedVersion}'`, "'graphql@16.14.0'"], false, [
        './packages/datadog-plugin-graphql/test/esm-test/*'])

      beforeEach(async () => {
        agent = await new FakeAgent().start()
      })

      afterEach(async () => {
        await stopProc(proc)
        await agent.stop()
      })

      it('should instrument GraphQL JIT execution with ESM', async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          const jitTrace = payload.find(trace => trace.some(span => /ESMJit/.test(span.resource)))
          assert.ok(jitTrace, 'expected the JIT execution trace')
          assert.strictEqual(checkSpansForServiceName([jitTrace], 'graphql.execute'), true)
          assert.strictEqual(checkSpansForServiceName([jitTrace], 'graphql.resolve'), true)
          assert.strictEqual(jitTrace.some(span => span.resource === 'name:String'), true)
        })

        proc = await spawnPluginIntegrationTestProc(
          sandboxCwd(),
          'esm-graphql-jit-server.mjs',
          agent.port,
          { NODE_OPTIONS: '--no-warnings --loader=dd-trace/loader-hook.mjs' }
        )

        const response = await axios.get(`${proc.url}/graphql`)
        assert.deepStrictEqual(response.data, {
          data: {
            hello: 'world',
            user: { name: 'Ada' },
          },
        })
        assert.deepStrictEqual(JSON.parse(response.headers['x-resolver-calls']), {
          hello: 1,
          user: 1,
          name: 1,
        })
        await res
      }).timeout(50000)

      it('should abort GraphQL JIT execution with ESM', async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.strictEqual(headers.host, `127.0.0.1:${agent.port}`)
          assert.ok(Array.isArray(payload), `Expected array, got ${inspect(payload)}`)
          assert.strictEqual(checkSpansForServiceName(payload, 'graphql.execute'), true)
          assert.strictEqual(checkSpansForServiceName(payload, 'graphql.resolve'), false)
        })

        proc = await spawnPluginIntegrationTestProc(
          sandboxCwd(),
          'esm-graphql-jit-server.mjs',
          agent.port,
          {
            ABORT_GRAPHQL_JIT: '1',
            NODE_OPTIONS: '--no-warnings --loader=dd-trace/loader-hook.mjs',
          }
        )

        const response = await axios.get(`${proc.url}/graphql`, {
          validateStatus: () => true,
        })
        assert.strictEqual(response.status, 503)
        assert.deepStrictEqual(response.data, { error: 'AbortError' })
        await res
      }).timeout(50000)
    })
  })
})
