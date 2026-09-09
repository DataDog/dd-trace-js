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
const VCR_PROJECT_NAME = process.env.DD_LLMOBS_EXPERIMENTS_PROJECT_NAME ??
  `dd-trace-js-experiments-${process.env.DD_LLMOBS_EXPERIMENTS_TEST_ID ?? 'vcr-facade'}`

class VcrExperimentsClient extends ExperimentsClient {
  constructor (options) {
    super(options)
    this.apiBase = EXPERIMENTS_VCR_API_BASE
  }

  ensureProjectId () {
    // Keep VCR data isolated while the logical SDK project remains default-project.
    const projectName = this.projectName === 'default-project' ? VCR_PROJECT_NAME : this.projectName
    return this.getOrCreateProject(projectName)
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

  const backendProjectName = VCR_PROJECT_NAME
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
      assert.deepEqual(dataset.records()[0].tags, [])
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
      assert.equal(typeof dataset.addRecords, 'function')
      assert.equal(dataset.records()[0].input, 'in')
      const experiment = exp.experiment({ name: 'n', dataset, task: (i) => i })
      assert.equal(typeof experiment.run, 'function')
    })

    it('uses the configured project name and supports per-operation overrides', () => {
      const constructedProjects = []
      class CapturingExperimentsClient extends ExperimentsClient {
        constructor (options) {
          super(options)
          constructedProjects.push(options.projectName)
        }
      }
      const { createExperiments: createWithProjectCapture } = proxyquire('../../../src/llmobs/experiments', {
        './client': { ExperimentsClient: CapturingExperimentsClient },
      })

      const exp = createWithProjectCapture(enabledConfig({
        llmobs: { DD_LLMOBS_ENABLED: true, mlApp: 'ml-app', projectName: 'configured-project' },
      }))
      exp.createDataset('default')
      exp.createDataset('override', { projectName: 'override-project' })

      assert.deepEqual(constructedProjects, ['configured-project', 'override-project'])
    })

    it('preserves a dataset project and rejects mismatched experiment overrides', () => {
      const constructedProjects = []
      class CapturingExperimentsClient extends ExperimentsClient {
        constructor (options) {
          super(options)
          constructedProjects.push(options.projectName)
        }
      }
      const { createExperiments: createWithProjectCapture } = proxyquire('../../../src/llmobs/experiments', {
        './client': { ExperimentsClient: CapturingExperimentsClient },
      })

      const exp = createWithProjectCapture(enabledConfig({
        llmobs: { DD_LLMOBS_ENABLED: true, projectName: 'default-project' },
      }))
      const dataset = exp.createDataset('dataset', { projectName: 'dataset-project' })
      exp.experiment({ name: 'dataset-exp', dataset, task: input => input })

      assert.deepEqual(constructedProjects, ['default-project', 'dataset-project', 'dataset-project'])
      assert.throws(
        () => exp.experiment({
          name: 'mismatched-exp',
          projectName: 'other-project',
          dataset,
          task: input => input,
        }),
        /does not match dataset project 'dataset-project'/
      )
    })

    it('uses default-project when no project name is configured', () => {
      const exp = createExperiments(enabledConfig({
        service: undefined,
        llmobs: { DD_LLMOBS_ENABLED: true },
      }))
      assert.ok(!(exp instanceof NoopExperiments))

      const dataset = exp.createDataset('d')
      assert.equal(dataset.projectName(), 'default-project')
    })

    it('does not use mlApp or service as the experiment project fallback', () => {
      const withMlApp = createExperiments(enabledConfig({
        service: 'my-service',
        llmobs: { DD_LLMOBS_ENABLED: true, mlApp: 'my-app' },
      }))
      assert.equal(withMlApp.createDataset('with-ml-app').projectName(), 'default-project')

      const withService = createExperiments(enabledConfig({
        service: 'my-service',
        llmobs: { DD_LLMOBS_ENABLED: true },
      }))
      assert.equal(withService.createDataset('with-service').projectName(), 'default-project')
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
      assert.deepEqual(await experiment.run(), {
        experimentId: null,
        rows: [],
        summaryEvaluations: {},
        runs: [],
        url: null,
      })
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
      dataset.addTags(0, ['topic:math', 'topic:math'])
      dataset.removeTags(0, ['topic:math'])
      dataset.replaceTags(0, ['topic:logic'])
      dataset.addTags(10, ['ignored:tag'])
      dataset.removeTags(10, ['ignored:tag'])
      dataset.replaceTags(10, ['ignored:tag'])

      assert.equal(dataset.name(), 'd')
      assert.equal(dataset.description(), 'desc')
      assert.equal(dataset.id(), null)
      assert.equal(dataset.projectId(), null)
      assert.equal(dataset.projectName(), null)
      assert.equal(dataset.version(), null)
      assert.equal(dataset.latestVersion(), null)
      assert.deepEqual(dataset.filterTags(), [])
      assert.deepEqual(dataset.recordIds(), [])
      assert.equal(dataset.url(), null)
      assert.deepEqual(dataset.records(), [{
        id: 'r1',
        input: 'updated',
        expectedOutput: null,
        metadata: {},
        tags: ['topic:logic'],
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
      assert.deepEqual(await experiment.run(), {
        experimentId: null,
        rows: [],
        summaryEvaluations: {},
        runs: [],
        url: null,
      })
      sinon.assert.callCount(warn, 4)
    })

    it('treats omitted no-op tag lists as empty', () => {
      const dataset = new NoopExperiments().createDataset('d', {
        records: [{ inputData: 'input' }],
      })

      dataset.addTags(0)
      dataset.removeTags(0)
      dataset.replaceTags(0)
      assert.deepEqual(dataset.records()[0].tags, [])
    })

    it('adds multiple records to a no-op dataset', () => {
      const dataset = new NoopExperiments().createDataset('d')
      const returned = dataset.addRecords([
        {
          id: 'custom-record',
          inputData: 'first',
          expectedOutput: 'one',
          metadata: { row: 0 },
          tags: ['tag:first'],
        },
        { inputData: 'second' },
      ])

      assert.equal(returned, dataset)
      assert.deepEqual(dataset.records(), [
        {
          id: 'custom-record',
          input: 'first',
          expectedOutput: 'one',
          metadata: { row: 0 },
          tags: ['tag:first'],
        },
        {
          id: null,
          input: 'second',
          expectedOutput: null,
          metadata: {},
          tags: [],
        },
      ])
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
      assert.deepEqual(
        listDatasetRecords.firstCall.args,
        ['proj', 'ds', { cursor: '', tags: [], version: 2 }]
      )
      assert.deepEqual(
        listDatasetRecords.secondCall.args,
        ['proj', 'ds', { cursor: 'next-page', tags: [], version: 2 }]
      )
    })

    it('leaves the dataset version unset when no version is requested', async () => {
      const { listDatasetRecords } = stubPullDatasetClient({
        datasets: [datasetResource({ name: 'remote-dataset', latestVersion: 5 })],
        pages: [{ records: [], after: '' }],
      })

      const dataset = await createExperiments(enabledConfig()).pullDataset('remote-dataset', { maxWaitMs: 0 })

      assert.equal(dataset.version(), null)
      assert.equal(dataset.latestVersion(), 5)
      assert.deepEqual(
        listDatasetRecords.firstCall.args,
        ['proj', 'ds', { cursor: '', tags: [], version: null }]
      )
    })

    it('surfaces list failures from the backend client', async () => {
      sinon.stub(ExperimentsClient.prototype, 'ensureProjectId').resolves('proj')
      sinon.stub(ExperimentsClient.prototype, 'listDatasets').rejects(new Error('list failed'))

      await assert.rejects(
        () => createExperiments(enabledConfig()).pullDataset('missing-dataset', { maxWaitMs: 0 }),
        /Failed to list datasets in project 'default-project': list failed/
      )
    })

    it('surfaces a not-found dataset after the wait budget is exhausted', async () => {
      stubPullDatasetClient({ datasets: [] })

      await assert.rejects(
        () => createExperiments(enabledConfig()).pullDataset('missing-dataset', { maxWaitMs: 0 }),
        /Dataset 'missing-dataset' not found in project 'default-project'/
      )
    })

    it('surfaces record fetch failures from the backend client', async () => {
      stubPullDatasetClient({ datasets: [datasetResource()] })
      ExperimentsClient.prototype.listDatasetRecords.rejects(new Error('records failed'))

      await assert.rejects(
        () => createExperiments(enabledConfig()).pullDataset('remote-dataset', { maxWaitMs: 0 }),
        /Failed to fetch records for dataset 'remote-dataset' in project 'default-project': records failed/
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
    function stubDynamicExperimentEvents () {
      // Event payloads include generated span/trace ids; experiment.spec.js covers their shape.
      // Keep these facade tests focused on control-plane VCR calls and returned result plumbing.
      return sinon.stub(ExperimentsClient.prototype, 'postExperimentEvents').resolves()
    }

    it('runs a multi-row experiment and returns rows, ids, metric values, and dashboard URLs', async function () {
      this.timeout(60_000)

      const postExperimentEvents = stubDynamicExperimentEvents()
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
      sinon.assert.calledOnce(postExperimentEvents)
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
      this.timeout(60_000)

      const postExperimentEvents = stubDynamicExperimentEvents()
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
      sinon.assert.calledOnce(postExperimentEvents)
      // eslint-disable-next-line no-console
      console.log(`Datadog experiment URL: ${result.url}`)
    })
  })

  describe('externally-driven experiments', () => {
    function stubExperimentRecorderClient () {
      sinon.stub(ExperimentsClient.prototype, 'ensureProjectId').resolves('proj')
      sinon.stub(ExperimentsClient.prototype, 'createDataset').resolves({
        id: () => 'dataset',
        version: () => 1,
      })
      sinon.stub(ExperimentsClient.prototype, 'createExperiment').resolves({
        experimentId: 'exp',
        rows: [],
        url: 'https://app.datadoghq.com/llm/experiments/exp',
      })
      sinon.stub(ExperimentsClient.prototype, 'postExperimentEvents').resolves()
      sinon.stub(ExperimentsClient.prototype, 'updateExperiment').resolves()
    }

    it('honors a projectName override when no project is configured globally', async () => {
      stubExperimentRecorderClient()
      const warn = sinon.spy(log, 'warn')

      const exp = createExperiments(enabledConfig({ service: undefined, llmobs: { DD_LLMOBS_ENABLED: true } }))
      const recorder = await exp.startExperiment({
        name: 'override-run',
        projectName: 'override-project',
        dataset: { id: 'dataset' },
      })

      assert.equal(recorder.experimentId(), 'exp')
      sinon.assert.calledOnce(ExperimentsClient.prototype.createExperiment)
      sinon.assert.notCalled(warn)
    })

    it('starts an experiment, submits a generated row span, and submits metrics for that span', async () => {
      stubExperimentRecorderClient()

      const recorder = await createExperiments(enabledConfig()).startExperiment({
        name: 'eve-run',
        description: 'eve eval run',
        tags: { source: 'eve' },
        metadata: { suite: 'smoke' },
        config: { revision: 'abc123' },
      })
      assert.equal(recorder.experimentId(), 'exp')
      assert.equal(recorder.name(), 'eve-run')
      assert.equal(recorder.url(), 'https://app.datadoghq.com/llm/experiments/exp')
      assert.equal(typeof recorder.start, 'undefined')
      assert.equal(typeof recorder.run, 'undefined')

      const span = await recorder.submitSpan({
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
        { label: 'gate_succeeded', value: true },
        { label: 'similarity', value: 0.92 },
        { label: 'verdict', value: 'passed' },
        { label: 'details', value: { assertions: 3 } },
        { label: 'judge_error', error: new Error('judge unavailable') },
      ])
      await recorder.close({ status: 'completed' })

      sinon.assert.calledWith(ExperimentsClient.prototype.createDataset, 'proj', {
        name: 'eve-run dataset',
        description: "Placeholder dataset for externally-driven experiment 'eve-run'",
      })
      sinon.assert.calledWith(ExperimentsClient.prototype.createExperiment, {
        name: 'eve-run',
        project_id: 'proj',
        dataset_id: 'dataset',
        description: 'eve eval run',
        ensure_unique: true,
        run_count: 1,
        dataset_version: 1,
        config: { revision: 'abc123' },
        metadata: { suite: 'smoke', tags: ['source:eve'] },
      })

      const submittedSpan = ExperimentsClient.prototype.postExperimentEvents.firstCall.args[1].spans[0]
      assert.equal(submittedSpan.span_id, span.spanId)
      assert.equal(submittedSpan.trace_id, span.traceId)
      assert.equal(submittedSpan.project_id, 'proj')
      assert.equal(submittedSpan.name, 'smoke eval')
      assert.equal(submittedSpan.start_ns, new Date('2026-01-01T00:00:00.000Z').getTime() * 1e6)
      assert.equal(submittedSpan.duration, 1_000_000_000)
      assert.deepEqual(submittedSpan.meta, {
        input: 'Say hello.',
        output: { message: 'hello' },
        expected_output: 'hello',
        metadata: { verdict: 'passed' },
      })
      assert.equal(submittedSpan.dataset_id, 'dataset')
      const runTag = submittedSpan.tags.find(tag => tag.startsWith('run_id:'))
      assert.match(runTag, /^run_id:[a-f0-9]{16}$/)
      assert.deepEqual(new Set(submittedSpan.tags), new Set([
        'source:eve',
        'eval:smoke',
        'experiment_id:exp',
        'project_id:proj',
        'dataset_id:dataset',
        runTag,
        'run_iteration:0',
      ]))

      const metrics = ExperimentsClient.prototype.postExperimentEvents.secondCall.args[1].metrics
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
      sinon.assert.calledWith(ExperimentsClient.prototype.updateExperiment, 'exp', { status: 'completed' })
    })

    it('rejects invalid external metric labels before posting events', async () => {
      stubExperimentRecorderClient()

      const recorder = await createExperiments(enabledConfig()).startExperiment({
        name: 'metric-label-run',
        dataset: { id: 'dataset' },
      })
      const span = await recorder.submitSpan({ input: 'x' })
      ExperimentsClient.prototype.postExperimentEvents.resetHistory()

      await assert.rejects(
        () => recorder.submitEvaluationMetrics(span, [
          { label: 'score', value: 1 },
          { label: 'bad name', value: 1 },
        ]),
        /Evaluator name 'bad name' is invalid/
      )
      sinon.assert.notCalled(ExperimentsClient.prototype.postExperimentEvents)
    })

    it('rejects external metrics for a different experiment before posting events', async () => {
      stubExperimentRecorderClient()

      const recorder = await createExperiments(enabledConfig()).startExperiment({
        name: 'metric-experiment-run',
        dataset: { id: 'dataset' },
      })
      const span = await recorder.submitSpan({ input: 'x' })
      ExperimentsClient.prototype.postExperimentEvents.resetHistory()

      await assert.rejects(
        () => recorder.submitEvaluationMetrics({ ...span, experimentId: 'other-exp' }, [{ label: 'score', value: 1 }]),
        /Experiment span belongs to 'other-exp', not 'exp'/
      )
      sinon.assert.notCalled(ExperimentsClient.prototype.postExperimentEvents)
    })

    it('skips external metrics without a value or error', async () => {
      stubExperimentRecorderClient()
      const warn = sinon.spy(log, 'warn')

      const recorder = await createExperiments(enabledConfig()).startExperiment({
        name: 'metric-shape-run',
        dataset: { id: 'dataset' },
      })
      const span = await recorder.submitSpan({ input: 'x' })
      ExperimentsClient.prototype.postExperimentEvents.resetHistory()

      await recorder.submitEvaluationMetrics(span, [
        { label: 'valid_metric', value: 1 },
        { label: 'null_metric', value: null },
        { label: 'undefined_metric', value: undefined },
        { label: 'score' },
      ])
      sinon.assert.calledOnce(ExperimentsClient.prototype.postExperimentEvents)
      const metrics = ExperimentsClient.prototype.postExperimentEvents.firstCall.args[1].metrics
      assert.deepEqual(metrics.map(metric => metric.label), ['valid_metric', 'null_metric'])
      assert.equal(metrics[1].metric_type, 'json')
      assert.deepEqual(metrics[1].json_value, { value: null })

      ExperimentsClient.prototype.postExperimentEvents.resetHistory()
      await recorder.submitEvaluationMetrics(span, [{ label: 'score' }])
      sinon.assert.notCalled(ExperimentsClient.prototype.postExperimentEvents)
      sinon.assert.callCount(warn, 3)
      sinon.assert.calledWith(
        warn,
        'LLMObs experiments: skipping external metric %s because it has neither value nor error',
        'undefined_metric'
      )
      sinon.assert.calledWith(
        warn,
        'LLMObs experiments: skipping external metric %s because it has neither value nor error',
        'score'
      )
    })

    it('requires external metric trace ids before posting events', async () => {
      stubExperimentRecorderClient()

      const recorder = await createExperiments(enabledConfig()).startExperiment({
        name: 'metric-trace-run',
        dataset: { id: 'dataset' },
      })
      const span = await recorder.submitSpan({ input: 'x' })
      ExperimentsClient.prototype.postExperimentEvents.resetHistory()

      await assert.rejects(
        () => recorder.submitEvaluationMetrics({ ...span, traceId: null }, [{ label: 'score', value: 1 }]),
        /Experiment trace id is required/
      )
      await assert.rejects(
        () => recorder.submitEvaluationMetrics({ spanId: span.spanId }, [{ label: 'score', value: 1 }]),
        /Experiment trace id is required/
      )
      sinon.assert.notCalled(ExperimentsClient.prototype.postExperimentEvents)
    })

    it('omits null dataset versions when starting external experiments', async () => {
      stubExperimentRecorderClient()

      await createExperiments(enabledConfig()).startExperiment({
        name: 'null-version-run',
        dataset: { id: 'dataset', version: null },
      })

      const attributes = ExperimentsClient.prototype.createExperiment.firstCall.args[0]
      assert.equal(Object.hasOwn(attributes, 'dataset_version'), false)
    })

    it('defaults errored external closes to failed and surfaces close failures', async () => {
      stubExperimentRecorderClient()

      const recorder = await createExperiments(enabledConfig()).startExperiment({
        name: 'close-run',
        dataset: { id: 'dataset' },
      })

      await recorder.close({ error: new Error('boom') })
      sinon.assert.calledWith(ExperimentsClient.prototype.updateExperiment, 'exp', {
        status: 'failed',
        error: 'boom',
      })

      ExperimentsClient.prototype.updateExperiment.resetHistory()
      ExperimentsClient.prototype.updateExperiment.rejects(new Error('HTTP 500'))
      await assert.rejects(
        () => recorder.close({ status: 'completed' }),
        /HTTP 500/
      )
      sinon.assert.calledOnce(ExperimentsClient.prototype.updateExperiment)
    })

    it('records row error metadata and falls back for invalid timestamps', async () => {
      stubExperimentRecorderClient()

      const recorder = await createExperiments(enabledConfig()).startExperiment({
        name: 'error-run',
        dataset: { id: 'dataset', version: 7 },
      })

      await recorder.submitSpan({
        name: 'string error',
        input: 'bad input',
        error: 'row failed',
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
      })
      await recorder.submitSpan({
        name: 'object error',
        input: 'bad input',
        error: { type: 'ValueError', message: 'bad row', stack: 'stack' },
        startedAt: '2026-01-01T00:00:01.000Z',
      })

      const fallbackMs = Date.UTC(2026, 0, 1, 0, 0, 2)
      const clock = sinon.useFakeTimers({ now: fallbackMs })
      try {
        await recorder.submitSpan({
          name: 'invalid date',
          input: 'bad date',
          startedAt: new Date('invalid'),
          completedAt: new Date('invalid'),
        })
      } finally {
        clock.restore()
      }

      const stringErrorSpan = ExperimentsClient.prototype.postExperimentEvents.firstCall.args[1].spans[0]
      assert.equal(stringErrorSpan.status, 'error')
      assert.equal(stringErrorSpan.duration, 0)
      assert.deepEqual(stringErrorSpan.meta.error, { type: 'Error', message: 'row failed', stack: '' })

      const objectErrorSpan = ExperimentsClient.prototype.postExperimentEvents.secondCall.args[1].spans[0]
      assert.equal(objectErrorSpan.status, 'error')
      assert.deepEqual(objectErrorSpan.meta.error, { type: 'ValueError', message: 'bad row', stack: 'stack' })

      const invalidDateSpan = ExperimentsClient.prototype.postExperimentEvents.thirdCall.args[1].spans[0]
      assert.equal(invalidDateSpan.start_ns, fallbackMs * 1e6)
      assert.equal(invalidDateSpan.duration, 0)
      assert.doesNotMatch(invalidDateSpan.trace_id, /NaN/)
      sinon.assert.notCalled(ExperimentsClient.prototype.createDataset)
    })

    it('supports no-op external experiments when LLM Obs is disabled', async () => {
      const warn = sinon.spy(log, 'warn')
      const experiments = createExperiments({ llmobs: { DD_LLMOBS_ENABLED: false } })

      const recorder = await experiments.startExperiment({ name: 'disabled' })
      assert.equal(recorder.name(), 'disabled')
      assert.equal(recorder.experimentId(), '00000000-0000-0000-0000-000000000000')
      assert.equal(recorder.url(), null)
      assert.equal(typeof recorder.start, 'undefined')
      assert.equal(typeof recorder.run, 'undefined')
      assert.deepEqual(await recorder.submitSpan(), {
        experimentId: '00000000-0000-0000-0000-000000000000',
        spanId: '0000000000000000',
        traceId: '00000000000000000000000000000000',
        url: null,
      })
      await recorder.submitEvaluationMetrics({
        experimentId: recorder.experimentId(),
        spanId: '0000000000000000',
        traceId: '00000000000000000000000000000000',
      }, [{ label: 'score', value: 1 }])
      await recorder.close({ status: 'completed' })

      sinon.assert.calledWith(warn, sinon.match(/LLMObs experiments unavailable/))
    })
  })
})
