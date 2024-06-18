'use strict'

const { assert } = require('chai')
const path = require('path')

const {
  createSandbox,
  FakeAgent,
  spawnProc,
  curlAndAssertMessage,
  curl
} = require('./helpers')

describe('Standalone ASM', () => {
  let sandbox, cwd, startupTestFile, agent, proc, env, port
  before(async () => {
    sandbox = await createSandbox(['express'], true)
    cwd = sandbox.folder
    startupTestFile = path.join(cwd, 'standalone-asm/index.js')
  })

  after(async () => {
    await sandbox.remove()
  })

  context('enabled', () => {
    beforeEach(async () => {
      agent = await new FakeAgent().start()

      env = {
        AGENT_PORT: agent.port,
        DD_EXPERIMENTAL_APPSEC_STANDALONE_ENABLED: 'true'
      }

      const execArgv = []

      proc = await spawnProc(startupTestFile, { cwd, env, execArgv })

      port = parseInt(proc.url.substring(proc.url.lastIndexOf(':') + 1), 10)
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    function assertKeep (payload, manual = true) {
      const { meta, metrics } = payload
      assert.propertyVal(meta, '_dd.p.dm', '-5')
      if (manual) {
        assert.propertyVal(meta, 'manual.keep', 'true')
      }
      assert.propertyVal(meta, '_dd.p.appsec', '1')

      assert.propertyVal(metrics, '_sampling_priority_v1', 2)
      assert.propertyVal(metrics, '_dd.apm.enabled', 0)
    }

    function assertDrop (payload) {
      const { metrics } = payload
      assert.propertyVal(metrics, '_sampling_priority_v1', 0)
      assert.propertyVal(metrics, '_dd.apm.enabled', 0)
      assert.notProperty(metrics, '_dd.p.appsec')
    }

    async function doRequests (procOrUrl, number = 3) {
      for (let i = number; i > 0; i--) {
        await curl(procOrUrl)
      }
    }

    // first req initializes the waf and reports the first appsec event adding manual.keep tag
    it('should send correct headers and tags on first req', async () => {
      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'datadog-client-computed-stats', 'yes')
        assert.isArray(payload)
        assert.strictEqual(payload.length, 1)
        assert.isArray(payload[0])

        // express.request + 4 middlewares
        assert.strictEqual(payload[0].length, 5)

        assertKeep(payload[0][0])
      })
    })

    it('should keep second req because RateLimiter allows 1 req/min and discard the next', async () => {
      // 1st req kept because waf init
      // 2nd req kept because it's the first one hitting RateLimiter
      // next in the first minute are dropped
      await doRequests(proc)

      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.propertyVal(headers, 'datadog-client-computed-stats', 'yes')
        assert.isArray(payload)
        assert.strictEqual(payload.length, 4)

        const secondReq = payload[1]
        assert.isArray(secondReq)
        assert.strictEqual(secondReq.length, 5)

        const { meta, metrics } = secondReq[0]
        assert.propertyVal(meta, '_dd.p.dm', '-5')
        assert.notProperty(meta, 'manual.keep')
        assert.notProperty(meta, '_dd.p.appsec')

        assert.propertyVal(metrics, '_sampling_priority_v1', 1)
        assert.propertyVal(metrics, '_dd.apm.enabled', 0)

        assertDrop(payload[2][0])

        assertDrop(payload[3][0])
      })
    })

    it('should keep attack requests', async () => {
      await doRequests(proc)

      const urlAttack = proc.url + '?query=1 or 1=1'
      return curlAndAssertMessage(agent, urlAttack, ({ headers, payload }) => {
        assert.propertyVal(headers, 'datadog-client-computed-stats', 'yes')
        assert.isArray(payload)
        assert.strictEqual(payload.length, 4)

        assertKeep(payload[3][0])
      })
    })

    it('should keep sdk events', async () => {
      await doRequests(proc)

      const url = proc.url + '/login?user=test'
      return curlAndAssertMessage(agent, url, ({ headers, payload }) => {
        assert.propertyVal(headers, 'datadog-client-computed-stats', 'yes')
        assert.isArray(payload)
        assert.strictEqual(payload.length, 4)

        assertKeep(payload[3][0])
      })
    })

    it('should keep custom sdk events', async () => {
      await doRequests(proc)

      const url = proc.url + '/sdk'
      return curlAndAssertMessage(agent, url, ({ headers, payload }) => {
        assert.propertyVal(headers, 'datadog-client-computed-stats', 'yes')
        assert.isArray(payload)
        assert.strictEqual(payload.length, 4)

        assertKeep(payload[3][0])
      })
    })

    it('should keep iast events', async () => {
      await doRequests(proc)

      const url = proc.url + '/vulnerableReadFile?filename=./readFile.js'
      return curlAndAssertMessage(agent, url, ({ headers, payload }) => {
        assert.propertyVal(headers, 'datadog-client-computed-stats', 'yes')
        assert.isArray(payload)
        assert.strictEqual(payload.length, 4)

        const expressReq4 = payload[3][0]
        assertKeep(expressReq4)
        assert.property(expressReq4.meta, '_dd.iast.json')
        assert.propertyVal(expressReq4.metrics, '_dd.iast.enabled', 1)
      })
    })

    context('propagation', () => {
      const traceId = '12312312'
      const parentId = '42424242'

      it('should keep trace even if parent prio is -1', async () => {
        await doRequests(proc)

        const options = {
          url: {
            host: 'localhost',
            port,
            path: '/sdk',
            headers: {
              'x-datadog-trace-id': traceId,
              'x-datadog-parent-id': parentId,
              'x-datadog-sampling-priority': '-1'
            }
          }
        }
        return curlAndAssertMessage(agent, options, ({ headers, payload }) => {
          assert.propertyVal(headers, 'datadog-client-computed-stats', 'yes')
          assert.isArray(payload)
          assert.strictEqual(payload.length, 4)

          const expressReq4 = payload[3][0]
          assertKeep(expressReq4)
        })
      })

      it('should keep if parent trace is (prio:2, _dd.p.appsec:1) but there is no ev in the local trace', async () => {
        await doRequests(proc)

        const options = {
          url: {
            host: 'localhost',
            port,
            path: '/',
            headers: {
              'x-datadog-trace-id': traceId,
              'x-datadog-parent-id': parentId,
              'x-datadog-sampling-priority': '2',
              'x-datadog-tags': '_dd.p.appsec=1,_dd.p.dm=-5'
            }
          }
        }
        return curlAndAssertMessage(agent, options, ({ headers, payload }) => {
          assert.propertyVal(headers, 'datadog-client-computed-stats', 'yes')
          assert.isArray(payload)
          assert.strictEqual(payload.length, 4)

          const expressReq4 = payload[3][0]
          assertKeep(expressReq4, false)
        })
      })

      it('should remove parent trace data if there is no ev in the local trace', async () => {
        await doRequests(proc)

        const url = `${proc.url}/propagation-without-event`
        return curlAndAssertMessage(agent, url, ({ headers, payload }) => {
          assert.propertyVal(headers, 'datadog-client-computed-stats', 'yes')
          assert.isArray(payload)
          assert.strictEqual(payload.length, 5)

          const downReq = payload[3][0]
          assert.notProperty(downReq.meta, '_dd.p.other')
        })
      })

      it('should not remove parent trace data if there is ev in the local trace', async () => {
        await doRequests(proc)

        const url = `${proc.url}/propagation-with-event`
        return curlAndAssertMessage(agent, url, ({ headers, payload }) => {
          assert.propertyVal(headers, 'datadog-client-computed-stats', 'yes')
          assert.isArray(payload)
          assert.strictEqual(payload.length, 5)

          const downReq = payload[3][0]
          assert.property(downReq.meta, '_dd.p.other')
        })
      })
    })
  })

  context('disabled', () => {
    beforeEach(async () => {
      agent = await new FakeAgent().start()

      env = {
        AGENT_PORT: agent.port
      }

      proc = await spawnProc(startupTestFile, { cwd, env })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('should not add standalone related tags in iast events', () => {
      const url = proc.url + '/vulnerableReadFile?filename=./readFile.js'
      return curlAndAssertMessage(agent, url, ({ headers, payload }) => {
        assert.notProperty(headers, 'datadog-client-computed-stats')
        assert.isArray(payload)
        assert.strictEqual(payload.length, 1)
        assert.isArray(payload[0])

        // express.request + 4 middlewares
        assert.strictEqual(payload[0].length, 5)

        const { meta, metrics } = payload[0][0]
        assert.property(meta, '_dd.iast.json') // PATH_TRAVERSAL and XCONTENTTYPE_HEADER_MISSING reported

        assert.notProperty(meta, '_dd.p.appsec')
        assert.notProperty(metrics, '_dd.apm.enabled')
      })
    })

    it('should not add standalone related tags in appsec events', () => {
      const urlAttack = proc.url + '?query=1 or 1=1'

      return curlAndAssertMessage(agent, urlAttack, ({ headers, payload }) => {
        assert.notProperty(headers, 'datadog-client-computed-stats')
        assert.isArray(payload)
        assert.strictEqual(payload.length, 1)
        assert.isArray(payload[0])

        // express.request + 4 middlewares
        assert.strictEqual(payload[0].length, 5)

        const { meta, metrics } = payload[0][0]
        assert.property(meta, '_dd.appsec.json') // crs-942-100 triggered

        assert.notProperty(meta, '_dd.p.appsec')
        assert.notProperty(metrics, '_dd.apm.enabled')
      })
    })
  })
})
