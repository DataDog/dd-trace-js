'use strict'

const Axios = require('axios')
const { assert } = require('chai')
const getPort = require('get-port')
const path = require('path')

const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')

withVersions('fastify', 'fastify', fastifyVersion => {
  describe('Attacker fingerprinting', () => {
    let server, axios

    before(() => {
      return agent.load(['fastify', 'http'], { client: false })
    })

    before((done) => {
      const fastify = require(`../../../../versions/fastify@${fastifyVersion}`).get()

      const app = fastify()

      app.post('/', (request, reply) => {
        reply.send('DONE')
      })

      getPort().then((port) => {
        app.listen({ port }, () => {
          axios = Axios.create({ baseURL: `http://localhost:${port}` })
          done()
        })
        server = app.server
      })
    })

    after(() => {
      server.close()
      return agent.close({ ritmReset: false })
    })

    beforeEach(() => {
      appsec.enable(new Config(
        {
          appsec: {
            enabled: true,
            rules: path.join(__dirname, 'attacker-fingerprinting-rules.json')
          }
        }
      ))
    })

    afterEach(() => {
      appsec.disable()
    })

    it('should report http fingerprints', async () => {
      await axios.post('/?key=testattack',
        {
          headers: {
            'User-Agent': 'test-user-agent',
            headerName: 'headerValue',
            'x-real-ip': '255.255.255.255'
          }
        }
      )

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.property(span.meta, '_dd.appsec.fp.http.header')
        assert.equal(span.meta['_dd.appsec.fp.http.header'], 'hdr-0110000110-53e9b2ab-4-c348f529')
        assert.property(span.meta, '_dd.appsec.fp.http.network')
        assert.equal(span.meta['_dd.appsec.fp.http.network'], 'net-0-0000000000')
        assert.property(span.meta, '_dd.appsec.fp.http.endpoint')
        assert.equal(span.meta['_dd.appsec.fp.http.endpoint'], 'http-post-8a5edab2-2c70e12b-378f37b1')
      })
    })
  })
})
