'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { afterEach, beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const telemetry = require('../../../src/llmobs/telemetry')
const { cacheKey } = require('../../../src/llmobs/prompts/cache')
const PromptManager = require('../../../src/llmobs/prompts/manager')
const ManagedPrompt = require('../../../src/llmobs/prompts/prompt')

function response (status, body) {
  const text = typeof body === 'string' ? body : (body === undefined ? '' : JSON.stringify(body))
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  }
}

function promptResponse (overrides = {}) {
  return {
    prompt_id: 'greeting',
    prompt_uuid: 'prompt-uuid',
    prompt_version_uuid: 'version-uuid',
    version: 1,
    template: 'Hello {name}',
    ...overrides,
  }
}

function makeConfig (overrides = {}) {
  return {
    DD_API_KEY: 'api-key',
    DD_APP_KEY: 'app-key',
    DD_LLMOBS_PROMPTS_CACHE_DIR: undefined,
    DD_LLMOBS_PROMPTS_CACHE_TTL_SECONDS: 60,
    DD_LLMOBS_PROMPTS_FILE_CACHE_ENABLED: false,
    DD_LLMOBS_PROMPTS_TIMEOUT: 5,
    env: undefined,
    site: 'datadoghq.com',
    ...overrides,
  }
}

describe('PromptManager', () => {
  let fetchStub
  let provider
  let cacheDir

  beforeEach(() => {
    fetchStub = sinon.stub(global, 'fetch')
    provider = { resolveObjectEvaluation: sinon.stub().resolves({ value: {} }) }
  })

  afterEach(() => {
    sinon.restore()
    delete process.env._DD_LLMOBS_OVERRIDE_ORIGIN
    if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true })
  })

  it('normalizes decimal durations to integer milliseconds', () => {
    const manager = new PromptManager(makeConfig({
      DD_LLMOBS_PROMPTS_CACHE_TTL_SECONDS: 12.3456,
      DD_LLMOBS_PROMPTS_TIMEOUT: 2.3456,
    }), () => provider)

    assert.strictEqual(manager.ttlMs, 12_346)
    assert.strictEqual(manager.timeoutMs, 2_346)
  })

  it('routes latest and encoded exact versions while preserving an override path prefix', async () => {
    process.env._DD_LLMOBS_OVERRIDE_ORIGIN = 'https://proxy.example.test/dd-proxy/'
    fetchStub.onFirstCall().resolves(response(200, promptResponse()))
    fetchStub.onSecondCall().resolves(response(200, promptResponse({
      prompt_id: 'a/b',
      version: 3,
      user_version: '0.3.0',
      prompt_version_uuid: undefined,
      ID: 'backend-version-id',
    })))
    const manager = new PromptManager(makeConfig({ DD_LLMOBS_PROMPTS_CACHE_TTL_SECONDS: 0 }), () => provider)

    const latest = await manager.getPrompt('greeting')
    const exact = await manager.getPrompt('a/b', {
      version: 3,
      targetingKey: 'ignored',
      attributes: { ignored: true },
    })

    assert.strictEqual(fetchStub.firstCall.args[0],
      'https://proxy.example.test/dd-proxy/api/unstable/llm-obs/v1/prompts/greeting')
    assert.strictEqual(fetchStub.secondCall.args[0],
      'https://proxy.example.test/dd-proxy/api/unstable/llm-obs/v1/prompts/a%2Fb/versions/3')
    assert.strictEqual(latest.source, 'registry')
    assert.strictEqual(exact.version, '0.3.0')
    assert.strictEqual(exact.promptVersionUuid, 'backend-version-id')
    sinon.assert.notCalled(provider.resolveObjectEvaluation)
  })

  it('uses the injected provider lazily with targeting-key precedence', async () => {
    provider.resolveObjectEvaluation.resolves({ value: promptResponse({ user_version: 'ff-v1', template: undefined }) })
    const manager = new PromptManager(makeConfig({ env: 'production' }), () => provider)
    const fallback = sinon.spy()

    const prompt = await manager.getPrompt('greeting', {
      targetingKey: 'explicit',
      attributes: { targetingKey: 'attribute', tier: 'premium' },
      fallback,
    })

    assert.strictEqual(prompt.source, 'ff')
    assert.deepStrictEqual(prompt.template, [])
    sinon.assert.calledOnceWithExactly(
      provider.resolveObjectEvaluation,
      '__llmobs__.prompt.greeting',
      {},
      { targetingKey: 'explicit', tier: 'premium' },
      sinon.match.object
    )
    sinon.assert.notCalled(fetchStub)
    sinon.assert.notCalled(fallback)
  })

  it('snapshots targeting attributes before provider evaluation', async () => {
    let resolveProvider
    provider.resolveObjectEvaluation.returns(new Promise(resolve => { resolveProvider = resolve }))
    fetchStub.resolves(response(200, promptResponse()))
    const manager = new PromptManager(makeConfig({ env: 'production' }), () => provider)
    const attributes = { tier: 'old' }

    const pending = manager.getPrompt('greeting', { attributes })
    attributes.tier = 'new'
    resolveProvider({ value: {} })
    await pending

    assert.deepStrictEqual(JSON.parse(fetchStub.firstCall.args[1].body), {
      data: {
        type: 'prompt_resolve_requests',
        attributes: { env: 'production', context: { tier: 'old' } },
      },
    })
  })

  for (const [name, outcome] of [
    ['not ready', { value: {}, reason: 'NOT_READY' }],
    ['missing', { value: {} }],
    ['disabled/no-op', { value: {}, reason: 'DISABLED' }],
    ['malformed', { value: { prompt_id: 'greeting' } }],
    ['thrown evaluation', new Error('provider failed')],
  ]) {
    it(`falls through from ${name} provider outcomes to /resolve`, async () => {
      if (outcome instanceof Error) provider.resolveObjectEvaluation.rejects(outcome)
      else provider.resolveObjectEvaluation.resolves(outcome)
      fetchStub.resolves(response(200, promptResponse()))
      const manager = new PromptManager(makeConfig({ env: 'production', DD_LLMOBS_PROMPTS_CACHE_TTL_SECONDS: 0 }),
        () => provider)

      const prompt = await manager.getPrompt('greeting')

      assert.strictEqual(prompt.source, 'resolve')
      assert.match(fetchStub.firstCall.args[0], /\/greeting\/resolve$/)
      assert.strictEqual(fetchStub.firstCall.args[1].method, 'POST')
    })
  }

  it('sends the JSON:API resolve body and omits absent targeting fields', async () => {
    fetchStub.onFirstCall().resolves(response(200, promptResponse()))
    fetchStub.onSecondCall().resolves(response(200, promptResponse()))
    const manager = new PromptManager(makeConfig({ env: 'production', DD_LLMOBS_PROMPTS_CACHE_TTL_SECONDS: 0 }),
      () => provider)

    await manager.getPrompt('greeting', { targetingKey: 'user-1', attributes: { tier: 'gold' } })
    await manager.getPrompt('greeting')

    assert.deepStrictEqual(JSON.parse(fetchStub.firstCall.args[1].body), {
      data: {
        type: 'prompt_resolve_requests',
        attributes: { env: 'production', targeting_key: 'user-1', context: { tier: 'gold' } },
      },
    })
    assert.deepStrictEqual(JSON.parse(fetchStub.secondCall.args[1].body), {
      data: { type: 'prompt_resolve_requests', attributes: { env: 'production' } },
    })
    assert.strictEqual(fetchStub.firstCall.args[1].headers['DD-APPLICATION-KEY'], 'app-key')
  })

  it('skips an unauthorized resolve request and uses the caller fallback', async () => {
    const manager = new PromptManager(makeConfig({ env: 'production', DD_APP_KEY: undefined }), () => provider)
    const fallback = sinon.stub().returns({ template: 'Local {name}', version: 'local' })

    const prompt = await manager.getPrompt('greeting', { fallback })

    assert.strictEqual(prompt.source, 'fallback')
    assert.strictEqual(prompt.version, 'local')
    sinon.assert.calledOnce(fallback)
    sinon.assert.notCalled(fetchStub)
  })

  it('rejects with the fetch reason when no fallback is provided', async () => {
    fetchStub.resolves(response(404, { detail: 'missing' }))
    const manager = new PromptManager(makeConfig({ DD_LLMOBS_PROMPTS_CACHE_TTL_SECONDS: 0 }), () => provider)

    await assert.rejects(manager.getPrompt('greeting'), {
      message: "Prompt 'greeting' could not be fetched and no fallback was provided: missing",
    })
  })

  it('isolates resolve selectors and canonicalizes attribute order', async () => {
    fetchStub.resolves(response(200, promptResponse()))
    const manager = new PromptManager(makeConfig({ env: 'production' }), () => provider)

    await manager.getPrompt('greeting', { targetingKey: 'u1', attributes: { tier: 'gold', beta: true } })
    await manager.getPrompt('greeting', { targetingKey: 'u1', attributes: { beta: true, tier: 'gold' } })
    await manager.getPrompt('greeting', { targetingKey: 'u1', attributes: { tier: 'free', beta: true } })

    sinon.assert.calledTwice(fetchStub)
  })

  it('disables hot and warm caching when TTL is zero', async () => {
    fetchStub.resolves(response(200, promptResponse()))
    const manager = new PromptManager(makeConfig({ DD_LLMOBS_PROMPTS_CACHE_TTL_SECONDS: 0 }), () => provider)

    await manager.getPrompt('greeting')
    await manager.getPrompt('greeting')

    sinon.assert.calledTwice(fetchStub)
  })

  it('refreshes the environment selector and preserves cache on non-404 failures', async () => {
    fetchStub.onFirstCall().resolves(response(200, promptResponse({ version: 1 })))
    fetchStub.onSecondCall().resolves(response(200, promptResponse({ version: 2 })))
    fetchStub.onThirdCall().resolves(response(500, { detail: 'temporary' }))
    const manager = new PromptManager(makeConfig({ env: 'production' }), () => provider)

    await manager.getPrompt('greeting')
    const refreshed = await manager.refreshPrompt('greeting')
    const failed = await manager.refreshPrompt('greeting')
    const cached = await manager.getPrompt('greeting')

    assert.strictEqual(refreshed.version, '2')
    assert.strictEqual(failed, undefined)
    assert.strictEqual(cached.version, '2')
    assert.strictEqual(cached.source, 'cache')
    assert.deepStrictEqual(JSON.parse(fetchStub.secondCall.args[1].body), {
      data: { type: 'prompt_resolve_requests', attributes: { env: 'production' } },
    })
  })

  it('preserves stale cache after a failed background refresh and evicts it on 404', async () => {
    const now = sinon.stub(performance, 'now').returns(100)
    fetchStub.onFirstCall().resolves(response(200, promptResponse({ version: 1 })))
    fetchStub.onSecondCall().resolves(response(500, { detail: 'temporary' }))
    fetchStub.onThirdCall().resolves(response(404, { detail: 'gone' }))
    fetchStub.onCall(3).resolves(response(404, { detail: 'gone' }))
    const manager = new PromptManager(makeConfig(), () => provider)

    await manager.getPrompt('greeting')
    const set = sinon.spy(manager.hotCache, 'set')
    now.returns(60_101)
    assert.strictEqual((await manager.getPrompt('greeting')).version, '1')
    await new Promise(setImmediate)

    assert.strictEqual((await manager.getPrompt('greeting')).version, '1')
    await new Promise(setImmediate)
    const fallback = await manager.getPrompt('greeting', { fallback: 'local' })

    assert.strictEqual(fallback.source, 'fallback')
    sinon.assert.callCount(fetchStub, 4)
    sinon.assert.notCalled(set)
  })

  it('evicts only the refreshed selector on 404', async () => {
    fetchStub.onFirstCall().resolves(response(200, promptResponse()))
    fetchStub.onSecondCall().resolves(response(404, { detail: 'gone' }))
    fetchStub.onThirdCall().resolves(response(404, { detail: 'gone' }))
    const manager = new PromptManager(makeConfig(), () => provider)

    await manager.getPrompt('greeting')
    assert.strictEqual(await manager.refreshPrompt('greeting'), undefined)
    const fallback = await manager.getPrompt('greeting', { fallback: 'local' })

    assert.strictEqual(fallback.source, 'fallback')
    sinon.assert.calledThrice(fetchStub)
  })

  it('does not restore a stale background fetch after a prompt mutation', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-prompt-manager-'))
    const now = sinon.stub(performance, 'now').returns(100)
    let resolveRefresh
    fetchStub.onFirstCall().resolves(response(200, promptResponse({ version: 1 })))
    fetchStub.onSecondCall().returns(new Promise(resolve => { resolveRefresh = resolve }))
    fetchStub.onThirdCall().resolves(response(200, {}))
    const manager = new PromptManager(makeConfig({
      DD_LLMOBS_PROMPTS_CACHE_DIR: cacheDir,
      DD_LLMOBS_PROMPTS_FILE_CACHE_ENABLED: true,
    }), () => provider)
    const key = cacheKey('greeting', ['latest'])

    await manager.getPrompt('greeting')
    now.returns(60_101)
    assert.strictEqual((await manager.getPrompt('greeting')).version, '1')
    await manager.updatePrompt('greeting', { title: 'Updated' })
    resolveRefresh(response(200, promptResponse({ version: 1 })))
    await new Promise(setImmediate)

    assert.strictEqual(manager.hotCache.get(key), undefined)
    assert.strictEqual(manager.warmCache.get(key), undefined)
  })

  it('aborts an obsolete background refresh when a manual refresh replaces it', async () => {
    const now = sinon.stub(performance, 'now').returns(100)
    let backgroundSignal
    fetchStub.onFirstCall().resolves(response(200, promptResponse({ version: 1 })))
    fetchStub.onSecondCall().callsFake((...args) => {
      const { signal } = args[1]
      backgroundSignal = signal
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    })
    fetchStub.onThirdCall().resolves(response(200, promptResponse({ version: 2 })))
    const manager = new PromptManager(makeConfig(), () => provider)

    await manager.getPrompt('greeting')
    now.returns(60_101)
    assert.strictEqual((await manager.getPrompt('greeting')).version, '1')
    assert.strictEqual((await manager.refreshPrompt('greeting')).version, '2')
    assert.strictEqual(backgroundSignal.aborted, true)
    await new Promise(setImmediate)

    assert.strictEqual((await manager.getPrompt('greeting')).version, '2')
    sinon.assert.calledThrice(fetchStub)
  })

  it('keeps the newest same-selector fetch in the cache', async () => {
    let resolveOlder
    fetchStub.onFirstCall().returns(new Promise(resolve => { resolveOlder = resolve }))
    fetchStub.onSecondCall().resolves(response(200, promptResponse({ version: 2 })))
    const manager = new PromptManager(makeConfig(), () => provider)

    const older = manager.getPrompt('greeting')
    assert.strictEqual((await manager.refreshPrompt('greeting')).version, '2')
    resolveOlder(response(200, promptResponse({ version: 1 })))
    assert.strictEqual((await older).version, '1')

    const cached = await manager.getPrompt('greeting')
    assert.strictEqual(cached.version, '2')
    assert.strictEqual(cached.source, 'cache')
    sinon.assert.calledTwice(fetchStub)
  })

  it('persists static results but never environment resolve results', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-prompt-manager-'))
    fetchStub.resolves(response(200, promptResponse()))
    const config = makeConfig({
      env: 'production',
      DD_LLMOBS_PROMPTS_CACHE_DIR: cacheDir,
      DD_LLMOBS_PROMPTS_FILE_CACHE_ENABLED: true,
    })
    const resolvingManager = new PromptManager(config, () => provider)

    await resolvingManager.getPrompt('greeting')
    assert.deepStrictEqual(fs.readdirSync(resolvingManager.warmCache.cacheDir), [])

    const registryManager = new PromptManager({ ...config, env: undefined }, () => provider)
    await registryManager.getPrompt('greeting')
    assert.notDeepStrictEqual(fs.readdirSync(registryManager.warmCache.cacheDir), [])
  })

  it('clears hot and warm caches independently and together by default', () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-prompt-manager-'))
    const manager = new PromptManager(makeConfig({
      DD_LLMOBS_PROMPTS_CACHE_DIR: cacheDir,
      DD_LLMOBS_PROMPTS_FILE_CACHE_ENABLED: true,
    }), () => provider)
    const key = cacheKey('greeting', ['latest'])
    const cached = new ManagedPrompt({ id: 'greeting', version: '1', source: 'cache', template: 'x' })

    manager.hotCache.set(key, cached)
    manager.warmCache.set(key, cached)
    manager.clearCache({ hot: false })
    assert.strictEqual(manager.hotCache.get(key).prompt.id, 'greeting')
    assert.strictEqual(manager.warmCache.get(key), undefined)

    manager.warmCache.set(key, cached)
    manager.clearCache({ warm: false })
    assert.strictEqual(manager.hotCache.get(key), undefined)
    assert.strictEqual(manager.warmCache.get(key).prompt.id, 'greeting')

    manager.hotCache.set(key, cached)
    manager.clearCache()
    assert.strictEqual(manager.hotCache.get(key), undefined)
    assert.strictEqual(manager.warmCache.get(key), undefined)
  })

  it('implements every CRUD route, body, and credential boundary', async () => {
    fetchStub.resolves(response(200, {}))
    const manager = new PromptManager(makeConfig(), () => provider)
    const template = [{ role: 'user', content: 'Hi' }]

    await manager.createPrompt('a/b', template, { title: '', description: '', userVersion: '', envIds: [] })
    await manager.createPromptVersion('a/b', template, { description: 'v', userVersion: '1', envIds: [] })
    await manager.updatePrompt('a/b', { title: '', description: '' })
    await manager.updatePromptVersion('a/b', 2, { description: '', envIds: [] })
    await manager.deletePrompt('a/b')
    await manager.listPrompts()
    await manager.listPromptVersions('a/b')

    const calls = fetchStub.getCalls().map(call => ({ url: call.args[0], options: call.args[1] }))
    assert.deepStrictEqual(
      calls.map(call => call.options.method),
      ['POST', 'POST', 'PATCH', 'PATCH', 'DELETE', 'GET', 'GET']
    )
    assert.deepStrictEqual(calls.map(call => new URL(call.url).pathname), [
      '/api/unstable/llm-obs/v1/prompts',
      '/api/unstable/llm-obs/v1/prompts/a%2Fb/versions',
      '/api/unstable/llm-obs/v1/prompts/a%2Fb',
      '/api/unstable/llm-obs/v1/prompts/a%2Fb/versions/2',
      '/api/unstable/llm-obs/v1/prompts/a%2Fb',
      '/api/unstable/llm-obs/v1/prompts',
      '/api/unstable/llm-obs/v1/prompts/a%2Fb/versions',
    ])
    assert.deepStrictEqual(JSON.parse(calls[0].options.body), { prompt_id: 'a/b', template, env_ids: [] })
    assert.deepStrictEqual(JSON.parse(calls[1].options.body), {
      template, description: 'v', user_version: '1', env_ids: [],
    })
    assert.deepStrictEqual(JSON.parse(calls[2].options.body), { title: '', description: '' })
    assert.deepStrictEqual(JSON.parse(calls[3].options.body), { description: '', env_ids: [] })
    for (const call of calls.slice(0, 5)) assert.strictEqual(call.options.headers['DD-APPLICATION-KEY'], 'app-key')
    for (const call of calls.slice(5)) assert.strictEqual(call.options.headers['DD-APPLICATION-KEY'], undefined)
  })

  it('evicts exact prompt-wide hot and warm selectors after successful mutations', async () => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-prompt-manager-'))
    fetchStub.resolves(response(200, {}))
    const manager = new PromptManager(makeConfig({
      DD_LLMOBS_PROMPTS_CACHE_DIR: cacheDir,
      DD_LLMOBS_PROMPTS_FILE_CACHE_ENABLED: true,
    }), () => provider)
    const first = cacheKey('foo', ['latest'])
    const second = cacheKey('foo:bar', ['latest'])
    const cached = id => new ManagedPrompt({ id, version: '1', source: 'cache', template: 'x' })
    manager.hotCache.set(first, cached('foo'))
    manager.hotCache.set(second, cached('foo:bar'))
    manager.warmCache.set(first, cached('foo'))
    manager.warmCache.set(second, cached('foo:bar'))

    await manager.createPrompt('foo', [{ role: 'user', content: 'x' }])

    assert.strictEqual(manager.hotCache.get(first), undefined)
    assert.strictEqual(manager.warmCache.get(first), undefined)
    assert.strictEqual(manager.hotCache.get(second).prompt.id, 'foo:bar')
    assert.strictEqual(manager.warmCache.get(second).prompt.id, 'foo:bar')
  })

  it('rejects missing API credentials before provider, cache, HTTP, or fallback', async () => {
    const crudError = sinon.stub(telemetry, 'recordPromptCrudError')
    const fallback = sinon.spy()
    const manager = new PromptManager(makeConfig({ DD_API_KEY: undefined, env: 'production' }), () => provider)

    await assert.rejects(manager.getPrompt('greeting', { fallback }), {
      name: 'PromptAuthError',
      status: 0,
      detail: 'DD_API_KEY is required for prompt operations',
    })
    await assert.rejects(manager.updatePrompt('greeting', { title: 'Greeting' }), {
      name: 'PromptAuthError', status: 0,
    })
    sinon.assert.notCalled(provider.resolveObjectEvaluation)
    sinon.assert.notCalled(fetchStub)
    sinon.assert.notCalled(fallback)
    sinon.assert.calledOnceWithExactly(crudError, 'PATCH', 'PromptAuthError', 0)
  })

  it('validates update fields and write application credentials', async () => {
    const manager = new PromptManager(makeConfig(), () => provider)
    await assert.rejects(manager.updatePrompt('p'), { name: 'PromptValidationError', status: 0 })
    await assert.rejects(manager.updatePromptVersion('p', 1), { name: 'PromptValidationError', status: 0 })

    const noApp = new PromptManager(makeConfig({ DD_APP_KEY: undefined }), () => provider)
    await assert.rejects(noApp.deletePrompt('p'), { name: 'PromptAuthError', status: 0 })
    sinon.assert.notCalled(fetchStub)
  })

  it('maps response statuses and transport failures to the observable error taxonomy', async () => {
    const cases = [
      [400, 'PromptValidationError'],
      [401, 'PromptAuthError'],
      [403, 'PromptAuthError'],
      [404, 'PromptNotFoundError'],
      [409, 'PromptConflictError'],
      [500, 'PromptServerError'],
      [418, 'PromptAPIError'],
    ]
    const manager = new PromptManager(makeConfig(), () => provider)
    for (const [status, name] of cases) {
      fetchStub.resolves(response(status, { detail: 'bad' }))
      await assert.rejects(manager.listPrompts(), { name, status, detail: 'bad' })
      fetchStub.resetBehavior()
    }

    fetchStub.rejects(new Error('connection failed'))
    await assert.rejects(manager.listPrompts(), {
      name: 'PromptAPIError', status: 0, detail: 'connection failed',
    })
  })

  it('handles empty and invalid successful bodies and suppresses deprecated backend fields', async () => {
    const manager = new PromptManager(makeConfig(), () => provider)
    fetchStub.onFirstCall().resolves(response(204))
    fetchStub.onSecondCall().resolves(response(200, 'not json{'))
    fetchStub.onThirdCall().resolves(response(200, [
      { ID: 'one', prompt_id: 'p1', labels: ['old'] },
      { id: 'two', prompt_id: 'p2', labels: ['old'] },
    ]))

    assert.deepStrictEqual(await manager.deletePrompt('p'), {})
    await assert.rejects(manager.listPrompts(), { name: 'PromptServerError', status: 200 })
    assert.deepStrictEqual(await manager.listPrompts(), [
      { id: 'one', prompt_id: 'p1', ID: undefined, labels: undefined },
      { id: 'two', prompt_id: 'p2', ID: undefined, labels: undefined },
    ])
  })

  it('records source, fetch-error, CRUD-error telemetry and uses the five-second timeout default', async () => {
    const source = sinon.stub(telemetry, 'recordPromptSource')
    const fetchError = sinon.stub(telemetry, 'recordPromptFetchError')
    const crudError = sinon.stub(telemetry, 'recordPromptCrudError')
    const timeout = sinon.stub(AbortSignal, 'timeout').returns(new AbortController().signal)
    fetchStub.onFirstCall().resolves(response(404, { detail: 'missing' }))
    fetchStub.onSecondCall().resolves(response(500, { detail: 'boom' }))
    const manager = new PromptManager(makeConfig({ DD_LLMOBS_PROMPTS_CACHE_TTL_SECONDS: 0 }), () => provider)

    const fallback = await manager.getPrompt('greeting', { fallback: 'local' })
    await assert.rejects(manager.listPrompts(), { name: 'PromptServerError' })

    assert.strictEqual(fallback.source, 'fallback')
    sinon.assert.calledWith(source, 'fallback')
    sinon.assert.calledWith(fetchError, 'NotFound')
    sinon.assert.calledWith(crudError, 'GET', 'PromptServerError', 500)
    sinon.assert.alwaysCalledWith(timeout, 5000)
  })

  it('emits the prompt telemetry metric names and exact low-cardinality tags', () => {
    const inc = sinon.stub()
    const count = sinon.stub().returns({ inc })
    const promptTelemetry = proxyquire('../../../src/llmobs/telemetry', {
      '../telemetry/metrics': { manager: { namespace: sinon.stub().returns({ count }) } },
    })

    promptTelemetry.recordPromptSource('hot_cache', 2)
    promptTelemetry.recordPromptFetchError('NotFound', 3)
    promptTelemetry.recordPromptCrudError('PATCH', 'PromptConflictError', 409, 4)

    assert.deepStrictEqual(count.args, [
      ['prompt.source', { from: 'hot_cache' }],
      ['prompt.fetch.error', { error_type: 'NotFound' }],
      ['prompt.crud.error', { method: 'PATCH', error_type: 'PromptConflictError', status: '409' }],
    ])
    assert.deepStrictEqual(inc.args, [[2], [3], [4]])
  })
})
