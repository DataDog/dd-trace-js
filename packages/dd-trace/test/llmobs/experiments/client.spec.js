'use strict'

const assert = require('node:assert/strict')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const { ExperimentsClient, apiHost } = require('../../../src/llmobs/experiments/client')

describe('LLMObs Experiments control-plane client', () => {
  let originalFetch

  beforeEach(() => {
    originalFetch = global.fetch
    global.fetch = sinon.stub()
  })

  afterEach(() => {
    global.fetch = originalFetch
    sinon.restore()
  })

  const resolveWith = (status, body) => {
    global.fetch.resolves({
      ok: status >= 200 && status < 300,
      status,
      text: sinon.stub().resolves(JSON.stringify(body)),
    })
  }

  it('resolves the control-plane host from the site', () => {
    assert.equal(apiHost('datadoghq.com'), 'api.datadoghq.com')
    assert.equal(apiHost('us3.datadoghq.com'), 'api.us3.datadoghq.com')
    assert.equal(apiHost('datad0g.com'), 'api.datad0g.com')
  })

  it('reports configured only when api key, app key and site are present', () => {
    assert.equal(new ExperimentsClient({ apiKey: 'k', appKey: 'a', site: 's' }).configured, true)
    assert.equal(new ExperimentsClient({ apiKey: 'k', site: 's' }).configured, false)
    assert.equal(new ExperimentsClient({}).configured, false)
  })

  it('get-or-create project: builds the URL, both-key headers and body, and parses the id', async () => {
    resolveWith(200, { data: { id: 'proj-123', type: 'projects', attributes: { name: 'p' } } })

    const client = new ExperimentsClient({ apiKey: 'key', appKey: 'app', site: 'datadoghq.com' })
    const id = await client.getOrCreateProject('my-project')

    assert.equal(id, 'proj-123')
    sinon.assert.calledOnce(global.fetch)

    const [url, opts] = global.fetch.firstCall.args
    assert.equal(url, 'https://api.datadoghq.com/api/v2/llm-obs/v1/projects')
    assert.equal(opts.method, 'POST')
    assert.equal(opts.headers['DD-API-KEY'], 'key')
    assert.equal(opts.headers['DD-APPLICATION-KEY'], 'app')
    assert.equal(opts.headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(opts.body), {
      data: { type: 'projects', attributes: { name: 'my-project' } },
    })
  })

  it('caches the project id (second call does not hit the network)', async () => {
    resolveWith(200, { data: { id: 'proj-123' } })

    const client = new ExperimentsClient({ apiKey: 'key', appKey: 'app', site: 'datadoghq.com' })
    const first = await client.getOrCreateProject('p')
    const second = await client.getOrCreateProject('p')

    assert.equal(first, 'proj-123')
    assert.equal(second, 'proj-123')
    sinon.assert.calledOnce(global.fetch)
  })

  it('routes regional sites to api.<region>.<site>', async () => {
    resolveWith(200, { data: { id: 'x' } })

    const client = new ExperimentsClient({ apiKey: 'k', appKey: 'a', site: 'us3.datadoghq.com' })
    await client.getOrCreateProject('p')

    assert.equal(global.fetch.firstCall.args[0], 'https://api.us3.datadoghq.com/api/v2/llm-obs/v1/projects')
  })

  it('throws a clear error on a non-2xx response', async () => {
    resolveWith(403, { errors: ['forbidden'] })

    const client = new ExperimentsClient({ apiKey: 'k', appKey: 'a', site: 'datadoghq.com' })
    await assert.rejects(
      () => client.getOrCreateProject('p'),
      /Failed to create or get project 'p'.*HTTP 403/
    )
  })

  it('throws a clear error when the request itself fails', async () => {
    global.fetch.rejects(new Error('network down'))

    const client = new ExperimentsClient({ apiKey: 'k', appKey: 'a', site: 'datadoghq.com' })
    await assert.rejects(
      () => client.getOrCreateProject('p'),
      /Failed to create or get project 'p'.*network down/
    )
  })
})
