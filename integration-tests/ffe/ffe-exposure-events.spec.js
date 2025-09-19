'use strict'

const { createSandbox, FakeAgent, spawnProc } = require('../helpers')
const path = require('path')
const Axios = require('axios')
const { assert } = require('chai')

describe('FFE Exposure Events Export', () => {
  let axios, sandbox, cwd, appFile

  before(async function () {
    this.timeout(process.platform === 'win32' ? 90000 : 30000)

    sandbox = await createSandbox(
      ['express'],
      false,
      [path.join(__dirname, 'app')]
    )

    cwd = sandbox.folder
    appFile = path.join(cwd, 'app', 'exposure-events.js')
  })

  after(async function () {
    this.timeout(60000)
    await sandbox.remove()
  })

  describe('Agent mode via EVP proxy', () => {
    let agent, proc

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_FFE_ENABLED: true,
        }
      })
      axios = Axios.create({ baseURL: proc.url })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('should submit single exposure event via EVP proxy', async () => {
      const exposureReceived = new Promise((resolve) => {
        agent.once('exposures', ({ headers, payload }) => {
          resolve({ headers, payload })
        })
      })

      // Submit exposure event
      const response = await axios.get('/submit-exposure')
      assert.equal(response.status, 200)
      assert.equal(response.data.submitted, 1)

      // Trigger flush to ensure data is sent
      await axios.get('/flush')

      // Wait for exposure event to be received
      const { headers, payload } = await exposureReceived

      // Verify headers
      assert.equal(headers['content-type'], 'application/json')
      assert.equal(headers['x-datadog-evp-subdomain'], 'event-platform-intake')

      // Verify payload structure
      assert.isArray(payload)
      assert.equal(payload.length, 1)

      // Verify exposure event format
      const exposure = payload[0]
      assert.isNumber(exposure.timestamp)
      assert.deepEqual(exposure.allocation, { key: 'test_allocation_123' })
      assert.deepEqual(exposure.flag, { key: 'test_flag' })
      assert.deepEqual(exposure.variant, { key: 'variant_a' })
      assert.equal(exposure.subject.id, 'user_123')
      assert.equal(exposure.subject.type, 'user')
      assert.deepEqual(exposure.subject.attributes, { plan: 'premium' })
    })

    it('should submit multiple exposure events via EVP proxy', async () => {
      const exposureReceived = new Promise((resolve) => {
        agent.once('exposures', ({ headers, payload }) => {
          resolve({ headers, payload })
        })
      })

      // Submit multiple exposure events
      const response = await axios.get('/submit-multiple-exposures')
      assert.equal(response.status, 200)
      assert.equal(response.data.submitted, 3)

      // Trigger flush
      await axios.get('/flush')

      // Wait for exposure events to be received
      const { payload } = await exposureReceived

      // Verify payload contains all 3 events
      assert.equal(payload.length, 3)

      // Verify each exposure event
      const exposures = payload
      assert.deepEqual(exposures[0].allocation, { key: 'allocation_1' })
      assert.deepEqual(exposures[0].flag, { key: 'flag_1' })
      assert.deepEqual(exposures[0].variant, { key: 'control' })
      assert.equal(exposures[0].subject.id, 'user_1')

      assert.deepEqual(exposures[1].allocation, { key: 'allocation_2' })
      assert.deepEqual(exposures[1].flag, { key: 'flag_2' })
      assert.deepEqual(exposures[1].variant, { key: 'treatment' })
      assert.equal(exposures[1].subject.id, 'user_2')

      assert.deepEqual(exposures[2].allocation, { key: 'allocation_3' })
      assert.deepEqual(exposures[2].flag, { key: 'flag_3' })
      assert.deepEqual(exposures[2].variant, { key: 'variant_b' })
      assert.equal(exposures[2].subject.id, 'user_3')
      assert.deepEqual(exposures[2].subject.attributes, { tier: 'enterprise' })
    })

    it('should handle periodic flushing', async () => {
      let exposureCount = 0

      agent.on('exposures', ({ payload }) => {
        exposureCount += payload.length
      })

      // Submit exposure event but don't manually flush
      await axios.get('/submit-exposure')

      // Wait for periodic flush (writers default to 1s interval)
      await new Promise(resolve => setTimeout(resolve, 1500))

      assert.equal(exposureCount, 1)
    })
  })


  describe('Error handling', () => {
    let agent, proc

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_FFE_ENABLED: false // Disabled FFE
        }
      })
      axios = Axios.create({ baseURL: proc.url })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('should handle disabled FFE gracefully', async () => {
      try {
        await axios.get('/submit-exposure')
        throw new Error('Expected request to fail')
      } catch (error) {
        assert.equal(error.response.status, 500)
        assert.equal(error.response.data.error, 'FFE module not available')
      }
    })
  })

  describe('High volume scenarios', () => {
    let agent, proc

    beforeEach(async () => {
      agent = await new FakeAgent().start()
      proc = await spawnProc(appFile, {
        cwd,
        env: {
          DD_TRACE_AGENT_PORT: agent.port,
          DD_FFE_ENABLED: true,
          _DD_FFE_FLUSH_INTERVAL: 100 // Fast flush for testing
        }
      })
      axios = Axios.create({ baseURL: proc.url })
    })

    afterEach(async () => {
      proc.kill()
      await agent.stop()
    })

    it('should handle multiple rapid submissions', async () => {
      let totalExposures = 0

      agent.on('exposures', ({ payload }) => {
        totalExposures += payload.length
      })

      // Submit multiple batches rapidly
      const promises = []
      for (let i = 0; i < 5; i++) {
        promises.push(axios.get('/submit-multiple-exposures'))
      }

      await Promise.all(promises)

      // Wait for all flushes
      await new Promise(resolve => setTimeout(resolve, 500))

      // Should have received 5 batches × 3 events each = 15 events
      assert.equal(totalExposures, 15)
    })
  })
})
