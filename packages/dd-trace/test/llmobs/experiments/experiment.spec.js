'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { API_BASE_PATH, ExperimentsClient } = require('../../../src/llmobs/experiments/client')
const { Dataset, DatasetRecord } = require('../../../src/llmobs/experiments/dataset')
const { Experiment } = require('../../../src/llmobs/experiments/experiment')

function client () {
  return new ExperimentsClient({
    apiKey: 'k',
    appKey: 'a',
    site: 'datadoghq.com',
    projectName: 'my-app',
  })
}

function clientWithMockBackend ({ createDatasetError } = {}) {
  const c = client()
  const requests = []

  c.ensureProjectId = async () => 'proj'
  c.createDataset = async (projectId, attributes) => {
    requests.push({ method: 'createDataset', projectId, attributes })
    if (createDatasetError) throw createDatasetError
    return Dataset.fromExisting(c, attributes.name, attributes.description, 'ds', projectId, [], 1, 1)
  }
  c.batchUpdateDatasetRecords = async (projectId, datasetId, attributes) => {
    requests.push({ method: 'batchUpdateDatasetRecords', projectId, datasetId, attributes })
    const records = attributes.insert_records.map((record, index) => new DatasetRecord(
      record.input,
      record.expected_output,
      record.metadata,
      record.id ?? `rec-${index}`
    ))
    return { records, version: 3 }
  }
  c.createExperiment = async (attributes) => {
    requests.push({ method: 'createExperiment', attributes })
    return { experimentId: 'exp', rows: [], url: `${c.appBase}/llm/experiments/exp` }
  }
  c.postExperimentEvents = async (experimentId, attributes) => {
    requests.push({ method: 'postExperimentEvents', experimentId, attributes })
  }
  c.updateExperiment = async (experimentId, attributes) => {
    requests.push({ method: 'updateExperiment', experimentId, attributes })
  }

  return { client: c, requests }
}

