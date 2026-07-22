'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
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
      const dataset = exp.createDataset('d', {
        description: 'desc',
        records: [{ inputData: 'in', expectedOutput: 'out', metadata: { source: 'test' } }],
      })
      assert.equal(typeof dataset.addRecord, 'function')
      assert.equal(dataset.records()[0].input, 'in')
      const experiment = exp.experiment({ name: 'n', dataset, task: (i) => i })
      assert.equal(typeof experiment.run, 'function')
    })

    it('creates a dataset from selected CSV columns', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-llmobs-csv-'))
      const csvPath = path.join(dir, 'dataset.csv')
      fs.writeFileSync(csvPath, 'id;question;context;answer\nr1;"hello;world";ctx;ok\nr2;bye;ctx2;no\n')

      const calls = []
      global.fetch.callsFake(async (url, opts) => {
        const u = new URL(url)
        const body = opts.body ? JSON.parse(opts.body) : undefined
        calls.push({ method: opts.method, path: u.pathname, body })
        let payload = {}
        if (u.pathname === '/api/v2/llm-obs/v1/projects') {
          payload = { data: { id: 'proj' } }
        } else if (u.pathname === '/api/v2/llm-obs/v1/proj/datasets') {
          payload = { data: { id: 'ds' } }
        } else if (u.pathname === '/api/v2/llm-obs/v1/proj/datasets/ds/records') {
          payload = { records: [{ id: 'rec-1' }, { id: 'rec-2' }] }
        }
        return { ok: true, status: 200, text: sinon.stub().resolves(JSON.stringify(payload)) }
      })

      try {
        const dataset = createExperiments(enabledConfig()).createDatasetFromCsv(csvPath, 'csv-dataset', {
          inputDataColumns: ['question', 'context'],
          expectedOutputColumns: ['answer'],
          metadataColumns: ['id'],
          csvDelimiter: ';',
          description: 'from csv',
          idColumn: 'id',
        })

        assert.deepEqual(dataset.records()[0].input, { question: 'hello;world', context: 'ctx' })
        assert.deepEqual(dataset.records()[0].expectedOutput, { answer: 'ok' })
        assert.deepEqual(dataset.records()[0].metadata, { id: 'r1' })
        assert.equal(dataset.records()[0].id, 'r1')

        await dataset.push()

        const createCall = calls.find(call => call.path === '/api/v2/llm-obs/v1/proj/datasets')
        assert.equal(createCall.body.data.attributes.description, 'from csv')
        const recordsCall = calls.find(call => call.path === '/api/v2/llm-obs/v1/proj/datasets/ds/records')
        assert.deepEqual(recordsCall.body.data.attributes.records, [
          {
            id: 'r1',
            input: { question: 'hello;world', context: 'ctx' },
            expected_output: { answer: 'ok' },
            metadata: { id: 'r1' },
          },
          {
            id: 'r2',
            input: { question: 'bye', context: 'ctx2' },
            expected_output: { answer: 'no' },
            metadata: { id: 'r2' },
          },
        ])
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('validates CSV headers before creating a dataset', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-trace-llmobs-csv-'))
      const csvPath = path.join(dir, 'dataset.csv')
      fs.writeFileSync(csvPath, 'question,answer\nq,a\n')

      try {
        assert.throws(
          () => createExperiments(enabledConfig()).createDatasetFromCsv(csvPath, 'csv-dataset', {
            inputDataColumns: ['missing'],
          }),
          /Input columns not found in CSV header: missing/
        )
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('rejects duplicate custom record ids', () => {
      assert.throws(
        () => createExperiments(enabledConfig()).createDataset('d', {
          records: [{ id: 'r1', inputData: 'a' }, { id: 'r1', inputData: 'b' }],
        }),
        /Duplicate record id 'r1'/
      )
    })

    it('falls back to config.service for the project name when llmobs.mlApp is not set', async () => {
      global.fetch.callsFake(async () => ({
        ok: true,
        status: 200,
        text: sinon.stub().resolves(JSON.stringify({ data: { id: 'proj' } })),
      }))

      const exp = createExperiments(enabledConfig({ service: 'my-service', llmobs: { DD_LLMOBS_ENABLED: true } }))
      await exp.createDataset('d').push()

      const [url, opts] = global.fetch.getCall(0).args
      assert.equal(new URL(url).pathname, '/api/v2/llm-obs/v1/projects')
      assert.equal(JSON.parse(opts.body).data.attributes.name, 'my-service')
    })

    it('returns a no-op with actionable steps when neither mlApp nor service is set', () => {
      const exp = createExperiments(enabledConfig({ service: undefined, llmobs: { DD_LLMOBS_ENABLED: true } }))
      assert.ok(exp instanceof NoopExperiments)
      assert.throws(() => exp.createDataset('d'), /DD_LLMOBS_ML_APP.*DD_SERVICE/)
    })
  })

  describe('no-op (disabled / missing keys)', () => {
    it('throws on every operation with a clear message', async () => {
      const exp = createExperiments({ llmobs: { DD_LLMOBS_ENABLED: false } })
      assert.throws(() => exp.createDataset('d'), /unavailable/)
      assert.throws(() => exp.createDatasetFromCsv('d.csv', 'd', { inputDataColumns: ['input'] }), /unavailable/)
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

    it('passes explicit dataset version when reading records', async () => {
      global.fetch.callsFake(async (url) => {
        const u = new URL(url)
        let payload
        if (u.pathname === '/api/v2/llm-obs/v1/projects') {
          payload = { data: { id: 'proj' } }
        } else if (u.pathname === '/api/v2/llm-obs/v1/proj/datasets') {
          payload = { data: [{ id: 'ds9', attributes: { name: 'wanted', description: 'd', current_version: 7 } }] }
        } else if (u.pathname === '/api/v2/llm-obs/v1/proj/datasets/ds9/records') {
          assert.equal(u.searchParams.get('filter[version]'), '3')
          payload = { data: [{ id: 'r1', attributes: { input: 'i1' } }] }
        } else {
          payload = {}
        }
        return { ok: true, status: 200, text: sinon.stub().resolves(JSON.stringify(payload)) }
      })

      const ds = await createExperiments(enabledConfig()).pullDataset('wanted', { version: 3 })
      assert.equal(ds.version(), 3)
      assert.equal(ds.latestVersion(), 7)
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

    it('throws the underlying error when fetching records fails, even without expectedRecordCount', async () => {
      global.fetch.callsFake(async (url) => {
        const u = new URL(url)
        if (u.pathname === '/api/v2/llm-obs/v1/projects') {
          return { ok: true, status: 200, text: sinon.stub().resolves(JSON.stringify({ data: { id: 'proj' } })) }
        }
        if (u.pathname === '/api/v2/llm-obs/v1/proj/datasets') {
          const payload = { data: [{ id: 'ds9', attributes: { name: 'wanted', description: 'd' } }] }
          return { ok: true, status: 200, text: sinon.stub().resolves(JSON.stringify(payload)) }
        }
        return { ok: false, status: 504, text: sinon.stub().resolves('gateway timeout') }
      })
      await assert.rejects(
        () => createExperiments(enabledConfig()).pullDataset('wanted', { maxWaitMs: 0 }),
        /Failed to fetch records for dataset 'wanted'/
      )
    })

    it('follows the meta.after / page[cursor] pagination across multiple pages', async () => {
      const pages = {
        '': { data: [{ id: 'r1', attributes: { input: 'i1' } }], meta: { after: 'cursor1' } },
        cursor1: { data: [{ id: 'r2', attributes: { input: 'i2' } }], meta: { after: '' } },
      }
      global.fetch.callsFake(async (url) => {
        const u = new URL(url)
        let payload
        if (u.pathname === '/api/v2/llm-obs/v1/projects') {
          payload = { data: { id: 'proj' } }
        } else if (u.pathname === '/api/v2/llm-obs/v1/proj/datasets') {
          payload = { data: [{ id: 'ds9', attributes: { name: 'wanted', description: 'd' } }] }
        } else if (u.pathname === '/api/v2/llm-obs/v1/proj/datasets/ds9/records') {
          payload = pages[u.searchParams.get('page[cursor]') ?? '']
        } else {
          payload = {}
        }
        return { ok: true, status: 200, text: sinon.stub().resolves(JSON.stringify(payload)) }
      })

      const ds = await createExperiments(enabledConfig()).pullDataset('wanted')
      assert.deepEqual(ds.records().map((r) => r.input), ['i1', 'i2'])
      assert.deepEqual(ds.recordIds(), ['r1', 'r2'])
    })
  })
})
