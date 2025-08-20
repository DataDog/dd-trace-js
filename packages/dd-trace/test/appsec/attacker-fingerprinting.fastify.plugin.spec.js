'use strict'

const Axios = require('axios')
const { assert } = require('chai')
const path = require('path')

const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const Config = require('../../src/config')
const { withVersions } = require('../setup/mocha')

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

      app.listen({ port: 0 }, () => {
        const port = server.address().port
        axios = Axios.create({ baseURL: `http://localhost:${port}` })
        done()
      })
      server = app.server
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
          bodyParam: 'bodyValue'
        },
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
        assert.equal(span.meta['_dd.appsec.fp.http.header'], 'hdr-0110000110-74c2908f-5-55682ec1')
        assert.property(span.meta, '_dd.appsec.fp.http.network')
        assert.equal(span.meta['_dd.appsec.fp.http.network'], 'net-1-0100000000')
        assert.property(span.meta, '_dd.appsec.fp.http.endpoint')
        assert.equal(span.meta['_dd.appsec.fp.http.endpoint'], 'http-post-8a5edab2-2c70e12b-be31090f')
      })
    })
  })
})
