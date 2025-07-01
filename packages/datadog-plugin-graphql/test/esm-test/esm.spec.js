'use strict'

const {
  FakeAgent,
  createSandbox,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')
const axios = require('axios')
const semver = require('semver')

describe('Plugin (ESM)', () => {
  describe('graphql (ESM)', () => {
    let agent
    let proc
    let sandbox

    withVersions('graphql', ['graphql'], version => {
      before(async function () {
        this.timeout(50000)
        sandbox = await createSandbox([`'graphql@${version}'`, "'graphql-yoga@3.6.0'"], false, [
          './packages/datadog-plugin-graphql/test/esm-test/*'])
      })

      after(async function () {
        await sandbox.remove()
      })

      beforeEach(async () => {
        agent = await new FakeAgent().start()
      })

      afterEach(async () => {
        proc && proc.kill()
        await agent.stop()
      })

      it('should instrument GraphQL execution with ESM', async () => {
        const res = agent.assertMessageReceived(({ headers, payload }) => {
          assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
          assert.isArray(payload)
          assert.strictEqual(checkSpansForServiceName(payload, 'graphql.execute'), true)
        })

        proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'esm-graphql-server.mjs', agent.port)

        // Make a GraphQL request
        const query = `
          query MyQuery {
            hello(name: "world")
          }
        `

        try {
          await axios.post(`${proc.url}/graphql`, {
            query
          })
        } catch (error) {
          // Server might not respond correctly, but we care about tracing
        }

        await res
      }).timeout(50000)

      // Only run GraphQL Yoga test for newer GraphQL versions (>= 15.0.0)
      // GraphQL Yoga 3.6.0 requires newer GraphQL versions that have versionInfo export
      // Extract version number from range strings like ">=0.10" or "^15.2.0"
      const cleanVersion = version.replace(/^[>=^~]+/, '')
      const coercedVersion = semver.coerce(cleanVersion)
      if (coercedVersion && semver.gte(coercedVersion, '15.0.0')) {
        it('should instrument GraphQL Yoga execution with ESM', async () => {
          const res = agent.assertMessageReceived(({ headers, payload }) => {
            assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
            assert.isArray(payload)
            assert.strictEqual(checkSpansForServiceName(payload, 'graphql.execute'), true)
          })

          proc = await spawnPluginIntegrationTestProc(sandbox.folder, 'esm-graphql-yoga-server.mjs', agent.port)

          // Make a GraphQL request to Yoga server
          const query = `
            query MyQuery {
              hello(name: "yoga")
            }
          `

          try {
            await axios.post(`${proc.url}/graphql`, {
              query
            })
          } catch (error) {
            // Server might not respond correctly, but we care about tracing
          }

          await res
        }).timeout(50000)
      }
    })
  })
})
