'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { describe, it } = require('mocha')
const nock = require('nock')

const { API_BASE_PATH, ExperimentsClient } = require('../../../src/llmobs/experiments/client')
const { Dataset, DatasetRecord } = require('../../../src/llmobs/experiments/dataset')
const { Experiment } = require('../../../src/llmobs/experiments/experiment')

const cassetteDir = path.join(__dirname, 'cassettes')

nock.back.fixtures = cassetteDir

async function withCassette (name, fn) {
  nock.back.setMode('lockdown')
  const { nockDone, context } = await nock.back(name)
  try {
    await fn()
    context.assertScopesFinished()
  } finally {
    nockDone()
    nock.cleanAll()
    nock.enableNetConnect()
    nock.back.setMode('wild')
  }
}

function defaultAppendRecordAttributes (_record, index) {
  return { id: `rec-${index}`, valid_from_version: 2 }
}

function stubClient ({ appendRecordAttributes = defaultAppendRecordAttributes } = {}) {
  const requests = []
  return {
    appBase: 'https://app.datadoghq.com',
    requests,
    ensureProjectId: async () => 'proj',
    request: async (method, requestPath, body) => {
      requests.push({ method, path: requestPath, body })
      if (method === 'POST' && requestPath === `${API_BASE_PATH}/proj/datasets`) {
        return { data: { id: 'ds', attributes: { current_version: 1 } } }
      }
      if (method === 'POST' && requestPath === `${API_BASE_PATH}/proj/datasets/ds/records`) {
        return {
          data: body.data.attributes.records.map((record, index) => ({
            id: record.id ?? `rec-${index}`,
            attributes: appendRecordAttributes(record, index),
          })),
        }
      }
      if (method === 'POST' && requestPath === `${API_BASE_PATH}/experiments`) {
        return { data: { id: 'exp' } }
      }
      if (method === 'POST' && requestPath === `${API_BASE_PATH}/experiments/exp/events`) return {}
      if (method === 'PATCH' && requestPath === `${API_BASE_PATH}/experiments/exp`) return {}
      throw new Error(`Unexpected request ${method} ${requestPath}`)
    },
  }
}

describe('LLMObs Experiments — dataset + experiment run', () => {
  const client = () => new ExperimentsClient({
    apiKey: 'k',
    appKey: 'a',
    site: 'datadoghq.com',
    projectName: 'my-app',
  })

  it('runs an experiment with recorded control-plane responses', async () => {
    await withCassette('experiment-run-success.json', async () => {
      const c = client()
      const dataset = new Dataset(c, 'demo', 'desc')
        .addRecord({ q: 'apple' }, 'true', { row: 0 })
        .addRecord({ q: 'car' }, 'false', { row: 1 })

      const result = await new Experiment(c, {
        name: 'exp-demo',
        description: 'desc exp',
        dataset,
        task: (input) => ({ answer: input.q.toUpperCase() }),
        evaluators: {
          nonempty: (_input, output) => output.answer.length > 0,
          len: (_input, output) => output.answer.length,
          label: (_input, output) => (output.answer === 'APPLE' ? 'match' : 'miss'),
        },
        config: { temperature: 0 },
        tags: { env: 'test' },
      }).run()

      assert.equal(result.experimentId, 'exp')
      assert.equal(result.url, 'https://app.datadoghq.com/llm/experiments/exp')
      assert.equal(result.rows.length, 2)
      assert.deepEqual(result.rows[0].output, { answer: 'APPLE' })
      assert.equal(result.rows[0].evaluations.nonempty, true)
      assert.equal(result.rows[0].evaluations.len, 5)
      assert.equal(result.rows[0].evaluations.label, 'match')
      assert.equal(result.runs.length, 1)
      assert.equal(dataset.id(), 'ds')
      assert.equal(dataset.version(), 2)
      assert.deepEqual(dataset.recordIds(), ['rec-0', 'rec-1'])
      assert.equal(dataset.url(), 'https://app.datadoghq.com/llm/datasets/ds')
    })
  })

  it('runs task inside an LLMObs experiment span with recorded control-plane responses', async () => {
    await withCassette('experiment-run-llmobs-span.json', async () => {
      const c = client()
      const dataset = new Dataset(c, 'demo').addRecord({ q: 'apple' }, 'apple', { row: 0 })
      const callsToLlmobs = []
      const llmobs = {
        enabled: true,
        annotationContext: (options, fn) => {
          callsToLlmobs.push(['annotationContext', options])
          return fn()
        },
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

      assert.equal(callsToLlmobs[0][0], 'annotationContext')
      assert.equal(callsToLlmobs[1][1].kind, 'experiment')
      assert.equal(callsToLlmobs[1][1].name, 'task')
      assert.equal(callsToLlmobs[2][1].tags.experiment_id, 'exp')
      assert.equal(result.rows[0].spanId, '000000000000abcd')
      assert.equal(result.rows[0].traceId, '0000000000000000000000000000abcd')
    })
  })

  it('submits custom record ids with recorded append responses', async () => {
    await withCassette('dataset-push-custom-record-ids.json', async () => {
      const dataset = new Dataset(client(), 'demo')
        .addRecord(new DatasetRecord('a', null, {}, 'custom-a'))
        .addRecord(new DatasetRecord('b', null, {}, 'custom-b'))

      const result = await dataset.push()

      assert.deepEqual(result, { pushedCount: 2, totalCount: 2 })
      assert.deepEqual(dataset.recordIds(), ['custom-a', 'custom-b'])
      assert.deepEqual(dataset.records().map(record => record.id), ['custom-a', 'custom-b'])
      assert.equal(dataset.version(), 2)
      assert.equal(dataset.latestVersion(), 2)
    })
  })

  it('surfaces recorded backend failures', async () => {
    await withCassette('dataset-create-failure.json', async () => {
      const dataset = new Dataset(client(), 'demo').addRecord('a')

      await assert.rejects(
        () => dataset.push(),
        /Failed to create dataset 'demo'.*HTTP 500 boom/
      )
    })
  })

  it('clears the pinned dataset version when append responses omit a new version', async () => {
    const c = stubClient({ appendRecordAttributes: () => ({}) })
    const dataset = new Dataset(c, 'demo').addRecord('a')

    await dataset.push()

    assert.equal(dataset.version(), null)
    assert.equal(dataset.latestVersion(), 1)
  })

  it('keeps evaluator results aligned for summary evaluators when rows fail', async () => {
    const c = stubClient()
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