describe('LLMObs Experiments — dataset + experiment run', () => {
  it('runs task inside an LLMObs experiment span', async () => {
    const { client: c } = clientWithMockBackend()
    const dataset = new Dataset(c, 'demo').addRecord({ q: 'apple' }, 'apple', { row: 0 })
    const callsToLlmobs = []
    const llmobs = {
      enabled: true,
      trace: (options, fn) => {
        callsToLlmobs.push(['trace', options])
        return fn({ name: 'span' })
      },
      exportSpan: () => ({ spanId: '000000000000abcd', traceId: '0000000000000000000000000000abcd' }),
      annotate: (_span, options) => callsToLlmobs.push(['annotate', options]),
      flush: () => callsToLlmobs.push(['flush']),
    }

    const result = await new Experiment(c, {
      name: 'exp-demo',
      dataset,
      task: (input) => input.q,
      evaluators: { ok: () => true },
    }, llmobs).run()

    assert.equal(callsToLlmobs[0][0], 'trace')
    assert.equal(callsToLlmobs[0][1].kind, 'experiment')
    assert.equal(callsToLlmobs[0][1].name, 'task')
    assert.equal(callsToLlmobs[1][1].tags.experiment_id, 'exp')
    assert.equal(callsToLlmobs[1][1].tags.dataset_record_id, dataset.records()[0].id)
    assert.equal(result.rows[0].spanId, '000000000000abcd')
    assert.equal(result.rows[0].traceId, '0000000000000000000000000000abcd')
  })

  it('surfaces backend failures', async () => {
    const createDatasetError = new Error(`POST ${API_BASE_PATH}/proj/datasets failed: HTTP 500 boom`)
    const { client: c } = clientWithMockBackend({ createDatasetError })
    const dataset = new Dataset(c, 'demo').addRecord('a')

    await assert.rejects(
      () => dataset.push(),
      /Failed to create dataset 'demo'.*HTTP 500 boom/
    )
  })

  it('rejects dataset creation responses without an id', async () => {
    const { client: c } = clientWithMockBackend()
    c.createDataset = async () => Dataset.fromExisting(c, 'demo', '', null, 'proj', [], 1, 1)

    await assert.rejects(
      () => new Dataset(c, 'demo').addRecord('a').push(),
      /backend response is missing dataset id/
    )
  })

  it('surfaces batch update failures', async () => {
    const { client: c } = clientWithMockBackend()
    c.batchUpdateDatasetRecords = async () => {
      throw new Error(`POST ${API_BASE_PATH}/proj/datasets/ds/batch_update failed: HTTP 500 boom`)
    }

    await assert.rejects(
      () => Dataset.fromExisting(c, 'demo', '', 'ds', 'proj', [], 1, 1).addRecord('a').push(),
      /Failed to push changes to dataset 'demo'.*HTTP 500 boom/
    )
  })

  it('advances appended dataset versions from the current latest version', async () => {
    const { client: c } = clientWithMockBackend()
    const dataset = Dataset.fromExisting(c, 'demo', '', 'ds', 'proj', [], 2, 5).addRecord('a')

    await dataset.push()

    assert.equal(dataset.version(), 3)
    assert.equal(dataset.latestVersion(), 3)
  })

  it('updates records added after a push and preserves concurrent edits', async () => {
    const { client: c, requests } = clientWithMockBackend()
    const dataset = new Dataset(c, 'demo').addRecord('before')

    await dataset.push()
    dataset.update(0, { input: 'after' })
    await dataset.push()

    const updateRequest = requests.find(request => request.method === 'batchUpdateDatasetRecords' &&
      request.attributes.update_records.length > 0)
    assert.deepEqual(updateRequest.attributes.update_records, [{ id: dataset.recordIds()[0], input: 'after' }])

    let resolvePush
    let blockPush = true
    c.batchUpdateDatasetRecords = async (projectId, datasetId, attributes) => {
      requests.push({ method: 'batchUpdateDatasetRecords', projectId, datasetId, attributes })
      if (blockPush) {
        blockPush = false
        await new Promise(resolve => { resolvePush = resolve })
      }
      return { records: [], version: 4 }
    }
    const push = dataset.update(0, { metadata: { changed: true } }).push()
    await new Promise(resolve => setImmediate(resolve))
    dataset.update(0, { expectedOutput: 'during' })
    resolvePush()
    await push

    const concurrentUpdate = requests.at(-1).attributes.update_records
    assert.deepEqual(concurrentUpdate, [{ id: dataset.recordIds()[0], metadata: { changed: true } }])
    await dataset.push()
    assert.deepEqual(requests.at(-1).attributes.update_records, [
      { id: dataset.recordIds()[0], metadata: { changed: true }, expected_output: 'during' },
    ])
  })

  it('preserves edits to a new record made while its insert is in flight', async () => {
    const { client: c, requests } = clientWithMockBackend()
    let resolvePush
    let blockPush = true
    c.batchUpdateDatasetRecords = async (projectId, datasetId, attributes) => {
      requests.push({ method: 'batchUpdateDatasetRecords', projectId, datasetId, attributes })
      if (blockPush) {
        blockPush = false
        await new Promise(resolve => { resolvePush = resolve })
      }
      return { records: [], version: 2 }
    }
    const dataset = new Dataset(c, 'demo').addRecord('before', 'expected', { row: 0 })
    const push = dataset.push()
    await new Promise(resolve => setImmediate(resolve))
    dataset.update(0, { input: 'after', expectedOutput: 'new-expected', metadata: { row: 1 } })
    resolvePush()
    await push

    assert.deepEqual(requests[1].attributes.insert_records, [{
      id: dataset.recordIds()[0],
      input: 'before',
      expected_output: 'expected',
      metadata: { row: 0 },
    }])
    assert.deepEqual(requests[1].attributes.update_records, [])
    await dataset.push()
    assert.deepEqual(requests.at(-1).attributes.update_records, [{
      id: dataset.recordIds()[0],
      input: 'after',
      expected_output: 'new-expected',
      metadata: { row: 1 },
    }])
  })

  it('keeps deletes made while an insert is in flight', async () => {
    const { client: c, requests } = clientWithMockBackend()
    let resolvePush
    let blockPush = true
    c.batchUpdateDatasetRecords = async (projectId, datasetId, attributes) => {
      requests.push({ method: 'batchUpdateDatasetRecords', projectId, datasetId, attributes })
      if (blockPush) {
        blockPush = false
        await new Promise(resolve => { resolvePush = resolve })
      }
      return { records: [], version: 2 }
    }
    const dataset = new Dataset(c, 'demo').addRecord('input')
    const push = dataset.push()
    await new Promise(resolve => setImmediate(resolve))
    dataset.delete(0)
    resolvePush()
    await push

    await dataset.push()
    const insertRequest = requests.find(request => request.method === 'batchUpdateDatasetRecords')
    assert.deepEqual(requests.at(-1).attributes.delete_records, [insertRequest.attributes.insert_records[0].id])
  })

  it('handles mutation responses without a version', async () => {
    const { client: c } = clientWithMockBackend()
    c.batchUpdateDatasetRecords = async () => ({ records: [] })
    const dataset = Dataset.fromExisting(c, 'demo', '', 'ds', 'proj', [], null, 5).addRecord('input')

    await dataset.push()

    assert.equal(dataset.version(), 6)
    assert.equal(dataset.latestVersion(), 6)

    const unknownVersionDataset = Dataset.fromExisting(c, 'unknown', '', 'unknown-ds', 'proj', [], null, 'unknown')
      .addRecord('input')
    await unknownVersionDataset.push()
    assert.equal(unknownVersionDataset.version(), null)
  })

  it('rejects invalid update indexes and update fields', () => {
    const dataset = new Dataset(client(), 'demo').addRecord('input')
    assert.throws(() => dataset.update(0, null), /record update must be an object/)
    assert.throws(() => dataset.update(0, []), /record update must be an object/)
    assert.throws(() => dataset.update(0, { input: undefined }), /record update must include/)
    assert.throws(() => dataset.update(1, { input: 'input' }), /out of range/)
    assert.throws(() => dataset.delete(-1), /out of range/)
    assert.throws(() => dataset.delete(1), /out of range/)
  })

  it('batches record updates and deletes without sending omitted fields', async () => {
    const { client: c, requests } = clientWithMockBackend()
    const dataset = Dataset.fromExisting(
      c,
      'demo',
      '',
      'ds',
      'proj',
      [new DatasetRecord('before', 'expected', { row: 0 }, 'record-0')],
      1,
      1
    )
      .update(0, { metadata: { row: 1 } })
      .addRecord('new')

    dataset.delete(1)
    await dataset.push()

    const attributes = requests.find(request => request.method === 'batchUpdateDatasetRecords').attributes
    assert.deepEqual(attributes.update_records, [{ id: 'record-0', metadata: { row: 1 } }])
    assert.deepEqual(attributes.insert_records, [])
    assert.deepEqual(attributes.delete_records, [])

    dataset.delete(0)
    await dataset.push()
    const deleteRequest = requests.at(-1)
    assert.deepEqual(deleteRequest.attributes.delete_records, ['record-0'])
  })

  it('validates dataset record ids', () => {
    assert.throws(() => new DatasetRecord('input', null, {}, ''), /record id must be a non-empty string/)
    assert.throws(() => new DatasetRecord('input', null, {}, 1), /record id must be a non-empty string/)
  })

  it('serializes explicit null expected outputs and rejects empty updates', async () => {
    const { client: c, requests } = clientWithMockBackend()
    const dataset = Dataset.fromExisting(
      c,
      'demo',
      '',
      'ds',
      'proj',
      [new DatasetRecord('input', 'expected', { row: 0 }, 'record-0')],
      1,
      1
    )

    assert.throws(
      () => dataset.update(0, {}),
      /record update must include input, expectedOutput, or metadata/
    )
    assert.throws(
      () => dataset.update(0, { expectedOutput: undefined }),
      /record update must include input, expectedOutput, or metadata/
    )

    await dataset.update(0, { expectedOutput: null }).push()

    const attributes = requests.find(request => request.method === 'batchUpdateDatasetRecords').attributes
    assert.deepEqual(attributes.update_records, [{ id: 'record-0', expected_output: null }])
    assert.equal(dataset.records()[0].expectedOutput, null)
  })

  it('preserves local updates made while a push is in flight', async () => {
    const { client: c, requests } = clientWithMockBackend()
    let resolvePush
    let isFirstPush = true
    c.batchUpdateDatasetRecords = async (projectId, datasetId, attributes) => {
      requests.push({ method: 'batchUpdateDatasetRecords', projectId, datasetId, attributes })
      if (isFirstPush) {
        isFirstPush = false
        await new Promise(resolve => { resolvePush = resolve })
      }
      return { records: [], version: 2 }
    }
    const dataset = Dataset.fromExisting(
      c,
      'demo',
      '',
      'ds',
      'proj',
      [new DatasetRecord('before', null, {}, 'record-0')],
      1,
      1
    )
    const push = dataset.update(0, { input: 'during' }).push()
    await new Promise(resolve => setImmediate(resolve))
    dataset.update(0, { metadata: { changed: true } })
    resolvePush()
    await push
    await dataset.push()

    const updates = requests
      .filter(request => request.method === 'batchUpdateDatasetRecords')
      .map(request => request.attributes.update_records[0])
    assert.deepEqual(updates, [
      { id: 'record-0', input: 'during' },
      { id: 'record-0', input: 'during', metadata: { changed: true } },
    ])
  })

  it('keeps evaluator results aligned for summary evaluators when rows fail', async () => {
    const { client: c } = clientWithMockBackend()
    const dataset = new Dataset(c, 'demo')
      .addRecord('good', 'good')
      .addRecord('eval-bad', 'eval-bad')
      .addRecord('task-bad', 'task-bad')
    let summaryInputs
    let summaryOutputs
    let summaryEvaluatorResults

    const result = await new Experiment(c, {
      name: 'exp-demo',
      dataset,
      task: (input) => {
        if (input === 'task-bad') throw new Error('boom')
        return input
      },
      evaluators: {
        exactMatch: (input, output, expectedOutput) => {
          if (input === 'eval-bad') throw new Error('eval boom')
          return output === expectedOutput
        },
      },
      summaryEvaluators: {
        passRate: (inputs, outputs, _expectedOutputs, evaluatorResults) => {
          summaryInputs = inputs
          summaryOutputs = outputs
          summaryEvaluatorResults = evaluatorResults
          return evaluatorResults.exactMatch.filter(Boolean).length / evaluatorResults.exactMatch.length
        },
      },
    }).run()

    assert.deepEqual(summaryInputs, ['good', 'eval-bad', 'task-bad'])
    assert.deepEqual(summaryOutputs, ['good', 'eval-bad', null])
    assert.deepEqual(summaryEvaluatorResults.exactMatch, [true, null, null])
    assert.equal(result.summaryEvaluations.passRate.value, 1 / 3)
  })

  it('throws task and evaluator errors when throwOnErrors is true', async () => {
    const { client: taskClient } = clientWithMockBackend()
    await assert.rejects(
      () => new Experiment(taskClient, {
        name: 'exp-demo',
        dataset: new Dataset(taskClient, 'demo').addRecord('bad'),
        task: () => { throw new Error('task-fail') },
      }).run({ throwOnErrors: true }),
      /task-fail/
    )

    const { client: evaluatorClient } = clientWithMockBackend()
    await assert.rejects(
      () => new Experiment(evaluatorClient, {
        name: 'exp-demo',
        dataset: new Dataset(evaluatorClient, 'demo').addRecord('bad'),
        task: (input) => input,
        evaluators: { bad: () => { throw new Error('eval-fail') } },
      }).run({ throwOnErrors: true }),
      /eval-fail/
    )
  })

  it('normalizes fallback JSON evaluator metrics', async () => {
    const { client: c, requests } = clientWithMockBackend()
    const dataset = new Dataset(c, 'demo').addRecord('x')
    await new Experiment(c, {
      name: 'exp-demo',
      dataset,
      task: () => 'out',
      evaluators: {
        obj: () => ({ x: 1 }),
        arr: () => ['Pass', 'FAIL'],
        nul: () => null,
        nonfinite: () => Number.POSITIVE_INFINITY,
        str: () => 'MATCH',
      },
    }).run()

    const metrics = requests.find(request => request.method === 'postExperimentEvents')
      .attributes.metrics
    const byLabel = (label) => metrics.find(metric => metric.label === label)

    assert.deepEqual(byLabel('obj').json_value, { x: 1 })
    assert.deepEqual(byLabel('arr').json_value, { value: ['Pass', 'FAIL'] })
    assert.deepEqual(byLabel('nul').json_value, { value: null })
    assert.deepEqual(byLabel('nonfinite').json_value, { value: 'Infinity' })
    assert.equal(byLabel('str').metric_type, 'categorical')
    assert.equal(byLabel('str').categorical_value, 'match')
  })

  it('validates required options', () => {
    const c = client()
    const dataset = new Dataset(c, 'demo')
    assert.throws(() => new Experiment(c, { dataset, task: (input) => input }), /name/)
    assert.throws(() => new Experiment(c, { name: 'n', task: (input) => input }), /dataset/)
    assert.throws(() => new Experiment(c, { name: 'n', dataset }), /task/)
    const experiment = new Experiment(
      c,
      { name: 'n', dataset, task: (input) => input, evaluators: { 'ok_Name-1': () => true } }
    )
    assert.equal(experiment.name(), 'n')
    assert.throws(
      () => new Experiment(c, { name: 'n', dataset, task: (input) => input, evaluators: { 'bad name': () => true } }),
      /invalid/
    )
    assert.throws(
      () => new Experiment(c, { name: 'n', dataset, task: (input) => input, evaluators: { 'bad.name': () => true } }),
      /invalid/
    )
    assert.throws(
      () => new Experiment(c, { name: 'n', dataset, task: (input) => input, summaryEvaluators: [true] }),
      /summary evaluator must be a function/
    )
  })

  it('preserves records from an existing dataset and rejects duplicates or missing ids', () => {
    const c = client()
    const existing = new DatasetRecord('input', null, {}, 'record-0')
    assert.throws(
      () => Dataset.fromExisting(c, 'demo', '', 'ds', 'proj', [existing, existing], 1, 1),
      /Duplicate record id/
    )
    assert.throws(
      () => Dataset.fromExisting(c, 'demo', '', 'ds', 'proj', [{ input: 'input', id: '' }], 1, 1),
      /must have an id/
    )

    const dataset = Dataset.fromExisting(c, 'demo', '', 'ds', 'proj', [existing], 1, 1)
    assert.deepEqual(dataset.recordIds(), ['record-0'])
    assert.equal(dataset.records()[0], existing)
  })

  it('exposes dataset getters and accepts a DatasetRecord instance', () => {
    const dataset = new Dataset(client(), 'my-name', 'desc')
      .addRecord(new DatasetRecord('in', 'out', { m: 1 }, 'rec'))
      .addRecord({ inputData: 'payload' }, 'expected', { explicit: true })
    assert.equal(dataset.name(), 'my-name')
    assert.equal(dataset.description(), 'desc')
    assert.equal(dataset.id(), null)
    assert.equal(dataset.url(), null)
    const record = dataset.records()[0]
    assert.equal(record.input, 'in')
    assert.equal(record.expectedOutput, 'out')
    assert.deepEqual(record.metadata, { m: 1 })
    assert.equal(record.id, 'rec')
    assert.deepEqual({ ...record }, { input: 'in', expectedOutput: 'out', metadata: { m: 1 }, id: 'rec' })
    assert.deepEqual(dataset.records()[1].input, { inputData: 'payload' })
    assert.equal(dataset.records()[1].expectedOutput, 'expected')
    assert.deepEqual(dataset.records()[1].metadata, { explicit: true })
  })
})
