'use strict'

const assert = require('node:assert/strict')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { ExperimentsClient } = require('../../../src/llmobs/experiments/client')
const { Dataset } = require('../../../src/llmobs/experiments/dataset')
const { Experiment } = require('../../../src/llmobs/experiments/experiment')

// Routes the control-plane + events calls a run makes, recording each request.
function installFetch (calls, overrides = {}) {
  const route = (method, path, body) => {
    if (method === 'POST' && path === '/api/v2/llm-obs/v1/projects') return { data: { id: 'proj' } }
    if (method === 'POST' && path.endsWith('/proj/datasets/ds/records')) {
      return { records: body.data.attributes.records.map((_, i) => ({ id: `rec-${i}` })) }
    }
    if (method === 'POST' && path.endsWith('/proj/datasets')) return { data: { id: 'ds' } }
    if (method === 'POST' && path.endsWith('/experiments/exp/events')) return {}
    if (method === 'PATCH' && path.endsWith('/experiments/exp')) return {}
    if (method === 'POST' && path.endsWith('/experiments')) return { data: { id: 'exp' } }
    return {}
  }

  global.fetch = sinon.stub().callsFake(async (url, opts) => {
    const u = new URL(url)
    const body = opts.body ? JSON.parse(opts.body) : undefined
    calls.push({ method: opts.method, host: u.host, path: u.pathname, body })
    const payload = (overrides[`${opts.method} ${u.pathname}`]) ?? route(opts.method, u.pathname, body)
    return { ok: true, status: 200, text: sinon.stub().resolves(JSON.stringify(payload)) }
  })
}

// Like installFetch, but returns a non-2xx for the given `METHOD /pathname`.
function installFetchFailing (calls, failKey) {
  installFetch(calls)
  const stub = global.fetch
  global.fetch = sinon.stub().callsFake(async (url, opts) => {
    const u = new URL(url)
    if (`${opts.method} ${u.pathname}` === failKey) {
      calls.push({ method: opts.method, path: u.pathname, failed: true })
      return { ok: false, status: 500, text: sinon.stub().resolves('boom') }
    }
    return stub(url, opts)
  })
}

