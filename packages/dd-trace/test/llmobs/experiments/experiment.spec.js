'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { API_BASE_PATH, ExperimentsClient } = require('../../../src/llmobs/experiments/client')
const { Dataset, DatasetRecord } = require('../../../src/llmobs/experiments/dataset')
const { Experiment } = require('../../../src/llmobs/experiments/experiment')

function defaultAppendRecordAttributes (_record, index) {
  return { valid_from_version: 2 }
}

function versionFromRecordAttributes (attributes) {
  return attributes.valid_from_version ?? attributes.version ?? null
}

function versionFromRecordAttributesList (attributes) {
  const versions = attributes
    .map(versionFromRecordAttributes)
    .filter(version => version != null)
    .map(Number)
    .filter(Number.isFinite)
  if (versions.length === 0) return null
  return Math.max(...versions)
}

function client () {
  return new ExperimentsClient({
    apiKey: 'k',
    appKey: 'a',
    site: 'datadoghq.com',
    projectName: 'my-app',
  })
}

function clientWithMockBackend ({
  appendRecordAttributes = defaultAppendRecordAttributes,
  createDatasetError,
} = {}) {
  const c = client()
  const requests = []

  c.ensureProjectId = async () => 'proj'
  c.createDataset = async (projectId, attributes) => {
    requests.push({ method: 'createDataset', projectId, attributes })
    if (createDatasetError) throw createDatasetError
    return Dataset.fromExisting(c, attributes.name, attributes.description, 'ds', projectId, [], [], 1, 1)
  }
  c.appendDatasetRecords = async (projectId, datasetId, records) => {
    requests.push({ method: 'appendDatasetRecords', projectId, datasetId, records })
    const recordAttributes = records.map((record, index) => appendRecordAttributes(record, index))
    return {
      records: records.map((record, index) => new DatasetRecord(
        record.input,
        record.expected_output,
        record.metadata,
        record.id ?? `rec-${index}`,
        record.tags ?? []
      )),
      version: versionFromRecordAttributesList(recordAttributes),
    }
  }
  c.batchUpdateDatasetRecords = async (projectId, datasetId, attributes) => {
    requests.push({ method: 'batchUpdateDatasetRecords', projectId, datasetId, attributes })
    const records = (attributes.update_records ?? []).map(record => new DatasetRecord(
      {},
      null,
      {},
      record.id,
      []
    ))
    return { records, version: records.length === 0 ? null : 3 }
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
    const dataset = new Dataset(c, 'demo').addRecord({ q: 'apple' }, 'apple', { row: 0 }, ['segment:gold'])
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
    assert.equal(callsToLlmobs[1][1].tags.dataset_record_id, 'rec-0')
    assert.equal(callsToLlmobs[1][1].tags.segment, 'gold')
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

  it('serializes dataset record tags on append', async () => {
    const { client: c, requests } = clientWithMockBackend()
    const dataset = new Dataset(c, 'demo').addRecord('a', 'b', { row: 0 }, ['source:synthetic'])

    await dataset.push()

    const append = requests.find(request => request.method === 'appendDatasetRecords')
    assert.deepEqual(append.records[0].tags, ['source:synthetic'])
    assert.deepEqual(dataset.records()[0].tags, ['source:synthetic'])
    assert.equal(dataset.version(), 2)
  })

  it('updates tags on existing dataset records with backend tag operations', async () => {
    const { client: c, requests } = clientWithMockBackend()
    const dataset = Dataset.fromExisting(
      c,
      'demo',
      'desc',
      'ds',
      'proj',
      [new DatasetRecord('a', 'b', {}, 'rec-1', ['segment:old'])],
      ['rec-1'],
      2,
      2
    )

    dataset.addTags(0, ['segment:new', 'team:llmobs'])
    dataset.removeTags(0, ['segment:old'])
    dataset.replaceTags(0, ['segment:final'])
    await dataset.push()

    const update = requests.find(request => request.method === 'batchUpdateDatasetRecords')
    assert.deepEqual(update.attributes.update_records, [
      { id: 'rec-1', tag_operations: { set: ['segment:final'] } },
    ])
    assert.deepEqual(dataset.records()[0].tags, ['segment:final'])
    assert.equal(dataset.version(), 3)
  })

  it('propagates pulled-dataset filter tags and record tags to experiment events', async () => {
    const { client: c, requests } = clientWithMockBackend()
    const dataset = Dataset.fromExisting(
      c,
      'demo',
      'desc',
      'ds',
      'proj',
      [new DatasetRecord('a', 'b', {}, 'rec-1', ['segment:gold'])],
      ['rec-1'],
      2,
      2,
      ['split:train']
    )

    await new Experiment(c, {
      name: 'exp-demo',
      dataset,
      task: input => input,
      config: { temperature: 0 },
    }).run()

    const create = requests.find(request => request.method === 'createExperiment')
    assert.deepEqual(create.attributes.config, { temperature: 0, filtered_record_tags: ['split:train'] })
    const events = requests.find(request => request.method === 'postExperimentEvents')
    assert.ok(events.attributes.spans[0].tags.includes('segment:gold'))
  })

  it('clears the pinned dataset version when append responses omit a new version', async () => {
    const { client: c } = clientWithMockBackend({ appendRecordAttributes: () => ({}) })
    const dataset = new Dataset(c, 'demo').addRecord('a')

    await dataset.push()

    assert.equal(dataset.version(), null)
    assert.equal(dataset.latestVersion(), 1)
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

  it('exposes dataset getters and accepts a DatasetRecord instance', () => {
    const dataset = new Dataset(client(), 'my-name', 'desc')
      .addRecord(new DatasetRecord('in', 'out', { m: 1 }, 'rec', ['source:test']))
      .addRecord({ inputData: 'payload' }, 'expected', { explicit: true }, ['case:explicit'])
    assert.equal(dataset.name(), 'my-name')
    assert.equal(dataset.id(), null)
    assert.equal(dataset.url(), null)
    const record = dataset.records()[0]
    assert.equal(record.input, 'in')
    assert.equal(record.expectedOutput, 'out')
    assert.deepEqual(record.metadata, { m: 1 })
    assert.deepEqual(record.tags, ['source:test'])
    assert.equal(record.id, 'rec')
    assert.deepEqual(
      { ...record },
      { input: 'in', expectedOutput: 'out', metadata: { m: 1 }, tags: ['source:test'], id: 'rec' }
    )
    assert.deepEqual(dataset.records()[1].input, { inputData: 'payload' })
    assert.equal(dataset.records()[1].expectedOutput, 'expected')
    assert.deepEqual(dataset.records()[1].metadata, { explicit: true })
    assert.deepEqual(dataset.records()[1].tags, ['case:explicit'])
  })
})
