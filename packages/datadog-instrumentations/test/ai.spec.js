'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')

const { channel, tracingChannel } = require('dc-polyfill')
const { afterEach, before, beforeEach, describe, it } = require('mocha')
const semver = require('semver')
const sinon = require('sinon')

const { engines, nodeMaxMajor } = require('../../../package.json')
const { getActivationSetup } = require('../src/helpers/rewriter/instrumentation-registry')

const modelInterceptChannel = channel('dd-trace:vercel-ai:model:intercept')
const resolveLanguageModelChannel = tracingChannel('orchestrion:ai:resolveLanguageModel')

describe('vercel ai Orchestrion activation', () => {
  const runtimeSupported = process.env.DD_INJECT_FORCE ||
    semver.satisfies(process.version, `${engines.node} <${nodeMaxMajor}`)
  const init = require.resolve('../../../init.js')
  const initialize = require.resolve('../../../initialize.mjs')
  const register = JSON.stringify(require.resolve('../../../register.js'))
  const assertions = JSON.stringify(require.resolve('./fixtures/ai-activation'))

  for (const version of ['4.0.0', '4', '5', '6.0.0', '6', '7.0.0', '7']) {
    const major = Number(version.split('.')[0])
    const cwd = resolve(__dirname, `../../../versions/ai@${version}`)

    for (const first of ['require', 'import']) {
      it(`instruments the first call to ai@${version} loaded by ${first}`, function () {
        if (!runtimeSupported) this.skip()
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- Older Node versions lack require(ESM).
        if (first === 'require' && major === 7 && !process.features.require_module) this.skip()

        const preload = first === 'require' ? ['--require', init] : ['--import', initialize]
        const { error, status, stderr } = spawnSync(process.execPath, [...preload, '--input-type=module'], {
          cwd,
          env: { ...process.env, DD_TRACE_STARTUP_LOGS: 'false' },
          encoding: 'utf8',
          timeout: 15_000,
          input: `
            import { createRequire } from 'node:module'
            const require = createRequire(import.meta.url)
            const { checkActivation, checkEmbed, checkStream } = require(${assertions})
            const check = checkActivation('dd-trace:instrumentation:load:orchestrion')
            const load = { require: () => require('ai'), import: () => import('ai') }
            const ai = await load.${first}()
            check(1)
            if (${major} === 7) {
              await checkStream(ai)
            } else {
              await checkEmbed(ai, ${major - 3})
            }

            // v4–6 have two distinct builds, so exercise setup again when the other build loads.
            if (${major} < 7) {
              if (${JSON.stringify(first)} === 'require') require(${register})
              const other = await load.${first === 'require' ? 'import' : 'require'}()
              check(2)
              await checkEmbed(other, ${major - 3})
            }
          `,
        })
        assert.ifError(error)
        assert.strictEqual(status, 0, stderr)
      })
    }
  }
})

/**
 * Emits the same `resolveLanguageModel` event the AI SDK does, so the tests drive the
 * instrumentation's real entry point.
 *
 * @param {unknown} requested
 * @param {object} [resolved]
 */
function resolveLanguageModel (requested, resolved = requested) {
  resolveLanguageModelChannel.end.publish({ arguments: [requested], result: resolved })
}

function subscribeIntercept (onIntercept = () => {}) {
  const calls = []
  const handler = ctx => {
    calls.push(ctx)
    onIntercept(ctx)
  }
  modelInterceptChannel.subscribe(handler)
  return { calls, unsubscribe: () => modelInterceptChannel.unsubscribe(handler) }
}

describe('vercel ai model interception', () => {
  let model
  let doGenerate

  before(() => {
    const setup = getActivationSetup('ai')
    setup({ moduleName: 'ai' })
  })

  beforeEach(() => {
    doGenerate = sinon.stub().resolves({ content: [] })
    model = { doGenerate }
  })

  afterEach(() => {
    sinon.restore()
  })

  it('calls the original directly when nothing is subscribed', () => {
    resolveLanguageModel(model)

    return model.doGenerate({ prompt: [] }).then(() => sinon.assert.calledOnce(doGenerate))
  })

  it('publishes the native call data per call', () => {
    const { calls, unsubscribe } = subscribeIntercept()
    resolveLanguageModel(model)

    const options = { prompt: [{ role: 'user' }] }
    return model.doGenerate(options)
      .then(() => {
        assert.strictEqual(calls.length, 1)
        assert.strictEqual(calls[0].method, 'doGenerate')
        assert.deepStrictEqual(calls[0].arguments, [options])
      })
      .finally(unsubscribe)
  })

  it('wraps the resolved model when the SDK built it from a string id', () => {
    const { calls, unsubscribe } = subscribeIntercept()
    resolveLanguageModel('openai/gpt-4o', model)

    return model.doGenerate({ prompt: [] })
      .then(() => assert.strictEqual(calls.length, 1))
      .finally(unsubscribe)
  })

  it('wraps the caller-supplied model when it differs from the resolved one', () => {
    const { calls, unsubscribe } = subscribeIntercept()
    const resolved = { doGenerate: sinon.stub().resolves({ content: [] }) }
    resolveLanguageModel(model, resolved)

    return model.doGenerate({ prompt: [] })
      .then(() => resolved.doGenerate({ prompt: [] }))
      .then(() => assert.strictEqual(calls.length, 1))
      .finally(unsubscribe)
  })

  it('does not wrap the same model twice', () => {
    const { calls, unsubscribe } = subscribeIntercept()
    resolveLanguageModel(model)
    resolveLanguageModel(model)

    return model.doGenerate({ prompt: [] })
      .then(() => assert.strictEqual(calls.length, 1))
      .finally(unsubscribe)
  })

  it('starts the model call without waiting for beforeResult', () => {
    let release
    const { unsubscribe } = subscribeIntercept(ctx => {
      ctx.beforeResult = () => new Promise(resolve => { release = resolve })
    })
    resolveLanguageModel(model)

    const pending = model.doGenerate({ prompt: [{ role: 'user' }] })

    return new Promise(resolve => setImmediate(resolve))
      .then(() => {
        sinon.assert.calledOnce(doGenerate)
        release()
        return pending
      })
      .finally(unsubscribe)
  })

  it('lets a subscriber replace the delivered result', () => {
    const replacement = { content: [{ type: 'text', text: 'redacted' }] }
    const { unsubscribe } = subscribeIntercept(ctx => {
      ctx.onResult = () => replacement
    })
    resolveLanguageModel(model)

    return model.doGenerate({ prompt: [{ role: 'user' }] })
      .then(result => assert.strictEqual(result, replacement))
      .finally(unsubscribe)
  })

  it('rejects the call when beforeResult rejects', () => {
    const err = Object.assign(new Error('blocked'), { name: 'AIGuardAbortError' })
    const { unsubscribe } = subscribeIntercept(ctx => {
      ctx.beforeResult = () => Promise.reject(err)
    })
    resolveLanguageModel(model)

    return assert.rejects(() => model.doGenerate({ prompt: [{ role: 'user' }] }), e => e === err)
      .finally(unsubscribe)
  })

  it('publishes for doStream as well', () => {
    const { calls, unsubscribe } = subscribeIntercept()
    const doStream = sinon.stub().resolves({ stream: {} })
    const streamModel = { doStream }
    resolveLanguageModel(streamModel)

    return streamModel.doStream({ prompt: [] })
      .then(() => assert.strictEqual(calls[0].method, 'doStream'))
      .finally(unsubscribe)
  })
})
