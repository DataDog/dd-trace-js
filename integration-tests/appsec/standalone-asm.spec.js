'use strict'

const assert = require('node:assert/strict')
const path = require('path')

const {
  sandboxCwd,
  useSandbox,
  FakeAgent,
  spawnProc,
  curlAndAssertMessage,
  curl
} = require('../helpers')
const { USER_KEEP, AUTO_REJECT, AUTO_KEEP } = require('../../ext/priority')

describe('Standalone ASM', () => {
  let cwd, startupTestFile, agent, proc, env

  useSandbox(['express'])

  before(() => {
    cwd = sandboxCwd()
    startupTestFile = path.join(cwd, 'standalone-asm/index.js')
  })

  function assertKeep ({ meta, metrics }) {
    assert.strictEqual(meta['_dd.p.ts'], '02')

    assert.strictEqual(metrics._sampling_priority_v1, USER_KEEP)
    assert.strictEqual(metrics['_dd.apm.enabled'], 0)
  }

  function assertDrop ({ meta, metrics }) {
    assert.ok(!Object.hasOwn(meta, '_dd.p.ts'))

    assert.strictEqual(metrics._sampling_priority_v1, AUTO_REJECT)
    assert.strictEqual(metrics['_dd.apm.enabled'], 0)
  }

  async function doWarmupRequests (procOrUrl, number = 3) {
    for (let i = number; i > 0; i--) {
      await curl(procOrUrl)
    }
  }

  describe('enabled', () => {
    beforeEach(async () => {
      agent = await new FakeAgent().start()

      env = {
        AGENT_PORT: agent.port,
        DD_APM_TRACING_ENABLED: 'false',
        DD_APPSEC_ENABLED: 'true',
        DD_API_SECURITY_ENABLED: 'false'
      }

      const execArgv = []

      proc = await spawnProc(startupTestFile, { cwd, env, execArgv })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    // first req initializes the waf and reports the first appsec event adding manual.keep tag
    it('should send correct headers and tags on first req', async () => {
      return curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.strictEqual(headers['datadog-client-computed-stats'], 'yes')
        assert.ok(Array.isArray(payload))
        assert.strictEqual(payload.length, 1)
        assert.ok(Array.isArray(payload[0]))

        // express.request + router.middleware x 2
        assert.strictEqual(payload[0].length, 3)

        assertKeep(payload[0][0])
      })
    })

    it('should keep fifth req because RateLimiter allows 1 req/min', async () => {
      const promise = curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.strictEqual(headers['datadog-client-computed-stats'], 'yes')
        assert.ok(Array.isArray(payload))
        if (payload.length === 4) {
          assertKeep(payload[0][0])
          assertDrop(payload[1][0])
          assertDrop(payload[2][0])
          assertDrop(payload[3][0])

          // req after a minute
        } else {
          const fifthReq = payload[0]
          assert.ok(Array.isArray(fifthReq))
          assert.strictEqual(fifthReq.length, 3)

          const { meta, metrics } = fifthReq[0]
          assert.ok(!Object.hasOwn(meta, 'manual.keep'))
          assert.ok(!Object.hasOwn(meta, '_dd.p.ts'))

          assert.strictEqual(metrics._sampling_priority_v1, AUTO_KEEP)
          assert.strictEqual(metrics['_dd.apm.enabled'], 0)
        }
      }, 70000, 2)

      // 1st req kept because waf init
      // next in the first minute are dropped
      // 5nd req kept because RateLimiter allows 1 req/min
      await doWarmupRequests(proc)

      await new Promise(resolve => setTimeout(resolve, 60000))

      await curl(proc)

      return promise
    }).timeout(70000)

    it('should keep attack requests', async () => {
      await doWarmupRequests(proc)

      const urlAttack = proc.url + '?query=1 or 1=1'
      return curlAndAssertMessage(agent, urlAttack, ({ headers, payload }) => {
        assert.strictEqual(headers['datadog-client-computed-stats'], 'yes')
        assert.ok(Array.isArray(payload))
        assert.strictEqual(payload.length, 4)

        assertKeep(payload[3][0])
      })
    })

    it('should keep sdk events', async () => {
      await doWarmupRequests(proc)

      const url = proc.url + '/login?user=test'
      return curlAndAssertMessage(agent, url, ({ headers, payload }) => {
        assert.strictEqual(headers['datadog-client-computed-stats'], 'yes')
        assert.ok(Array.isArray(payload))
        assert.strictEqual(payload.length, 4)

        assertKeep(payload[3][0])
      })
    })

    it('should keep custom sdk events', async () => {
      await doWarmupRequests(proc)

      const url = proc.url + '/sdk'
      return curlAndAssertMessage(agent, url, ({ headers, payload }) => {
        assert.strictEqual(headers['datadog-client-computed-stats'], 'yes')
        assert.ok(Array.isArray(payload))
        assert.strictEqual(payload.length, 4)

        assertKeep(payload[3][0])
      })
    })

    it('should keep iast events', async () => {
      await doWarmupRequests(proc)

      const url = proc.url + '/vulnerableHash'
      return curlAndAssertMessage(agent, url, ({ headers, payload }) => {
        assert.strictEqual(headers['datadog-client-computed-stats'], 'yes')
        assert.ok(Array.isArray(payload))
        assert.strictEqual(payload.length, 4)

        const expressReq4 = payload[3][0]
        assertKeep(expressReq4)
        assert.ok(Object.hasOwn(expressReq4.meta, '_dd.iast.json'))
        assert.strictEqual(expressReq4.metrics['_dd.iast.enabled'], 1)
      })
    })

    describe('propagation', () => {
      let proc2
      let port2

      beforeEach(async () => {
        const execArgv = []

        proc2 = await spawnProc(startupTestFile, { cwd, env, execArgv })

        port2 = parseInt(proc2.url.substring(proc2.url.lastIndexOf(':') + 1), 10)
      })

      afterEach(async () => {
        proc2.kill()
      })

      // proc/drop-and-call-sdk:
      // after setting a manual.drop calls to downstream proc2/sdk which triggers an appsec event
      it('should keep trace even if parent prio is -1 but there is an event in the local trace', async () => {
        await doWarmupRequests(proc)
        await doWarmupRequests(proc2)

        const url = `${proc.url}/propagation-after-drop-and-call-sdk?port=${port2}`
        return curlAndAssertMessage(agent, url, ({ headers, payload }) => {
          assert.strictEqual(headers['datadog-client-computed-stats'], 'yes')
          assert.ok(Array.isArray(payload))

          const innerReq = payload.find(p => p[0].resource === 'GET /sdk')
          assert.notStrictEqual(innerReq, undefined)
          assertKeep(innerReq[0])
        }, undefined, undefined, true)
      })

      // proc/propagation-with-event triggers an appsec event and calls downstream proc2/down with no event
      it('should keep if parent trace is (prio:2, _dd.p.ts:02) but there is no event in the local trace',
        async () => {
          await doWarmupRequests(proc)
          await doWarmupRequests(proc2)

          const url = `${proc.url}/propagation-with-event?port=${port2}`
          return curlAndAssertMessage(agent, url, ({ headers, payload }) => {
            assert.strictEqual(headers['datadog-client-computed-stats'], 'yes')
            assert.ok(Array.isArray(payload))

            const innerReq = payload.find(p => p[0].resource === 'GET /down')
            assert.notStrictEqual(innerReq, undefined)
            assertKeep(innerReq[0])
          }, undefined, undefined, true)
        })

      it('should remove parent trace data if there is no event in the local trace', async () => {
        await doWarmupRequests(proc)
        await doWarmupRequests(proc2)

        const url = `${proc.url}/propagation-without-event?port=${port2}`
        return curlAndAssertMessage(agent, url, ({ headers, payload }) => {
          assert.strictEqual(headers['datadog-client-computed-stats'], 'yes')
          assert.ok(Array.isArray(payload))

          const innerReq = payload.find(p => p[0].resource === 'GET /down')
          assert.notStrictEqual(innerReq, undefined)
          assert.ok(!Object.hasOwn(innerReq[0].meta, '_dd.p.other'))
        }, undefined, undefined, true)
      })

      it('should not remove parent trace data if there is event in the local trace', async () => {
        await doWarmupRequests(proc)

        const url = `${proc.url}/propagation-with-event?port=${port2}`
        return curlAndAssertMessage(agent, url, ({ headers, payload }) => {
          assert.strictEqual(headers['datadog-client-computed-stats'], 'yes')
          assert.ok(Array.isArray(payload))

          const innerReq = payload.find(p => p[0].resource === 'GET /down')
          assert.notStrictEqual(innerReq, undefined)
          assert.ok(Object.hasOwn(innerReq[0].meta, '_dd.p.other'))
        }, undefined, undefined, true)
      })
    })
  })

  describe('With API Security enabled', () => {
    beforeEach(async () => {
      agent = await new FakeAgent().start()

      env = {
        AGENT_PORT: agent.port,
        DD_APM_TRACING_ENABLED: 'false',
        DD_APPSEC_ENABLED: 'true'
      }

      const execArgv = []

      proc = await spawnProc(startupTestFile, { cwd, env, execArgv })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('should keep fifth req because of api security sampler', async () => {
      const promise = curlAndAssertMessage(agent, proc, ({ headers, payload }) => {
        assert.strictEqual(headers['datadog-client-computed-stats'], 'yes')
        assert.ok(Array.isArray(payload))
        if (payload.length === 4) {
          assertKeep(payload[0][0])
          assertDrop(payload[1][0])
          assertDrop(payload[2][0])
          assertDrop(payload[3][0])

          // req after 30s
        } else {
          const fifthReq = payload[0]
          assert.ok(Array.isArray(fifthReq))
          assert.strictEqual(fifthReq.length, 3)
          assertKeep(fifthReq[0])
        }
      }, 40000, 2)

      // 1st req kept because waf init
      // next in the 30s are dropped
      // 5nd req manual kept because of api security sampler
      await doWarmupRequests(proc)

      await new Promise(resolve => setTimeout(resolve, 30000))

      await curl(proc)

      return promise
    }).timeout(40000)
  })

  describe('disabled', () => {
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
      const url = proc.url + '/vulnerableHash'
      return curlAndAssertMessage(agent, url, ({ headers, payload }) => {
        assert.ok(!Object.hasOwn(headers, 'datadog-client-computed-stats'))
        assert.ok(Array.isArray(payload))
        assert.strictEqual(payload.length, 1)
        assert.ok(Array.isArray(payload[0]))

        // express.request + router.middleware x 2
        assert.strictEqual(payload[0].length, 3)

        const { meta, metrics } = payload[0][0]
        assert.ok(Object.hasOwn(meta, '_dd.iast.json')) // WEAK_HASH and XCONTENTTYPE_HEADER_MISSING reported

        assert.ok(!Object.hasOwn(meta, '_dd.p.ts'))
        assert.ok(!Object.hasOwn(metrics, '_dd.apm.enabled'))
      })
    })

    it('should not add standalone related tags in appsec events', () => {
      const urlAttack = proc.url + '?query=1 or 1=1'

      return curlAndAssertMessage(agent, urlAttack, ({ headers, payload }) => {
        assert.ok(!Object.hasOwn(headers, 'datadog-client-computed-stats'))
        assert.ok(Array.isArray(payload))
        assert.strictEqual(payload.length, 1)
        assert.ok(Array.isArray(payload[0]))

        // express.request + router.middleware x 2
        assert.strictEqual(payload[0].length, 3)

        const { meta, metrics } = payload[0][0]
        assert.ok(Object.hasOwn(meta, '_dd.appsec.json')) // crs-942-100 triggered

        assert.ok(!Object.hasOwn(meta, '_dd.p.ts'))
        assert.ok(!Object.hasOwn(metrics, '_dd.apm.enabled'))
      })
    })
  })
})
