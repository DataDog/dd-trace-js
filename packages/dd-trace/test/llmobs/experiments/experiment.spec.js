'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { API_BASE_PATH, ExperimentsClient } = require('../../../src/llmobs/experiments/client')
const { Dataset, DatasetRecord } = require('../../../src/llmobs/experiments/dataset')
const { Experiment } = require('../../../src/llmobs/experiments/experiment')

function defaultAppendRecordAttributes (_record, index) {
  return { valid_from_version: 2 }
}

function client () {
  return new ExperimentsClient({
    apiKey: 'k',
    appKey: 'a',
    site: 'datadoghq.com',
    apiBase: 'https://api.datadoghq.com',
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
    return records.map((record, index) => {
      const attributes = appendRecordAttributes(record, index)
      return new DatasetRecord(
        record.input,
        record.expected_output,
        record.metadata,
        record.id ?? `rec-${index}`,
        attributes.valid_from_version ?? attributes.version ?? null
      )
    })
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

async function waitFor (condition) {
  for (let i = 0; i < 20; i++) {
    if (condition()) return
    await Promise.resolve()
  }
  assert.equal(condition(), true)
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
    assert.equal(callsToLlmobs[1][1].tags.dataset_record_id, 'rec-0')
    assert.equal(callsToLlmobs[1][1].tags.run_iteration, 1)
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

  it('runs multiple iterations and aliases top-level results to the first run', async () => {
    const { client: c, requests } = clientWithMockBackend()
    const dataset = new Dataset(c, 'demo')
      .addRecord('a', 'a')
      .addRecord('b', 'b')
    let taskCalls = 0
    let summaryCalls = 0

    const result = await new Experiment(c, {
      name: 'exp-demo',
      dataset,
      runs: 2,
      task: (input) => {
        taskCalls++
        return input
      },
      evaluators: { exactMatch: (_input, output, expectedOutput) => output === expectedOutput },
      summaryEvaluators: {
        rowCount: (inputs) => {
          summaryCalls++
          return inputs.length
        },
      },
      tags: { suite: 'multi-run' },
    }).run()

    const createExperiment = requests.find(request => request.method === 'createExperiment')
    assert.equal(createExperiment.attributes.run_count, 2)
    assert.equal(taskCalls, 4)
    assert.equal(summaryCalls, 2)
    assert.equal(result.runs.length, 2)
    assert.equal(result.rows, result.runs[0].rows)
    assert.equal(result.summaryEvaluations, result.runs[0].summaryEvaluations)
    assert.deepEqual(result.runs.map(run => run.runIteration), [1, 2])
    assert.notEqual(result.runs[0].runId, result.runs[1].runId)
    assert.deepEqual(result.runs.map(run => run.rows.map(row => row.output)), [['a', 'b'], ['a', 'b']])
    assert.deepEqual(result.runs.map(run => run.summaryEvaluations.rowCount.value), [2, 2])

    const events = requests.find(request => request.method === 'postExperimentEvents').attributes
    assert.equal(events.spans.length, 4)
    assert.equal(events.metrics.length, 6)
    assert.equal(events.spans[0].tags.includes('run_iteration:1'), true)
    assert.equal(events.spans[2].tags.includes('run_iteration:2'), true)
    assert.equal(events.metrics[0].tags.includes('run_iteration:1'), true)
    assert.equal(events.metrics[3].tags.includes('run_iteration:2'), true)
    assert.equal(events.metrics[0].tags.includes(`run_id:${result.runs[0].runId}`), true)
    assert.equal(events.metrics[3].tags.includes(`run_id:${result.runs[1].runId}`), true)
  })

  it('processes records concurrently while preserving row order', async () => {
    const { client: c } = clientWithMockBackend()
    const dataset = new Dataset(c, 'demo')
      .addRecord('a')
      .addRecord('b')
      .addRecord('c')
      .addRecord('d')
    const releases = []
    let active = 0
    let maxActive = 0

    const pendingResult = new Experiment(c, {
      name: 'exp-demo',
      dataset,
      task: async (input) => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => releases.push(resolve))
        active--
        return `out-${input}`
      },
    }).run({ concurrency: 2 })

    await waitFor(() => releases.length === 2)
    assert.equal(maxActive, 2)
    releases[0]()
    await waitFor(() => releases.length === 3)
    assert.equal(maxActive, 2)
    releases[1]()
    releases[2]()
    await waitFor(() => releases.length === 4)
    releases[3]()

    const result = await pendingResult
    assert.equal(maxActive, 2)
    assert.equal(active, 0)
    assert.deepEqual(result.rows.map(row => row.output), ['out-a', 'out-b', 'out-c', 'out-d'])
    assert.deepEqual(result.rows.map(row => row.index), [0, 1, 2, 3])
  })

  it('processes evaluators concurrently while preserving labels', async () => {
    const { client: c } = clientWithMockBackend()
    const dataset = new Dataset(c, 'demo').addRecord('a')
    const releases = []
    let active = 0
    let maxActive = 0

    function evaluator (value) {
      return async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => releases.push(resolve))
        active--
        return value
      }
    }

    const pendingResult = new Experiment(c, {
      name: 'exp-demo',
      dataset,
      task: (input) => `out-${input}`,
      evaluators: {
        first: evaluator('first'),
        second: evaluator('second'),
        third: evaluator('third'),
      },
    }).run({ concurrency: 2 })

    await waitFor(() => releases.length === 2)
    assert.equal(maxActive, 2)
    releases[0]()
    await waitFor(() => releases.length === 3)
    assert.equal(maxActive, 2)
    releases[1]()
    releases[2]()

    const result = await pendingResult
    assert.equal(maxActive, 2)
    assert.equal(active, 0)
    assert.deepEqual(result.rows[0].evaluations, {
      first: 'first',
      second: 'second',
      third: 'third',
    })
  })

  it('defaults concurrency to ten task or evaluator executions', async () => {
    const { client: c } = clientWithMockBackend()
    const dataset = new Dataset(c, 'demo').addRecord('a')
    const evaluators = {}
    const releases = []
    let active = 0
    let maxActive = 0

    for (let i = 0; i < 11; i++) {
      evaluators[`eval${i}`] = async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise(resolve => releases.push(resolve))
        active--
        return i
      }
    }

    const pendingResult = new Experiment(c, {
      name: 'exp-demo',
      dataset,
      task: (input) => `out-${input}`,
      evaluators,
    }).run()

    await waitFor(() => releases.length === 10)
    assert.equal(maxActive, 10)
    releases[0]()
    await waitFor(() => releases.length === 11)
    for (let i = 1; i < releases.length; i++) releases[i]()

    const result = await pendingResult
    assert.equal(maxActive, 10)
    assert.equal(Object.keys(result.rows[0].evaluations).length, 11)
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
    assert.throws(
      () => new Experiment(c, { name: 'n', dataset, task: (input) => input, runs: 0 }),
      /runs must be a positive integer/
    )
    assert.throws(
      () => new Experiment(c, { name: 'n', dataset, task: (input) => input, runs: 1.5 }),
      /runs must be a positive integer/
    )
  })

  it('validates run options', async () => {
    const c = client()
    const dataset = new Dataset(c, 'demo').addRecord('a')
    const experiment = new Experiment(c, { name: 'n', dataset, task: (input) => input })

    await assert.rejects(
      () => experiment.run({ concurrency: 0 }),
      /concurrency must be a positive integer/
    )
    await assert.rejects(
      () => experiment.run({ concurrency: 1.5 }),
      /concurrency must be a positive integer/
    )
  })

  it('exposes dataset getters and accepts a DatasetRecord instance', () => {
    const dataset = new Dataset(client(), 'my-name', 'desc')
      .addRecord(new DatasetRecord('in', 'out', { m: 1 }))
      .addRecord({ inputData: 'payload' }, 'expected', { explicit: true })
    assert.equal(dataset.name(), 'my-name')
    assert.equal(dataset.id(), null)
    assert.equal(dataset.url(), null)
    const record = dataset.records()[0]
    assert.equal(record.input, 'in')
    assert.equal(record.expectedOutput, 'out')
    assert.deepEqual(record.metadata, { m: 1 })
    assert.deepEqual(dataset.records()[1].input, { inputData: 'payload' })
    assert.equal(dataset.records()[1].expectedOutput, 'expected')
    assert.deepEqual(dataset.records()[1].metadata, { explicit: true })
  })
})
