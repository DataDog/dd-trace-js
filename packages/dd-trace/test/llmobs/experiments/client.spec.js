'use strict'

const assert = require('node:assert/strict')
const { afterEach, describe, it } = require('mocha')

const { ExperimentsClient, apiHost, appHost } = require('../../../src/llmobs/experiments/client')

const EXPERIMENTS_VCR_API_BASE = 'http://127.0.0.1:9126/vcr/datadog-experiments'

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function waitForBackend (defaultDelayMs = 2000) {
  if (process.env.RECORD_REQUESTS === undefined || process.env.RECORD_REQUESTS === '0') return Promise.resolve()
  return sleep(Number(process.env.DD_LLMOBS_EXPERIMENTS_READ_AFTER_WRITE_DELAY_MS ?? defaultDelayMs))
}

function recordDataByInputValue (records) {
  return records
    .map(record => ({
      input: record.input,
      expectedOutput: record.expectedOutput,
      metadata: record.metadata,
    }))
    .sort((left, right) => left.input.value - right.input.value)
}

describe('LLMObs Experiments control-plane client', () => {
  const backendDatasets = []
  const backendTestId = process.env.DD_LLMOBS_EXPERIMENTS_TEST_ID ?? 'vcr'
  const backendProjectName = process.env.DD_LLMOBS_EXPERIMENTS_PROJECT_NAME ??
    `dd-trace-js-experiments-${backendTestId}`
  const backendClientDatasetName = `${backendProjectName}-client-dataset`
  const backendClientCustomRecordsDatasetName = `${backendProjectName}-client-custom-records-dataset`
  const backendClientExperimentDatasetName = `${backendProjectName}-client-experiment-dataset`
  const backendClientExperimentName = `${backendProjectName}-client-experiment`
  const backendClientTaskName = `${backendProjectName}-client-task`

  afterEach(async () => {
    for (const { client, projectId, datasetId } of backendDatasets.splice(0).reverse()) {
      await client.deleteDataset(projectId, datasetId)
    }
  })

  function backendClient () {
    const client = new ExperimentsClient({
      apiKey: process.env.DD_API_KEY ?? 'test-api-key',
      appKey: process.env.DD_APP_KEY ?? 'test-app-key',
      site: process.env.DD_SITE ?? 'datadoghq.com',
      projectName: backendProjectName,
    })
    client.apiBase = EXPERIMENTS_VCR_API_BASE
    return client
  }

  function trackBackendDataset (client, projectId, datasetId) {
    backendDatasets.push({ client, projectId, datasetId })
  }

  it('resolves the control-plane host from the site', () => {
    assert.equal(apiHost('datadoghq.com'), 'api.datadoghq.com')
    assert.equal(apiHost('us3.datadoghq.com'), 'api.us3.datadoghq.com')
    assert.equal(apiHost('datad0g.com'), 'api.datad0g.com')
  })

  it('resolves the web-app host (app.<site> for single-level, staging override, regional as-is)', () => {
    assert.equal(appHost('datadoghq.com'), 'app.datadoghq.com')
    assert.equal(appHost('datad0g.com'), 'dd.datad0g.com')
    assert.equal(appHost('us3.datadoghq.com'), 'us3.datadoghq.com')
    const client = new ExperimentsClient({ apiKey: 'k', appKey: 'a', site: 'datad0g.com' })
    assert.equal(client.appBase, 'https://dd.datad0g.com')
    assert.equal(client.site, 'datad0g.com')
  })

  it('reports configured only when api key, app key and site are present', () => {
    assert.equal(new ExperimentsClient({ apiKey: 'k', appKey: 'a', site: 's' }).configured, true)
    assert.equal(new ExperimentsClient({ apiKey: 'k', site: 's' }).configured, false)
    assert.equal(new ExperimentsClient({}).configured, false)
  })

  it('creates, appends, lists, reads, and deletes dataset resources', async function () {
    const client = backendClient()
    const projectId = await client.ensureProjectId()
    const dataset = await client.createDataset(projectId, {
      name: backendClientDatasetName,
      description: 'created by a dd-trace-js experiments client VCR test',
    })
    trackBackendDataset(client, projectId, dataset.id())

    assert.equal(dataset.name(), backendClientDatasetName)
    assert.equal(dataset.description(), 'created by a dd-trace-js experiments client VCR test')
    assert.equal(dataset.projectId(), projectId)
    assert.match(dataset.id(), /\S+/)
    assert.match(dataset.url(), /^https:\/\//)

    const appendResult = await client.appendDatasetRecords(projectId, dataset.id(), [
      { input: { value: 1 }, expected_output: { value: 2 }, metadata: { source: 'client-test' } },
      { input: { value: 2 }, expected_output: { value: 3 }, metadata: { source: 'client-test' } },
    ])
    const createdRecords = appendResult.records
    assert.equal(appendResult.version, 1)
    assert.equal(createdRecords.length, 2)
    for (const record of createdRecords) assert.match(record.id, /\S+/)
    assert.deepEqual(recordDataByInputValue(createdRecords), [
      { input: { value: 1 }, expectedOutput: { value: 2 }, metadata: { source: 'client-test' } },
      { input: { value: 2 }, expectedOutput: { value: 3 }, metadata: { source: 'client-test' } },
    ])

    await waitForBackend(5_000)
    const listed = await client.listDatasets(projectId, { name: dataset.name() })
    assert.equal(listed.some(item => item.id() === dataset.id()), true)

    const records = await client.listDatasetRecords(projectId, dataset.id(), {
      version: appendResult.version ?? dataset.version(),
    })
    assert.equal(records.after, '')
    assert.equal(records.records.length, 2)
    assert.deepEqual(recordDataByInputValue(records.records), [
      { input: { value: 1 }, expectedOutput: { value: 2 }, metadata: { source: 'client-test' } },
      { input: { value: 2 }, expectedOutput: { value: 3 }, metadata: { source: 'client-test' } },
    ])
  })

  it('submits custom record ids with append responses', async function () {
    const client = backendClient()
    const projectId = await client.ensureProjectId()
    const dataset = await client.createDataset(projectId, {
      name: backendClientCustomRecordsDatasetName,
      description: 'created by a dd-trace-js experiments custom records VCR test',
    })
    trackBackendDataset(client, projectId, dataset.id())

    const appendResult = await client.appendDatasetRecords(projectId, dataset.id(), [
      {
        id: 'custom-a',
        input: { value: 1 },
        expected_output: { value: 2 },
        metadata: { source: 'client-custom-records-test' },
      },
      {
        id: 'custom-b',
        input: { value: 2 },
        expected_output: { value: 3 },
        metadata: { source: 'client-custom-records-test' },
      },
    ])
    const customRecords = appendResult.records
    assert.equal(appendResult.version, 1)
    assert.equal(customRecords.length, 2)
    assert.deepEqual(customRecords.map(record => record.id), ['custom-a', 'custom-b'])
    assert.deepEqual(recordDataByInputValue(customRecords), [
      { input: { value: 1 }, expectedOutput: { value: 2 }, metadata: { source: 'client-custom-records-test' } },
      { input: { value: 2 }, expectedOutput: { value: 3 }, metadata: { source: 'client-custom-records-test' } },
    ])

    await waitForBackend(5_000)
    const records = await client.listDatasetRecords(projectId, dataset.id(), {
      version: appendResult.version ?? dataset.version(),
    })
    assert.equal(records.after, '')
    assert.deepEqual(records.records.map(record => record.id).sort(), ['custom-a', 'custom-b'])
    assert.deepEqual(recordDataByInputValue(records.records), [
      { input: { value: 1 }, expectedOutput: { value: 2 }, metadata: { source: 'client-custom-records-test' } },
      { input: { value: 2 }, expectedOutput: { value: 3 }, metadata: { source: 'client-custom-records-test' } },
    ])
  })

  it('creates an experiment, posts events, and marks it completed', async function () {
    const client = backendClient()
    const projectId = await client.ensureProjectId()
    const dataset = await client.createDataset(projectId, {
      name: backendClientExperimentDatasetName,
      description: 'created by a dd-trace-js experiments client VCR test',
    })
    trackBackendDataset(client, projectId, dataset.id())

    const appendResult = await client.appendDatasetRecords(projectId, dataset.id(), [
      { input: { value: 1 }, expected_output: { value: 2 }, metadata: { source: 'client-test' } },
    ])
    const createdRecords = appendResult.records
    const experiment = await client.createExperiment({
      name: backendClientExperimentName,
      project_id: projectId,
      dataset_id: dataset.id(),
      description: 'created by a dd-trace-js experiments client VCR test',
      ensure_unique: true,
      run_count: 1,
      metadata: { tags: ['source:client-test'] },
      dataset_version: appendResult.version ?? dataset.version(),
    })

    assert.match(experiment.experimentId, /\S+/)
    assert.match(experiment.url, /^https:\/\//)

    const spanId = '0000000000000001'
    const traceId = '00000000000000000000000000000001'
    const timestampMs = Date.now()
    await client.postExperimentEvents(experiment.experimentId, {
      spans: [{
        span_id: spanId,
        trace_id: traceId,
        project_id: projectId,
        dataset_id: dataset.id(),
        name: backendClientTaskName,
        start_ns: timestampMs * 1e6,
        duration: 1_000_000,
        status: 'ok',
        meta: {
          input: { value: 1 },
          output: { value: 2 },
          expected_output: { value: 2 },
          metadata: { source: 'client-test' },
        },
        tags: [
          `experiment_id:${experiment.experimentId}`,
          `dataset_id:${dataset.id()}`,
          `dataset_record_id:${createdRecords[0].id}`,
        ],
      }],
      metrics: [{
        metric_source: 'custom',
        label: 'exact',
        span_id: spanId,
        trace_id: traceId,
        timestamp_ms: timestampMs,
        tags: [`experiment_id:${experiment.experimentId}`],
        experiment_id: experiment.experimentId,
        metric_type: 'boolean',
        boolean_value: true,
      }],
    })
    await client.updateExperiment(experiment.experimentId, { status: 'completed' })
  })
})
