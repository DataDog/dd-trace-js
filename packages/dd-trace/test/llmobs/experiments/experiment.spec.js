'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { describe, it } = require('mocha')
const nock = require('nock')

const { ExperimentsClient } = require('../../../src/llmobs/experiments/client')
const { Dataset, DatasetRecord } = require('../../../src/llmobs/experiments/dataset')
const { Experiment } = require('../../../src/llmobs/experiments/experiment')

const cassetteDir = path.join(__dirname, 'cassettes')

nock.back.fixtures = cassetteDir
nock.back.setMode('lockdown')

async function withCassette (name, fn) {
  const { nockDone, context } = await nock.back(name)
  try {
    await fn()
    context.assertScopesFinished()
  } finally {
    nockDone()
    nock.cleanAll()
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
      const dataset = new Dataset(client(), 'demo', 'desc')
        .addRecord({ q: 'apple' }, 'true', { row: 0 })
        .addRecord({ q: 'car' }, 'false', { row: 1 })

      const result = await new Experiment(client(), {
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
      assert.equal(dataset.id(), 'ds')
      assert.equal(dataset.version(), 2)
      assert.deepEqual(dataset.recordIds(), ['rec-0', 'rec-1'])
      assert.equal(dataset.url(), 'https://app.datadoghq.com/llm/datasets/ds')
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

  it('validates required options', () => {
    const dataset = new Dataset(client(), 'demo')
    assert.throws(() => new Experiment(client(), { dataset, task: (input) => input }), /name/)
    assert.throws(() => new Experiment(client(), { name: 'n', task: (input) => input }), /dataset/)
    assert.throws(() => new Experiment(client(), { name: 'n', dataset }), /task/)
  })

  it('exposes dataset getters and accepts a DatasetRecord instance', () => {
    const dataset = new Dataset(client(), 'my-name', 'desc').addRecord(new DatasetRecord('in', 'out', { m: 1 }))
    assert.equal(dataset.name(), 'my-name')
    assert.equal(dataset.id(), null)
    assert.equal(dataset.url(), null)
    const record = dataset.records()[0]
    assert.equal(record.input, 'in')
    assert.equal(record.expectedOutput, 'out')
    assert.deepEqual(record.metadata, { m: 1 })
  })
})
