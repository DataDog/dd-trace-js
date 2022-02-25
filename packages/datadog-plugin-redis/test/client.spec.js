'use strict'

const agent = require('../../dd-trace/test/plugins/agent')

describe('Plugin', () => {
  let redis
  let client

  describe('redis', () => {
    withVersions('redis', '@node-redis/client', version => {
      describe('without configuration', () => {
        before(() => {
          return agent.load('redis')
        })

        after(() => {
          return agent.close({ ritmReset: false })
        })

        beforeEach(async () => {
          redis = require(`../../../versions/@node-redis/client@${version}`).get()
          client = redis.createClient()

          await client.connect()
        })

        afterEach(async () => {
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
            })

          await client.get('foo')
          await promise
        })

        it('should handle errors', async () => {
          let error

          const promise = agent.use(traces => {
            expect(traces[0][0].meta).to.have.property('error.type', error.name)
            expect(traces[0][0].meta).to.have.property('error.msg', error.message)
            expect(traces[0][0].meta).to.have.property('error.stack', error.stack)
          })

          try {
            await client.sendCommand('invalid')
          } catch (e) {
            error = e
          }

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
          redis = require(`../../../versions/@node-redis/client@${version}`).get()
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
