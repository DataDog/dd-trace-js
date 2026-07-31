'use strict'

const assert = require('node:assert/strict')
const { afterEach, describe, it } = require('mocha')
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
  const backendDatasets = []

  afterEach(async () => {
    for (const { dataset, exp } of backendDatasets.splice(0).reverse()) {
      const projectId = dataset.projectId()
      const datasetId = dataset.id()
      if (projectId !== null && datasetId !== null) await exp._deleteDataset(projectId, datasetId)
    }
    sinon.restore()
  })

  const backendTestId = process.env.DD_LLMOBS_EXPERIMENTS_TEST_ID ?? 'vcr'
  const backendProjectName = process.env.DD_LLMOBS_EXPERIMENTS_PROJECT_NAME ??
    `dd-trace-js-experiments-${backendTestId}`
  const backendExperimentDatasetName = `${backendProjectName}-experiment-dataset`
  const backendExperimentName = `${backendProjectName}-experiment`

  function backendExperiments () {
    return createExperiments(enabledConfig({
      site: process.env.DD_SITE ?? 'datadoghq.com',
      DD_API_KEY: process.env.DD_API_KEY ?? 'test-api-key',
      DD_APP_KEY: process.env.DD_APP_KEY ?? 'test-app-key',
      llmobs: {
        DD_LLMOBS_ENABLED: true,
        experimentsApiBase: process.env.DD_LLMOBS_EXPERIMENTS_API_BASE ??
          'http://127.0.0.1:9126/vcr/datadog-experiments',
        mlApp: backendProjectName,
      },
    }))
  }

  function trackBackendDataset (exp, dataset) {
    backendDatasets.push({ exp, dataset })
    return dataset
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

  describe('experiment run', () => {
    it('creates an experiment, submits row events, and marks the experiment completed', async function () {
      this.timeout(60_000)

      const exp = backendExperiments()
      const dataset = trackBackendDataset(exp, exp.createDataset(backendExperimentDatasetName, {
        description: 'created by a dd-trace-js experiments VCR test',
        records: [{ inputData: { value: 1 }, expectedOutput: { value: 2 }, metadata: { source: 'backend-test' } }],
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
      // eslint-disable-next-line no-console
      console.log(`Datadog experiment URL: ${result.url}`)
    })
  })
})
