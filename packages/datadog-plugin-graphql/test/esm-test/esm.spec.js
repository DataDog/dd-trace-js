'use strict'

const {
  FakeAgent,
  checkSpansForServiceName,
  spawnPluginIntegrationTestProc
} = require('../../../../integration-tests/helpers')
const { assert } = require('chai')
const { withVersions, insertVersionDep } = require('../../../dd-trace/test/setup/mocha')
const { join } = require('path')
const axios = require('axios')
const semver = require('semver')

describe('Plugin (ESM)', () => {
  describe('graphql (ESM)', () => {
    let agent
    let proc
    const env = {
      NODE_OPTIONS: `--loader=${join(__dirname, '..', '..', '..', '..', 'initialize.mjs')}`
    }

    withVersions('graphql', ['graphql'], (version, moduleName, resolvedVersion) => {
      insertVersionDep(__dirname, 'graphql', version)

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

        proc = await spawnPluginIntegrationTestProc(
          __dirname,
          'esm-graphql-server.mjs',
          agent.port,
          undefined,
          env
        )

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
      const cleanVersion = resolvedVersion.replace(/^[>=^~]+/, '')
      const coercedVersion = semver.coerce(cleanVersion)
      if (coercedVersion && semver.gte(coercedVersion, '15.0.0')) {
        it('should instrument GraphQL Yoga execution with ESM', async () => {
          const res = agent.assertMessageReceived(({ headers, payload }) => {
            assert.propertyVal(headers, 'host', `127.0.0.1:${agent.port}`)
            assert.isArray(payload)
            assert.strictEqual(checkSpansForServiceName(payload, 'graphql.execute'), true)
          })

          proc = await spawnPluginIntegrationTestProc(
            __dirname,
            'esm-graphql-yoga-server.mjs',
            agent.port,
            undefined,
            env
          )

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
