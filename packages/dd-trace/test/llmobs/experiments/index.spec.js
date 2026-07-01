'use strict'

const assert = require('node:assert/strict')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { createExperiments } = require('../../../src/llmobs/experiments')
const NoopExperiments = require('../../../src/llmobs/experiments/noop')

const enabledConfig = (overrides = {}) => ({
  site: 'datadoghq.com',
  DD_API_KEY: 'k',
  DD_APP_KEY: 'a',
  llmobs: { DD_LLMOBS_ENABLED: true, mlApp: 'my-app' },
  ...overrides,
})

describe('LLMObs Experiments facade', () => {
  let originalFetch

  beforeEach(() => {
    originalFetch = global.fetch
    global.fetch = sinon.stub()
  })

  afterEach(() => {
    global.fetch = originalFetch
    sinon.restore()
  })

  describe('createExperiments gating', () => {
    it('returns a no-op when LLM Obs is disabled', () => {
      const exp = createExperiments({ llmobs: { DD_LLMOBS_ENABLED: false } })
      assert.ok(exp instanceof NoopExperiments)
      assert.throws(() => exp.createDataset('d'), /unavailable/)
    })

    it('returns a no-op when app key is missing', () => {
      const exp = createExperiments({ site: 's', DD_API_KEY: 'k', llmobs: { DD_LLMOBS_ENABLED: true } })
      assert.ok(exp instanceof NoopExperiments)
    })

    it('returns a working facade when enabled and credentialed', () => {
      const exp = createExperiments(enabledConfig())
      const dataset = exp.createDataset('d', 'desc')
      assert.equal(typeof dataset.addRecord, 'function')
      const experiment = exp.experiment({ name: 'n', dataset, task: (i) => i })
      assert.equal(typeof experiment.run, 'function')
    })
  })

  describe('no-op (disabled / missing keys)', () => {
    it('throws on every operation with a clear message', async () => {
      const exp = createExperiments({ llmobs: { DD_LLMOBS_ENABLED: false } })
      assert.throws(() => exp.createDataset('d'), /unavailable/)
      assert.throws(() => exp.experiment({}), /unavailable/)
      await assert.rejects(() => exp.pullDataset('d'), /unavailable/)
    })
  })

  describe('pullDataset', () => {
    const resolveRoutes = (recordsResponses) => {
      let recordsCall = 0
      global.fetch.callsFake(async (url) => {
        const u = new URL(url)
        let payload
        if (u.pathname === '/api/v2/llm-obs/v1/projects') {
          payload = { data: { id: 'proj' } }
        } else if (u.pathname === '/api/v2/llm-obs/v1/proj/datasets') {
          payload = { data: [{ id: 'ds9', attributes: { name: 'wanted', description: 'd' } }] }
        } else if (u.pathname === '/api/v2/llm-obs/v1/proj/datasets/ds9/records') {
          payload = recordsResponses[Math.min(recordsCall++, recordsResponses.length - 1)]
        } else {
          payload = {}
        }
        return { ok: true, status: 200, text: sinon.stub().resolves(JSON.stringify(payload)) }
      })
    }

    it('finds a dataset by name and reads records nested under attributes', async () => {
      resolveRoutes([{
        data: [
          { id: 'r1', attributes: { input: { q: '2+2' }, expected_output: '4', metadata: { a: 1 } } },
          { id: 'r2', attributes: { input: 'i2' } },
        ],
      }])

      const ds = await createExperiments(enabledConfig()).pullDataset('wanted')
      assert.equal(ds.id(), 'ds9')
      assert.equal(ds.projectId(), 'proj')
      assert.equal(ds.records().length, 2)
      assert.deepEqual(ds.records()[0].input, { q: '2+2' })
      assert.equal(ds.records()[0].expectedOutput, '4')
      assert.deepEqual(ds.records()[0].metadata, { a: 1 })
    })

    it('waits (backoff) until the expected record count is readable', async () => {
      const one = { data: [{ id: 'r1', attributes: { input: 'i1' } }] }
      const two = { data: [{ id: 'r1', attributes: { input: 'i1' } }, { id: 'r2', attributes: { input: 'i2' } }] }
      resolveRoutes([one, two])

      const ds = await createExperiments(enabledConfig()).pullDataset('wanted', {
        expectedRecordCount: 2,
        maxWaitMs: 5000,
      })
      assert.equal(ds.records().length, 2)
    })

    it('throws when the dataset is absent (no wait)', async () => {
      global.fetch.callsFake(async (url) => {
        const u = new URL(url)
        const payload = u.pathname === '/api/v2/llm-obs/v1/projects' ? { data: { id: 'proj' } } : { data: [] }
        return { ok: true, status: 200, text: sinon.stub().resolves(JSON.stringify(payload)) }
      })
      await assert.rejects(
        () => createExperiments(enabledConfig()).pullDataset('ghost', { maxWaitMs: 0 }),
        /not found/
      )
    })

    it('throws with the underlying error when listing datasets fails', async () => {
      global.fetch.callsFake(async (url) => {
        const u = new URL(url)
        if (u.pathname === '/api/v2/llm-obs/v1/projects') {
          return { ok: true, status: 200, text: sinon.stub().resolves(JSON.stringify({ data: { id: 'proj' } })) }
        }
        return { ok: false, status: 500, text: sinon.stub().resolves('server error') }
      })
      await assert.rejects(
        () => createExperiments(enabledConfig()).pullDataset('wanted', { maxWaitMs: 0 }),
        /Failed to list datasets/
      )
    })

    it('throws when the expected record count never arrives within the budget', async () => {
      resolveRoutes([{ data: [{ id: 'r1', attributes: { input: 'i1' } }] }]) // only ever 1 record
      await assert.rejects(
        () => createExperiments(enabledConfig()).pullDataset('wanted', { expectedRecordCount: 3, maxWaitMs: 0 }),
        /expected 3.*backend may not have finished ingesting/
      )
    })
  })
})