describe('LLMObs Experiments — dataset + experiment run', () => {
  let originalFetch
  let calls
  let client

  beforeEach(() => {
    originalFetch = global.fetch
    calls = []
    installFetch(calls)
    client = new ExperimentsClient({ apiKey: 'k', appKey: 'a', site: 'datadoghq.com', projectName: 'my-app' })
  })

  afterEach(() => {
    global.fetch = originalFetch
    sinon.restore()
  })

  const eventsBody = () => calls.find(c => c.path.endsWith('/experiments/exp/events')).body

  it('runs an experiment and returns rows, id and dashboard url', async () => {
    const dataset = new Dataset(client, 'demo', 'desc')
      .addRecord({ q: 'apple' }, 'true', { row: 0 })
      .addRecord({ q: 'car' }, 'false', { row: 1 })

    const result = await new Experiment(client, {
      name: 'exp-demo',
      dataset,
      task: (input) => ({ answer: input.q.toUpperCase() }),
      evaluators: {
        nonempty: (_i, o) => o.answer.length > 0,
        len: (_i, o) => o.answer.length,
        label: (_i, o) => (o.answer === 'APPLE' ? 'match' : 'miss'),
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
    assert.equal(dataset.url(), 'https://app.datadoghq.com/llm/datasets/ds')
  })

  it('sends records with type "datasets" and only new records on re-push', async () => {
    const dataset = new Dataset(client, 'demo').addRecord('a')
    await dataset.push()
    dataset.addRecord('b')
    await dataset.push()

    const recordPosts = calls.filter(c => c.method === 'POST' && c.path.endsWith('/proj/datasets/ds/records'))
    assert.equal(recordPosts.length, 2)
    assert.equal(recordPosts[0].body.data.type, 'datasets')
    assert.deepEqual(recordPosts[1].body.data.attributes.records.map(r => r.input), ['b'])
  })

  it('does not drop records added while a push is in flight', async () => {
    const dataset = new Dataset(client, 'demo').addRecord('a')

    let resolveRecordsFetch
    const routingFetch = global.fetch
    global.fetch = sinon.stub().callsFake((url, opts) => {
      const u = new URL(url)
      if (opts.method === 'POST' && u.pathname === '/api/v2/llm-obs/v1/proj/datasets/ds/records') {
        return new Promise((resolve) => {
          resolveRecordsFetch = () => resolve({
            ok: true,
            status: 200,
            text: sinon.stub().resolves(JSON.stringify({ records: [{ id: 'rec-0' }] })),
          })
        })
      }
      return routingFetch(url, opts)
    })

    const pushPromise = dataset.push()
    // Let push() get past dataset creation and snapshot pending records, up to the
    // in-flight records POST, before adding a second record.
    await new Promise((resolve) => setTimeout(resolve, 0))
    dataset.addRecord('b')
    resolveRecordsFetch()
    await pushPromise

    global.fetch = routingFetch
    await dataset.push()

    // Only the second push's records POST goes through the instrumented `calls` route
    // (the first push's records POST was intercepted above to control its timing).
    const recordPosts = calls.filter(c => c.method === 'POST' && c.path.endsWith('/proj/datasets/ds/records'))
    assert.equal(recordPosts.length, 1, 'expected a second push to send the record dropped by the race')
    assert.deepEqual(recordPosts[0].body.data.attributes.records.map((r) => r.input), ['b'])
    assert.deepEqual(dataset.records().map((r) => r.input), ['a', 'b'])
    assert.equal(dataset.recordIds().length, 2)
  })

  it('posts events with type "experiments", one span per row, auto tags and raw metadata', async () => {
    const dataset = new Dataset(client, 'demo').addRecord({ q: 'apple' }, 'true', { row: 0 })
    await new Experiment(client, {
      name: 'exp-demo',
      dataset,
      task: (i) => ({ answer: i.q }),
      evaluators: { ok: () => true },
      tags: { env: 'test' },
    }).run()

    const body = eventsBody()
    assert.equal(body.data.type, 'experiments')
    const span = body.data.attributes.spans[0]
    assert.match(span.span_id, /^[0-9a-f]{16}$/)
    assert.match(span.trace_id, /^[0-9a-f]{32}$/)
    // Root-span convention: the trace id's low 64 bits are the span id itself.
    assert.equal(span.trace_id.slice(16), span.span_id)
    assert.equal(span.status, 'ok')
    assert.ok(span.tags.includes('experiment_id:exp'))
    assert.ok(span.tags.includes('dataset_id:ds'))
    assert.ok(span.tags.includes('dataset_record_id:rec-0'))
    assert.ok(span.tags.includes('env:test'))
    assert.deepEqual(span.meta.metadata, { row: 0 })
  })

  it('infers metric type from the evaluator return value', async () => {
    const dataset = new Dataset(client, 'demo').addRecord('x')
    await new Experiment(client, {
      name: 'exp-demo',
      dataset,
      task: () => 'out',
      evaluators: { b: () => true, s: () => 0.5, c: () => 'label' },
    }).run()

    const metrics = eventsBody().data.attributes.metrics
    const byLabel = (l) => metrics.find(m => m.label === l)
    assert.equal(byLabel('b').metric_type, 'boolean')
    assert.equal(byLabel('b').boolean_value, true)
    assert.equal(byLabel('s').metric_type, 'score')
    assert.equal(byLabel('s').score_value, 0.5)
    assert.equal(byLabel('c').metric_type, 'categorical')
    assert.equal(byLabel('c').categorical_value, 'label')
  })

  it('captures a task error per row without aborting the run, but marks the experiment failed', async () => {
    const dataset = new Dataset(client, 'demo').addRecord('good').addRecord('bad').addRecord('good2')
    const result = await new Experiment(client, {
      name: 'exp-demo',
      dataset,
      task: (input) => { if (input === 'bad') throw new Error('boom'); return `ok:${input}` },
      evaluators: { len: (_i, o) => String(o ?? '').length },
    }).run()

    assert.equal(result.rows.length, 3)
    assert.equal(result.rows[1].isError, true)
    assert.equal(result.rows[1].errorMessage, 'boom')
    assert.equal(eventsBody().data.attributes.spans[1].status, 'error')
    const patch = calls.find(c => c.method === 'PATCH')
    assert.equal(patch.body.data.attributes.status, 'failed')
    assert.equal(patch.body.data.attributes.error, 'one or more rows failed')
  })

  it('captures an evaluator error per evaluation without aborting, and marks the experiment failed', async () => {
    const dataset = new Dataset(client, 'demo').addRecord('x')
    const result = await new Experiment(client, {
      name: 'exp-demo',
      dataset,
      task: (i) => i,
      evaluators: {
        explodes: () => { throw new Error('eval-fail') },
        fine: () => true,
      },
    }).run()

    assert.equal(result.rows[0].evaluationErrors.explodes, 'eval-fail')
    assert.equal(result.rows[0].evaluations.fine, true)
    const errored = eventsBody().data.attributes.metrics.find(m => m.label === 'explodes')
    assert.equal(errored.error.message, 'eval-fail')
    const patch = calls.find(c => c.method === 'PATCH')
    assert.equal(patch.body.data.attributes.status, 'failed')
  })

  it('marks the experiment completed when every row succeeds', async () => {
    const dataset = new Dataset(client, 'demo').addRecord('x')
    await new Experiment(client, {
      name: 'exp-demo',
      dataset,
      task: (i) => i,
      evaluators: { fine: () => true },
    }).run()

    const patch = calls.find(c => c.method === 'PATCH')
    assert.equal(patch.body.data.attributes.status, 'completed')
    assert.equal(patch.body.data.attributes.error, undefined)
  })

  it('experiment create body carries project_id, dataset_id, config and ensure_unique', async () => {
    const dataset = new Dataset(client, 'demo').addRecord('x')
    await new Experiment(client, {
      name: 'exp-demo', dataset, task: (i) => i, config: { approach: 'kw' },
    }).run()

    const create = calls.find(c =>
      c.method === 'POST' && c.path.endsWith('/experiments') && !c.path.includes('/events')
    )
    assert.equal(create.body.data.type, 'experiments')
    assert.equal(create.body.data.attributes.project_id, 'proj')
    assert.equal(create.body.data.attributes.dataset_id, 'ds')
    assert.equal(create.body.data.attributes.ensure_unique, true)
    assert.deepEqual(create.body.data.attributes.config, { approach: 'kw' })
  })

  it('validates required options', () => {
    const dataset = new Dataset(client, 'demo')
    assert.throws(() => new Experiment(client, { dataset, task: (i) => i }), /name/)
    assert.throws(() => new Experiment(client, { name: 'n', task: (i) => i }), /dataset/)
    assert.throws(() => new Experiment(client, { name: 'n', dataset }), /task/)
  })

  it('exposes dataset getters and accepts a DatasetRecord instance', () => {
    const { DatasetRecord } = require('../../../src/llmobs/experiments/dataset')
    const dataset = new Dataset(client, 'my-name', 'desc').addRecord(new DatasetRecord('in', 'out', { m: 1 }))
    assert.equal(dataset.name(), 'my-name')
    assert.equal(dataset.id(), null)
    assert.equal(dataset.url(), null)
    const record = dataset.records()[0]
    assert.equal(record.input, 'in')
    assert.equal(record.expectedOutput, 'out')
    assert.deepEqual(record.metadata, { m: 1 })
  })

  it('pads record ids when the push response is not an array', async () => {
    installFetch(calls, { 'POST /api/v2/llm-obs/v1/proj/datasets/ds/records': { data: { ok: true } } })
    const dataset = new Dataset(client, 'demo').addRecord('a').addRecord('b')
    const result = await dataset.push()
    assert.deepEqual(dataset.recordIds(), ['', ''])
    assert.deepEqual(result, { pushedCount: 0, totalCount: 2 })
  })

  it('resolves with the pushed/total record counts on a successful push', async () => {
    const dataset = new Dataset(client, 'demo').addRecord('a').addRecord('b')
    const result = await dataset.push()
    assert.deepEqual(result, { pushedCount: 2, totalCount: 2 })
  })

  it('resolves with a lower pushedCount when the backend confirms fewer records than sent', async () => {
    installFetch(calls, {
      'POST /api/v2/llm-obs/v1/proj/datasets/ds/records': { records: [{ id: 'rec-0' }] },
    })
    const dataset = new Dataset(client, 'demo').addRecord('a').addRecord('b')
    const result = await dataset.push()
    assert.deepEqual(result, { pushedCount: 1, totalCount: 2 })
    assert.deepEqual(dataset.recordIds(), ['rec-0', ''])
  })

  it('resolves with zero counts when there is nothing new to push', async () => {
    const dataset = new Dataset(client, 'demo').addRecord('a')
    await dataset.push()
    const result = await dataset.push()
    assert.deepEqual(result, { pushedCount: 0, totalCount: 0 })
  })

  it('throws a clear error when dataset creation fails', async () => {
    installFetchFailing(calls, 'POST /api/v2/llm-obs/v1/proj/datasets')
    const dataset = new Dataset(client, 'demo').addRecord('a')
    await assert.rejects(() => dataset.push(), /Failed to create dataset 'demo'/)
  })

  it('throws a clear error when pushing records fails', async () => {
    installFetchFailing(calls, 'POST /api/v2/llm-obs/v1/proj/datasets/ds/records')
    const dataset = new Dataset(client, 'demo').addRecord('a')
    await assert.rejects(() => dataset.push(), /Failed to push records to dataset 'demo'/)
  })

  it('exposes experiment getters before and after run', async () => {
    const dataset = new Dataset(client, 'demo').addRecord('x')
    const experiment = new Experiment(client, { name: 'exp-demo', dataset, task: (i) => i })
    assert.equal(experiment.name(), 'exp-demo')
    assert.equal(experiment.experimentId(), null)
    assert.equal(experiment.url(), null)
    await experiment.run()
    assert.equal(experiment.experimentId(), 'exp')
    assert.equal(experiment.url(), 'https://app.datadoghq.com/llm/experiments/exp')
  })

  it('throws when the dataset has no id after push', async () => {
    installFetch(calls, { 'POST /api/v2/llm-obs/v1/proj/datasets': { data: {} } })
    const dataset = new Dataset(client, 'demo').addRecord('x')
    await assert.rejects(
      () => new Experiment(client, { name: 'exp-demo', dataset, task: (i) => i }).run(),
      /has no id after push/
    )
  })

  it('throws a clear error when experiment creation fails', async () => {
    installFetchFailing(calls, 'POST /api/v2/llm-obs/v1/experiments')
    const dataset = new Dataset(client, 'demo').addRecord('x')
    await assert.rejects(
      () => new Experiment(client, { name: 'exp-demo', dataset, task: (i) => i }).run(),
      /Failed to create experiment 'exp-demo'/
    )
  })

  it('marks the experiment failed and rethrows if posting events fails', async () => {
    installFetchFailing(calls, 'POST /api/v2/llm-obs/v1/experiments/exp/events')
    const dataset = new Dataset(client, 'demo').addRecord('x')
    await assert.rejects(() => new Experiment(client, { name: 'exp-demo', dataset, task: (i) => i }).run())
    assert.ok(calls.some(c => c.method === 'PATCH' && c.body?.data?.attributes?.status === 'failed'))
  })

  it('classifies object-valued evaluator results as json (and empties null categorical values)', async () => {
    const dataset = new Dataset(client, 'demo').addRecord('x')
    await new Experiment(client, {
      name: 'exp-demo',
      dataset,
      task: () => 'out',
      evaluators: { obj: () => ({ x: 1 }), nul: () => null },
    }).run()
    const metrics = eventsBody().data.attributes.metrics
    const objMetric = metrics.find(m => m.label === 'obj')
    assert.equal(objMetric.metric_type, 'json')
    assert.deepEqual(objMetric.json_value, { x: 1 })
    assert.equal(metrics.find(m => m.label === 'nul').categorical_value, '')
  })

  it('keeps array-valued evaluator results categorical, lowercased like dd-trace-py', async () => {
    const dataset = new Dataset(client, 'demo').addRecord('x')
    await new Experiment(client, {
      name: 'exp-demo',
      dataset,
      task: () => 'out',
      evaluators: { arr: () => ['Pass', 'FAIL'], str: () => 'MATCH' },
    }).run()
    const metrics = eventsBody().data.attributes.metrics
    const arrMetric = metrics.find(m => m.label === 'arr')
    assert.equal(arrMetric.metric_type, 'categorical')
    assert.equal(arrMetric.categorical_value, '["pass","fail"]')
    assert.equal(metrics.find(m => m.label === 'str').categorical_value, 'match')
  })
})
