'use strict'

const assert = require('node:assert/strict')

const path = require('node:path')
const { inspect } = require('node:util')

const axios = require('axios')
const agent = require('../plugins/agent')
const appsec = require('../../src/appsec')
const { withSpanLeakBaseline } = require('../plugins/span-leak-detector')
const { getConfigFresh } = require('../helpers/config')
const { withVersions } = require('../../../dd-trace/test/setup/mocha')

withVersions('express', 'express', expressVersion => {
  describe('Attacker fingerprinting', () => {
    // Node's per-connection HTTP keep-alive timer captures the async-context
    // frame active when the request ran, so a fixed (non-scaling) number of
    // finished spans stays reachable at teardown. Tolerate it without loosening
    // the detector for other suites.
    withSpanLeakBaseline(25)

    let port, server

    before(() => {
      return agent.load(['express', 'http'], { client: false })
    })

    before((done) => {
      const express = require(`../../../../versions/express@${expressVersion}`).get()
      const bodyParser = require('../../../../versions/body-parser').get()

      const app = express()
      app.use(bodyParser.json())

      app.post('/', (req, res) => {
        res.end('DONE')
      })

      server = app.listen(port, () => {
        port = (/** @type {import('net').AddressInfo} */ (server.address())).port
        done()
      })
    })

    after(() => {
      server.close()
      return agent.close()
    })

    beforeEach(() => {
      appsec.enable(getConfigFresh(
        {
          appsec: {
            enabled: true,
            rules: path.join(__dirname, 'attacker-fingerprinting-rules.json'),
          },
        }
      ))
    })

    afterEach(() => {
      appsec.disable()
    })

    it('should report http fingerprints', async () => {
      await axios.post(
        `http://localhost:${port}/?key=testattack`,
        {
          bodyParam: 'bodyValue',
        },
        {
          headers: {
            'User-Agent': 'test-user-agent',
            headerName: 'headerValue',
            'x-real-ip': '255.255.255.255',
          },
        }
      )

      await agent.assertSomeTraces((traces) => {
        const span = traces[0][0]
        assert.ok(
          Object.hasOwn(span.meta, '_dd.appsec.fp.http.header'),
          `Available keys: ${inspect(Object.keys(span.meta))}`
        )
        assert.strictEqual(span.meta['_dd.appsec.fp.http.header'], 'hdr-0110000110-74c2908f-5-55682ec1')
        assert.ok(
          Object.hasOwn(span.meta, '_dd.appsec.fp.http.network'),
          `Available keys: ${inspect(Object.keys(span.meta))}`
        )
        assert.strictEqual(span.meta['_dd.appsec.fp.http.network'], 'net-1-0100000000')
        assert.ok(
          Object.hasOwn(span.meta, '_dd.appsec.fp.http.endpoint'),
          `Available keys: ${inspect(Object.keys(span.meta))}`
        )
        assert.strictEqual(span.meta['_dd.appsec.fp.http.endpoint'], 'http-post-8a5edab2-2c70e12b-be31090f')
      })
    })
  })
})
