'use strict'

const semver = require('semver')
const agent = require('../../dd-trace/test/plugins/agent')
const { breakThen, unbreakThen } = require('../../dd-trace/test/plugins/helpers')
const { ERROR_MESSAGE, ERROR_TYPE } = require('../../dd-trace/src/constants')

const modules = semver.satisfies(process.versions.node, '>=14')
  ? ['@node-redis/client', '@redis/client']
  : ['@node-redis/client']

describe('Plugin', () => {
  let redis
  let client

  describe('redis', () => {
    withVersions('redis', modules, (version, moduleName) => {
      describe('without configuration', () => {
        before(() => {
          return agent.load('redis')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(async () => {
          redis = require(`../../../versions/${moduleName}@${version}`).get()
          client = redis.createClient()

          await client.connect()
        })

        afterEach(async () => {
          unbreakThen(Promise.prototype)
          await client.quit()
        })

        it('should do automatic instrumentation when using callbacks', async () => {
          const promise = agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('name', 'redis.command')
              expect(traces[0][0]).to.have.property('service', 'test-redis')
              expect(traces[0][0]).to.have.property('resource', 'GET')
              expect(traces[0][0]).to.have.property('type', 'redis')
              expect(traces[0][0].meta).to.have.property('db.name', '0')
              expect(traces[0][0].meta).to.have.property('db.type', 'redis')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('redis.raw_command', 'GET foo')
              expect(traces[0][0].meta).to.have.property('component', 'redis')
            })

          await client.get('foo')
          await promise
        })

        it('should handle errors', async () => {
          let error

          const promise = agent.use(traces => {
            expect(traces[0][0].meta).to.have.property(ERROR_TYPE, error.name)
            expect(traces[0][0].meta).to.have.property(ERROR_MESSAGE, error.message)
            expect(traces[0][0].meta).to.have.property('component', 'redis')
            // stack trace is not available in newer versions
          })

          try {
            await client.sendCommand('invalid')
          } catch (e) {
            error = e
          }

          await promise
        })

        it('should work with userland promises', async () => {
          const promise = agent
            .use(traces => {
              expect(traces[0][0]).to.have.property('name', 'redis.command')
              expect(traces[0][0]).to.have.property('service', 'test-redis')
              expect(traces[0][0]).to.have.property('resource', 'GET')
              expect(traces[0][0]).to.have.property('type', 'redis')
              expect(traces[0][0].meta).to.have.property('db.name', '0')
              expect(traces[0][0].meta).to.have.property('db.type', 'redis')
              expect(traces[0][0].meta).to.have.property('span.kind', 'client')
              expect(traces[0][0].meta).to.have.property('redis.raw_command', 'GET foo')
              expect(traces[0][0].meta).to.have.property('component', 'redis')
            })

          breakThen(Promise.prototype)

          await client.get('foo')
          await promise
        })
      })

      describe('with configuration', () => {
        before(() => {
          return agent.load('redis', {
            service: 'custom',
            allowlist: ['GET']
          })
        })

        after(() => {
          return agent.close({ ritmReset: false })
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
          const promise = agent.use(traces => {
            expect(traces[0][0]).to.have.property('service', 'custom')
          })

          await client.get('foo')
          await promise
        })

        it('should be able to filter commands', async () => {
          const promise = agent.use(traces => {
            expect(traces[0][0]).to.have.property('resource', 'GET')
          })

          await client.get('foo')
          await promise
        })
      })
    })
  })
})
