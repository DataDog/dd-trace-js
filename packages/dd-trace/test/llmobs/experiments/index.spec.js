'use strict'

const assert = require('node:assert/strict')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const log = require('../../../src/log')
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
  let fetchHandler
  let fetchStub
  let originalFetch

  beforeEach(() => {
    originalFetch = global.fetch
    fetchHandler = async (url) => {
      throw new Error(`Unexpected fetch ${url}`)
    }
    fetchStub = sinon.stub().callsFake((...args) => fetchHandler(...args))
    global.fetch = fetchStub
  })

  afterEach(() => {
    global.fetch = originalFetch
    sinon.restore()
  })

  const resolveFetchWith = (handler) => {
    fetchHandler = handler
  }

  describe('createExperiments gating', () => {
    it('returns a no-op when LLM Obs is disabled', () => {
      const warn = sinon.spy(log, 'warn')
      const exp = createExperiments({ llmobs: { DD_LLMOBS_ENABLED: false } })
      assert.ok(exp instanceof NoopExperiments)

      const dataset = exp.createDataset('d', { records: [{ inputData: 'in' }] })

      assert.equal(dataset.name(), 'd')
      assert.equal(dataset.records()[0].input, 'in')
      sinon.assert.calledWith(warn, sinon.match(/LLMObs experiments unavailable/))
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

    it('rejects duplicate custom record ids', () => {
      assert.throws(
        () => createExperiments(enabledConfig()).createDataset('d', {
          records: [{ id: 'r1', inputData: 'a' }, { id: 'r1', inputData: 'b' }],
        }),
        /Duplicate record id 'r1'/
      )
    })

    it('falls back to config.service for the project name when llmobs.mlApp is not set', async () => {
      resolveFetchWith(async () => ({
        ok: true,
        status: 200,
        text: sinon.stub().resolves(JSON.stringify({ data: { id: 'proj' } })),
      }))

      const exp = createExperiments(enabledConfig({ service: 'my-service', llmobs: { DD_LLMOBS_ENABLED: true } }))
      await exp.createDataset('d').push()

      const [url, opts] = fetchStub.getCall(0).args
      assert.equal(new URL(url).pathname, '/api/v2/llm-obs/v1/projects')
      assert.equal(JSON.parse(opts.body).data.attributes.name, 'my-service')
    })

    it('returns a no-op with actionable steps when neither mlApp nor service is set', () => {
      const warn = sinon.spy(log, 'warn')
      const exp = createExperiments(enabledConfig({ service: undefined, llmobs: { DD_LLMOBS_ENABLED: true } }))
      assert.ok(exp instanceof NoopExperiments)

      exp.createDataset('d')

      sinon.assert.calledWith(warn, sinon.match(/DD_LLMOBS_ML_APP.*DD_SERVICE/))
    })
  })

  describe('no-op (disabled / missing keys)', () => {
    it('warns and returns inert objects for every operation', async () => {
      const warn = sinon.spy(log, 'warn')
      const exp = createExperiments({ llmobs: { DD_LLMOBS_ENABLED: false } })

      const dataset = exp.createDataset('d')
      assert.deepEqual(await dataset.push(), { pushedCount: 0, totalCount: 0 })
      assert.equal(dataset.url(), null)

      const pulled = await exp.pullDataset('d')
      assert.equal(pulled.name(), 'd')

      const experiment = exp.experiment({ name: 'exp' })
      assert.equal(experiment.name(), 'exp')
      assert.deepEqual(await experiment.run(), { experimentId: null, rows: [], url: null })
      sinon.assert.calledThrice(warn)
    })

    it('models inert datasets and experiments with stable accessors', async () => {
      const warn = sinon.spy(log, 'warn')
      const exp = new NoopExperiments()

      const ignoredDescriptionDataset = exp.createDataset('legacy description', 'ignored')
      assert.deepEqual(ignoredDescriptionDataset.records(), [])

      const dataset = exp.createDataset('d', {
        records: [{
          id: 'r1',
          inputData: { question: 'q' },
          expectedOutput: { answer: 'a' },
          metadata: { source: 'test' },
        }],
      })
      dataset.addRecord('input only')

      assert.equal(dataset.name(), 'd')
      assert.equal(dataset.id(), null)
      assert.equal(dataset.projectId(), null)
      assert.equal(dataset.version(), null)
      assert.equal(dataset.latestVersion(), null)
      assert.deepEqual(dataset.recordIds(), [])
      assert.equal(dataset.url(), null)
      assert.deepEqual(dataset.records(), [
        {
          id: 'r1',
          input: { question: 'q' },
          expectedOutput: { answer: 'a' },
          metadata: { source: 'test' },
        },
        { id: null, input: 'input only', expectedOutput: null, metadata: {} },
      ])
      assert.deepEqual(await dataset.push(), { pushedCount: 0, totalCount: 0 })

      const pulled = await exp.pullDataset('pulled')
      assert.equal(pulled.name(), 'pulled')

      const experiment = exp.experiment()
      assert.equal(experiment.name(), '')
      assert.equal(experiment.experimentId(), null)
      assert.equal(experiment.url(), null)
      assert.deepEqual(await experiment.run(), { experimentId: null, rows: [], url: null })
      sinon.assert.callCount(warn, 4)
    })
  })

  describe('pullDataset', () => {
    const resolveRoutes = (recordsResponses) => {
      let recordsCall = 0
      resolveFetchWith(async (url) => {
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
      assert.equal(ds.records()[0].id, 'r1')
      assert.equal(ds.records()[1].id, 'r2')
    })

    it('passes explicit dataset version when reading records', async () => {
      resolveFetchWith(async (url) => {
        const u = new URL(url)
        let payload
        if (u.pathname === '/api/v2/llm-obs/v1/projects') {
          payload = { data: { id: 'proj' } }
        } else if (u.pathname === '/api/v2/llm-obs/v1/proj/datasets') {
          payload = { data: [{ id: 'ds9', attributes: { name: 'wanted', description: 'd', current_version: 7 } }] }
        } else if (u.pathname === '/api/v2/llm-obs/v1/proj/datasets/ds9/records') {
          assert.match(url, /\/records\?filter%5Bversion%5D=3$/)
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

    it('pins the current version when pulling latest records', async () => {
      resolveFetchWith(async (url) => {
        const u = new URL(url)
        let payload
        if (u.pathname === '/api/v2/llm-obs/v1/projects') {
          payload = { data: { id: 'proj' } }
        } else if (u.pathname === '/api/v2/llm-obs/v1/proj/datasets') {
          payload = { data: [{ id: 'ds9', attributes: { name: 'wanted', description: 'd', current_version: 7 } }] }
        } else if (u.pathname === '/api/v2/llm-obs/v1/proj/datasets/ds9/records') {
          assert.equal(u.searchParams.get('filter[version]'), '7')
          payload = { data: [{ id: 'r1', attributes: { input: 'i1' } }] }
        } else {
          payload = {}
        }
        return { ok: true, status: 200, text: sinon.stub().resolves(JSON.stringify(payload)) }
      })

      const ds = await createExperiments(enabledConfig()).pullDataset('wanted')
      assert.equal(ds.version(), 7)
      assert.equal(ds.records().length, 1)
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
      resolveFetchWith(async (url) => {
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
      resolveFetchWith(async (url) => {
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
      resolveFetchWith(async (url) => {
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
      resolveFetchWith(async (url) => {
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

  describe('externally-driven experiments', () => {
    function resolveExperimentRoutes () {
      global.fetch.callsFake(async (url, options) => {
        const u = new URL(url)
        let payload = {}
        if (u.pathname === '/api/v2/llm-obs/v1/projects') {
          payload = { data: { id: 'proj' } }
        } else if (u.pathname === '/api/v2/llm-obs/v1/proj/datasets' && options.method === 'POST') {
          payload = { data: { id: 'dataset', attributes: { current_version: 1 } } }
        } else if (u.pathname === '/api/v2/llm-obs/v1/experiments' && options.method === 'POST') {
          payload = { data: { id: 'exp' } }
        }
        return { ok: true, status: 200, text: sinon.stub().resolves(JSON.stringify(payload)) }
      })
    }

    it('starts an experiment, submits a generated row span, and submits metrics for that span', async () => {
      resolveExperimentRoutes()

      const recorder = await createExperiments(enabledConfig()).startExperiment({
        name: 'eve-run',
        description: 'eve eval run',
        tags: { source: 'eve' },
        metadata: { suite: 'smoke' },
        config: { revision: 'abc123' },
      })
      assert.equal(recorder.experimentId, 'exp')
      assert.equal(recorder.url(), 'https://app.datadoghq.com/llm/experiments/exp')

      const span = await recorder.submitSpan({
        id: 'smoke',
        name: 'smoke eval',
        input: 'Say hello.',
        output: { message: 'hello' },
        expectedOutput: 'hello',
        metadata: { verdict: 'passed' },
        tags: { eval: 'smoke' },
        startedAt: '2026-01-01T00:00:00.000Z',
        completedAt: '2026-01-01T00:00:01.000Z',
      })

      assert.equal(span.experimentId, 'exp')
      assert.match(span.spanId, /^[a-f0-9]{16}$/)
      assert.match(span.traceId, /^[a-f0-9]{32}$/)

      await recorder.submitEvaluationMetrics(span, [
        { label: 'gate:succeeded', value: true },
        { label: 'similarity', value: 0.92 },
        { label: 'verdict', value: 'passed' },
        { label: 'details', value: { assertions: 3 } },
        { label: 'judge_error', error: 'judge unavailable' },
      ])
      await recorder.close({ status: 'completed' })

      const datasetBody = JSON.parse(global.fetch.getCall(1).args[1].body)
      assert.deepEqual(datasetBody.data.attributes, {
        name: 'eve-run dataset',
        description: "Placeholder dataset for externally-driven experiment 'eve-run'",
      })

      const createBody = JSON.parse(global.fetch.getCall(2).args[1].body)
      assert.deepEqual(createBody.data.attributes, {
        name: 'eve-run',
        project_id: 'proj',
        dataset_id: 'dataset',
        description: 'eve eval run',
        ensure_unique: true,
        dataset_version: 1,
        config: { revision: 'abc123' },
        metadata: { suite: 'smoke' },
        tags: { source: 'eve' },
      })

      const spanBody = JSON.parse(global.fetch.getCall(3).args[1].body)
      const submittedSpan = spanBody.data.attributes.spans[0]
      assert.equal(submittedSpan.span_id, span.spanId)
      assert.equal(submittedSpan.trace_id, span.traceId)
      assert.equal(submittedSpan.project_id, 'proj')
      assert.equal(submittedSpan.name, 'smoke eval')
      assert.equal(submittedSpan.start_ns, 1767225600000000000)
      assert.equal(submittedSpan.duration, 1000000000)
      assert.deepEqual(submittedSpan.meta, {
        input: 'Say hello.',
        output: { message: 'hello' },
        expected_output: 'hello',
        metadata: { verdict: 'passed' },
      })
      assert.equal(submittedSpan.dataset_id, 'dataset')
      assert.deepEqual(new Set(submittedSpan.tags), new Set(['source:eve', 'eval:smoke', 'experiment_id:exp', 'dataset_id:dataset']))

      const metricsBody = JSON.parse(global.fetch.getCall(4).args[1].body)
      const metrics = metricsBody.data.attributes.metrics
      assert.equal(metrics.length, 5)
      assert.deepEqual(metrics.map(metric => metric.span_id), Array(5).fill(span.spanId))
      assert.deepEqual(metrics.map(metric => metric.tags), Array(5).fill(['source:eve', 'experiment_id:exp']))
      assert.equal(metrics[0].metric_type, 'boolean')
      assert.equal(metrics[0].boolean_value, true)
      assert.equal(metrics[1].metric_type, 'score')
      assert.equal(metrics[1].score_value, 0.92)
      assert.equal(metrics[2].metric_type, 'categorical')
      assert.equal(metrics[2].categorical_value, 'passed')
      assert.equal(metrics[3].metric_type, 'json')
      assert.deepEqual(metrics[3].json_value, { assertions: 3 })
      assert.deepEqual(metrics[4].error, { message: 'judge unavailable' })

      const closeBody = JSON.parse(global.fetch.getCall(5).args[1].body)
      assert.deepEqual(closeBody.data.attributes, { status: 'completed' })
    })

    it('supports no-op external experiments when LLM Obs is disabled', async () => {
      const warn = sinon.spy(log, 'warn')
      const experiments = createExperiments({ llmobs: { DD_LLMOBS_ENABLED: false } })

      const recorder = await experiments.startExperiment({ name: 'disabled' })
      assert.equal(recorder.url(), null)
      assert.deepEqual(await recorder.submitSpan(), { experimentId: null, spanId: null, traceId: null, url: null })
      await recorder.submitEvaluationMetrics({ spanId: 'span' }, [{ label: 'score', value: 1 }])
      await recorder.close({ status: 'completed' })

      sinon.assert.calledWith(warn, sinon.match(/LLMObs experiments unavailable/))
    })
  })
})
