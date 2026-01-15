'use strict'

const assert = require('node:assert/strict')

const path = require('path')
const Axios = require('axios')
const { sandboxCwd, useSandbox, FakeAgent, spawnProc } = require('../../../../../integration-tests/helpers')

describe('IAST - overhead-controller - integration', () => {
  let axios, cwd, agent, proc

  useSandbox(
    ['express'],
    false,
    [path.join(__dirname, 'resources')]
  )

  before(function () {
    cwd = sandboxCwd()
  })

  beforeEach(async () => {
    agent = await new FakeAgent().start()
  })

  afterEach(async () => {
    proc.kill()
    await agent.stop()
  })

  describe('vulnerability sampling algorithm', () => {
    beforeEach(async () => {
      proc = await spawnProc(path.join(cwd, 'resources', 'overhead-controller.js'), {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_IAST_ENABLED: 'true',
          DD_IAST_REQUEST_SAMPLING: '100',
          DD_TELEMETRY_HEARTBEAT_INTERVAL: '1',
          DD_TRACE_DEBUG: 'true',
          NODE_OPTIONS: '--require ./resources/init.js'
        }
      })
      axios = Axios.create({ baseURL: proc.url })
    })

    async function checkVulnerabilitiesInEndpoint (path, vulnerabilitiesAndCount, method = 'GET') {
      console.log('checkVulnerabilitiesInEndpoint', path, vulnerabilitiesAndCount, method)
      await axios.request(path, { method })
      console.log('request done')

      await agent.assertMessageReceived(({ payload }) => {
        // console.log('*** Payload length', payload[0].length)
        // console.log('*** Payload', payload[0][0])
        console.log('type', payload[0][0].type)
        assert.strictEqual(payload[0][0].type, 'web')
        console.log('iast enabled', payload[0][0].metrics['_dd.iast.enabled'])
        assert.strictEqual(payload[0][0].metrics['_dd.iast.enabled'], 1)
        console.log('iast json', Object.hasOwn(payload[0][0].meta, '_dd.iast.json'))
        assert.ok(Object.hasOwn(payload[0][0].meta, '_dd.iast.json'))
        const vulnerabilitiesTrace = JSON.parse(payload[0][0].meta['_dd.iast.json'])
        assert.notStrictEqual(vulnerabilitiesTrace, null)

        const vulnerabilities = {}
        vulnerabilitiesTrace.vulnerabilities.forEach(v => {
          const vulnCount = vulnerabilities[v.type]
          vulnerabilities[v.type] = vulnCount ? vulnCount + 1 : 1
        })

        console.log('obj length', Object.keys(vulnerabilities).length, Object.keys(vulnerabilitiesAndCount).length)
        assert.strictEqual(Object.keys(vulnerabilities).length, Object.keys(vulnerabilitiesAndCount).length)

        Object.keys(vulnerabilitiesAndCount).forEach((vType) => {
          console.log('vulns and count', vulnerabilities[vType], vulnerabilitiesAndCount[vType])
          assert.strictEqual(vulnerabilities[vType], vulnerabilitiesAndCount[vType], `route: ${path} - type: ${vType}`)
        })
      }, 5000, 1, true)
    }

    async function checkNoVulnerabilitiesInEndpoint (path, method = 'GET') {
      console.log('check NO VulnerabilitiesInEndpoint', path, method)
      await axios.request(path, { method })

      await agent.assertMessageReceived(({ payload }) => {
        console.log('type', payload[0][0].type)
        assert.strictEqual(payload[0][0].type, 'web')
        console.log('iast enabled', payload[0][0].metrics['_dd.iast.enabled'])
        assert.strictEqual(payload[0][0].metrics['_dd.iast.enabled'], 1)
        console.log('iast json', !('_dd.iast.json' in payload[0][0].meta))
        assert.ok(!('_dd.iast.json' in payload[0][0].meta))
      }, 1000, 1, true)
    }

    it('should report vulnerability only in the first request', async () => {
      await checkVulnerabilitiesInEndpoint('/one-vulnerability', { WEAK_HASH: 1 })
      await checkNoVulnerabilitiesInEndpoint('/one-vulnerability')
    })

    it('should report vulnerabilities in different request when they are different', async () => {
      await checkVulnerabilitiesInEndpoint('/five-vulnerabilities', { WEAK_HASH: 2 })
      await checkVulnerabilitiesInEndpoint('/five-vulnerabilities', { WEAK_HASH: 2 })
      await checkVulnerabilitiesInEndpoint('/five-vulnerabilities', { WEAK_HASH: 1 })

      await checkNoVulnerabilitiesInEndpoint('/five-vulnerabilities')
    })

    it('should differentiate different routes in the same request', async () => {
      await checkVulnerabilitiesInEndpoint('/route1/sub1', { WEAK_RANDOMNESS: 2 })
      await checkVulnerabilitiesInEndpoint('/route1/sub2', { WEAK_HASH: 2 })
      await checkVulnerabilitiesInEndpoint('/route1/sub1', { WEAK_HASH: 2 })

      await checkNoVulnerabilitiesInEndpoint('/route1/sub2')
      await checkNoVulnerabilitiesInEndpoint('/route1/sub1')
    })

    it('should differentiate different methods in the same route', async () => {
      await checkVulnerabilitiesInEndpoint('/five-vulnerabilities', { WEAK_HASH: 2 }, 'GET')
      await checkVulnerabilitiesInEndpoint('/five-vulnerabilities', { WEAK_HASH: 2 }, 'POST')
      await checkVulnerabilitiesInEndpoint('/five-vulnerabilities', { WEAK_HASH: 2 }, 'GET')
      await checkVulnerabilitiesInEndpoint('/five-vulnerabilities', { WEAK_HASH: 2 }, 'POST')
      await checkVulnerabilitiesInEndpoint('/five-vulnerabilities', { WEAK_HASH: 1 }, 'GET')
      await checkVulnerabilitiesInEndpoint('/five-vulnerabilities', { WEAK_HASH: 1 }, 'POST')

      await checkNoVulnerabilitiesInEndpoint('/five-vulnerabilities')
      await checkNoVulnerabilitiesInEndpoint('/five-vulnerabilities')
    })

    it('should not differentiate between different route params', async () => {
      await checkVulnerabilitiesInEndpoint('/route2/one', { WEAK_HASH: 2 })
      await checkVulnerabilitiesInEndpoint('/route2/two', { WEAK_HASH: 1 })

      await checkNoVulnerabilitiesInEndpoint('/route2/three')
    })
  })
})
