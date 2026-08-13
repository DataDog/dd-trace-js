'use strict'

const assert = require('node:assert/strict')
const { afterEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const log = require('../../../src/log')
const { createExperiments } = require('../../../src/llmobs/experiments')
const { ExperimentsClient } = require('../../../src/llmobs/experiments/client')
const NoopExperiments = require('../../../src/llmobs/experiments/noop')

const EXPERIMENTS_VCR_API_BASE = 'http://127.0.0.1:9126/vcr/datadog-experiments'

class VcrExperimentsClient extends ExperimentsClient {
  constructor (options) {
    super(options)
    this.apiBase = EXPERIMENTS_VCR_API_BASE
  }
}

const { createExperiments: createVcrExperiments } = proxyquire('../../../src/llmobs/experiments', {
  './client': { ExperimentsClient: VcrExperimentsClient },
})

const enabledConfig = (overrides = {}) => ({
  site: 'datadoghq.com',
  DD_API_KEY: 'k',
  DD_APP_KEY: 'a',
  llmobs: { DD_LLMOBS_ENABLED: true, mlApp: 'my-app' },
  ...overrides,
})

describe('LLMObs Experiments facade', () => {
  const backendDatasets = []

  afterEach(async () => {
    if (backendDatasets.length > 0) {
      const client = backendClient()
      for (const dataset of backendDatasets.splice(0).reverse()) {
        const projectId = dataset.projectId()
        const datasetId = dataset.id()
        if (projectId !== null && datasetId !== null) await client.deleteDataset(projectId, datasetId)
      }
    }
    sinon.restore()
  })

  const backendTestId = process.env.DD_LLMOBS_EXPERIMENTS_TEST_ID ?? 'vcr-facade'
  const backendProjectName = process.env.DD_LLMOBS_EXPERIMENTS_PROJECT_NAME ??
    `dd-trace-js-experiments-${backendTestId}`
  const backendExperimentDatasetName = `${backendProjectName}-experiment-dataset`
  const backendExperimentName = `${backendProjectName}-experiment`
  const backendRichExperimentDatasetName = `${backendProjectName}-rich-experiment-dataset`
  const backendRichExperimentName = `${backendProjectName}-rich-experiment`

  function backendClientOptions () {
    return {
      apiKey: process.env.DD_API_KEY ?? 'test-api-key',
      appKey: process.env.DD_APP_KEY ?? 'test-app-key',
      site: process.env.DD_SITE ?? 'datadoghq.com',
      projectName: backendProjectName,
    }
  }

  function backendClient () {
    const client = new ExperimentsClient(backendClientOptions())
    client.apiBase = EXPERIMENTS_VCR_API_BASE
    return client
  }

  function backendExperiments () {
    const options = backendClientOptions()
    return createVcrExperiments(enabledConfig({
      site: options.site,
      DD_API_KEY: options.apiKey,
      DD_APP_KEY: options.appKey,
      llmobs: {
        DD_LLMOBS_ENABLED: true,
        mlApp: options.projectName,
      },
    }))
  }

  function trackBackendDataset (dataset) {
    backendDatasets.push(dataset)
    return dataset
  }

  function datasetResource ({ name = 'remote-dataset', id = 'ds', description = 'desc', latestVersion = 3 } = {}) {
    return {
      name: () => name,
      id: () => id,
      description: () => description,
      latestVersion: () => latestVersion,
    }
  }

  function stubPullDatasetClient ({ projectId = 'proj', datasets = [], pages = [] } = {}) {
    sinon.stub(ExperimentsClient.prototype, 'ensureProjectId').resolves(projectId)
    sinon.stub(ExperimentsClient.prototype, 'listDatasets').resolves(datasets)
    const listDatasetRecords = sinon.stub(ExperimentsClient.prototype, 'listDatasetRecords')
    for (let i = 0; i < pages.length; i++) listDatasetRecords.onCall(i).resolves(pages[i])
    return { listDatasetRecords }
  }

  function stubPullDatasetClientForRetry (options) {
    sinon.restore()
    return stubPullDatasetClient(options)
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

    it('returns a working facade when service is used as the project name fallback', () => {
      const exp = createExperiments(enabledConfig({ service: 'my-service', llmobs: { DD_LLMOBS_ENABLED: true } }))
      const dataset = exp.createDataset('d')
      assert.equal(typeof dataset.push, 'function')
    })

    it('rejects duplicate custom record ids', () => {
      assert.throws(
        () => createExperiments(enabledConfig()).createDataset('d', {
          records: [{ id: 'r1', inputData: 'a' }, { id: 'r1', inputData: 'b' }],
        }),
        /Duplicate record id 'r1'/
      )
    })

    it('rejects invalid custom record ids', () => {
      assert.throws(
        () => createExperiments(enabledConfig()).createDataset('d', {
          records: [{ id: '', inputData: 'a' }],
        }),
        /record id must be a non-empty string/
      )
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

      const dataset = exp.createDataset('d', 'desc')
      assert.equal(dataset.description(), 'desc')
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
      assert.equal(ignoredDescriptionDataset.description(), 'ignored')
      assert.deepEqual(ignoredDescriptionDataset.records(), [])

      const dataset = exp.createDataset('d', {
        description: 'desc',
        records: [{
          id: 'r1',
          inputData: { question: 'q' },
          expectedOutput: { answer: 'a' },
          metadata: { source: 'test' },
        }],
      })
      dataset.addRecord('input only')
      dataset.update(0, { input: 'updated', expectedOutput: null, metadata: null })
      dataset.update(10, { input: 'ignored' })
      dataset.delete(1)
      dataset.delete(10)

      assert.equal(dataset.name(), 'd')
      assert.equal(dataset.description(), 'desc')
      assert.equal(dataset.id(), null)
      assert.equal(dataset.projectId(), null)
      assert.equal(dataset.version(), null)
      assert.equal(dataset.latestVersion(), null)
      assert.deepEqual(dataset.recordIds(), [])
      assert.equal(dataset.url(), null)
      assert.deepEqual(dataset.records(), [{
        id: 'r1',
        input: 'updated',
        expectedOutput: null,
        metadata: {},
      }])
      dataset.addRecord('after push')
      assert.equal(dataset.records().length, 2)
      assert.deepEqual(await dataset.push(), { pushedCount: 0, totalCount: 0 })

      const pulled = await exp.pullDataset('pulled')
      assert.equal(pulled.name(), 'pulled')
      assert.equal(pulled.description(), '')

      const experiment = exp.experiment()
      assert.equal(experiment.name(), '')
      assert.equal(experiment.experimentId(), null)
      assert.equal(experiment.url(), null)
      assert.deepEqual(await experiment.run(), { experimentId: null, rows: [], url: null })
      sinon.assert.callCount(warn, 4)
    })
  })

  describe('pullDataset', () => {
    it('pulls records from the backend client with pagination and an explicit version', async () => {
      const firstRecord = { id: 'r1', input: { value: 1 }, expectedOutput: 'one', metadata: { page: 1 } }
      const secondRecord = { id: 'r2', input: { value: 2 }, expectedOutput: 'two', metadata: { page: 2 } }
      const { listDatasetRecords } = stubPullDatasetClient({
        datasets: [datasetResource({ name: 'remote-dataset', id: 'ds', description: 'desc', latestVersion: 4 })],
        pages: [
          { records: [firstRecord], after: 'next-page' },
          { records: [secondRecord], after: '' },
        ],
      })

      const dataset = await createExperiments(enabledConfig()).pullDataset('remote-dataset', {
        expectedRecordCount: 2,
        maxWaitMs: 0,
        version: 2,
      })

      assert.equal(dataset.name(), 'remote-dataset')
      assert.equal(dataset.description(), 'desc')
      assert.equal(dataset.id(), 'ds')
      assert.equal(dataset.projectId(), 'proj')
      assert.equal(dataset.version(), 2)
      assert.equal(dataset.latestVersion(), 4)
      assert.deepEqual(dataset.records().map(record => ({
        id: record.id,
        input: record.input,
        expectedOutput: record.expectedOutput,
        metadata: record.metadata,
      })), [
        {
          id: 'r1',
          input: firstRecord.input,
          expectedOutput: firstRecord.expectedOutput,
          metadata: firstRecord.metadata,
        },
        {
          id: 'r2',
          input: secondRecord.input,
          expectedOutput: secondRecord.expectedOutput,
          metadata: secondRecord.metadata,
        },
      ])
      assert.deepEqual(dataset.recordIds(), ['r1', 'r2'])
      sinon.assert.calledWith(ExperimentsClient.prototype.listDatasets, 'proj', { name: 'remote-dataset' })
      assert.deepEqual(listDatasetRecords.firstCall.args, ['proj', 'ds', { cursor: '', tags: [], version: 2 }])
      assert.deepEqual(listDatasetRecords.secondCall.args, ['proj', 'ds', { cursor: 'next-page', tags: [], version: 2 }])
    })

    it('uses the latest dataset version when no version is requested', async () => {
      const { listDatasetRecords } = stubPullDatasetClient({
        datasets: [datasetResource({ name: 'remote-dataset', latestVersion: 5 })],
        pages: [{ records: [], after: '' }],
      })

      const dataset = await createExperiments(enabledConfig()).pullDataset('remote-dataset', { maxWaitMs: 0 })

      assert.equal(dataset.version(), 5)
      assert.deepEqual(listDatasetRecords.firstCall.args, ['proj', 'ds', { cursor: '', tags: [], version: 5 }])
    })

    it('surfaces list failures from the backend client', async () => {
      sinon.stub(ExperimentsClient.prototype, 'ensureProjectId').resolves('proj')
      sinon.stub(ExperimentsClient.prototype, 'listDatasets').rejects(new Error('list failed'))

      await assert.rejects(
        () => createExperiments(enabledConfig()).pullDataset('missing-dataset', { maxWaitMs: 0 }),
        /Failed to list datasets in project 'my-app': list failed/
      )
    })

    it('surfaces a not-found dataset after the wait budget is exhausted', async () => {
      stubPullDatasetClient({ datasets: [] })

      await assert.rejects(
        () => createExperiments(enabledConfig()).pullDataset('missing-dataset', { maxWaitMs: 0 }),
        /Dataset 'missing-dataset' not found in project 'my-app'/
      )
    })

    it('surfaces record fetch failures from the backend client', async () => {
      stubPullDatasetClient({ datasets: [datasetResource()] })
      ExperimentsClient.prototype.listDatasetRecords.rejects(new Error('records failed'))

      await assert.rejects(
        () => createExperiments(enabledConfig()).pullDataset('remote-dataset', { maxWaitMs: 0 }),
        /Failed to fetch records for dataset 'remote-dataset' in project 'my-app': records failed/
      )
    })

    it('surfaces malformed pulled records and pagination failures', async () => {
      stubPullDatasetClient({
        datasets: [datasetResource()],
        pages: [{ records: [{ input: 'missing-id' }], after: '' }],
      })
      await assert.rejects(
        () => createExperiments(enabledConfig()).pullDataset('remote-dataset', { maxWaitMs: 0 }),
        /backend returned a record without an id/
      )

      stubPullDatasetClientForRetry({
        datasets: [datasetResource()],
        pages: [{ records: [], after: 'next' }],
      })
      await assert.rejects(
        () => createExperiments(enabledConfig()).pullDataset('remote-dataset', { maxWaitMs: 0 }),
        /Failed to fetch records for dataset/
      )
    })

    it('surfaces an expected record count miss after the wait budget is exhausted', async () => {
      stubPullDatasetClient({
        datasets: [datasetResource()],
        pages: [{ records: [], after: '' }],
      })

      await assert.rejects(
        () => createExperiments(enabledConfig()).pullDataset('remote-dataset', {
          expectedRecordCount: 1,
          maxWaitMs: 0,
        }),
        /Dataset 'remote-dataset' has 0 record\(s\) after 0ms, expected 1/
      )
    })
  })

  describe('experiment run', () => {
    it('runs a multi-row experiment and returns rows, ids, metric values, and dashboard URLs', async function () {
      const exp = backendExperiments()
      const dataset = trackBackendDataset(exp.createDataset(backendRichExperimentDatasetName, {
        description: 'created by a dd-trace-js experiments rich VCR test',
        records: [
          {
            id: '72c42c47-1949-4b6c-8d5f-dc89d1116b53',
            inputData: { q: 'apple' },
            expectedOutput: 'APPLE',
            metadata: { row: 0 },
          },
          {
            id: '8139a365-5aa4-41c0-aa39-7b13a49f5301',
            inputData: { q: 'car' },
            expectedOutput: 'CAR',
            metadata: { row: 1 },
          },
        ],
      }))

      const result = await exp.experiment({
        name: backendRichExperimentName,
        description: 'created by a dd-trace-js experiments rich VCR test',
        dataset,
        task: (input) => ({ answer: input.q.toUpperCase() }),
        evaluators: {
          nonempty: (_input, output) => output.answer.length > 0,
          len: (_input, output) => output.answer.length,
          label: (_input, output, expected) => (output.answer === expected ? 'match' : 'miss'),
          details: (_input, output, expected) => ({ actual: output.answer, expected }),
        },
        config: { temperature: 0 },
        tags: { source: 'rich-vcr-test' },
      }).run()

      assert.match(result.experimentId, /\S+/)
      assert.match(result.url, /^https:\/\//)
      assert.equal(result.rows.length, 2)
      assert.equal(result.runs.length, 1)
      assert.equal(result.runs[0].rows, result.rows)
      assert.match(dataset.id(), /\S+/)
      assert.match(dataset.url(), /^https:\/\//)
      assert.equal(dataset.recordIds().length, 2)
      for (const row of result.rows) {
        assert.match(row.spanId, /^[a-f0-9]{16}$/)
        assert.match(row.traceId, /^[a-f0-9]{32}$/)
      }
      assert.deepEqual(result.rows.map(row => row.output), [{ answer: 'APPLE' }, { answer: 'CAR' }])
      assert.deepEqual(result.rows[0].evaluations, {
        nonempty: true,
        len: 5,
        label: 'match',
        details: { actual: 'APPLE', expected: 'APPLE' },
      })
      assert.deepEqual(result.rows[1].evaluations, {
        nonempty: true,
        len: 3,
        label: 'match',
        details: { actual: 'CAR', expected: 'CAR' },
      })
    })

    it('creates an experiment, submits row events, and marks the experiment completed', async function () {
      const exp = backendExperiments()
      const dataset = trackBackendDataset(exp.createDataset(backendExperimentDatasetName, {
        description: 'created by a dd-trace-js experiments VCR test',
        records: [{
          id: 'f1a85430-c609-49e8-bb84-3f6bcc6e32cf',
          inputData: { value: 1 },
          expectedOutput: { value: 2 },
          metadata: { source: 'backend-test' },
        }],
      }))

      const result = await exp.experiment({
        name: backendExperimentName,
        dataset,
        task: (input) => ({ value: input.value + 1 }),
        evaluators: {
          exact: (_input, output, expected) => output.value === expected.value,
        },
      }).run()

      assert.match(result.experimentId, /\S+/)
      assert.match(result.url, /^https:\/\//)
      assert.equal(result.rows.length, 1)
      assert.deepEqual(result.rows[0].evaluations, { exact: true })
    })
  })
})
