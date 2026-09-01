'use strict'

const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { describe, it } = require('mocha')
const sinon = require('sinon')

const LLMObsSDK = require('../../../src/llmobs/sdk')
const { WarmCache, cacheKey } = require('../../../src/llmobs/prompts/cache')
const ManagedPrompt = require('../../../src/llmobs/prompts/prompt')
const { getConfigFresh } = require('../../helpers/config')

describe('sdk prompts', () => {
  it('works through the configured SDK while LLMObs span export is disabled', async () => {
    const config = getConfigFresh({})
    config.DD_API_KEY = 'api-key'
    config.env = 'production'
    const provider = {
      resolveObjectEvaluation: sinon.stub().resolves({
        value: { prompt_id: 'greeting', version: 1, template: 'Hello' },
      }),
    }
    const getProvider = sinon.stub().returns(provider)
    const llmobs = new LLMObsSDK(null, { disable () {} }, config, getProvider)

    sinon.assert.notCalled(getProvider)

    const prompt = await llmobs.getPrompt('greeting')

    assert.strictEqual(llmobs.enabled, false)
    assert.strictEqual(prompt.source, 'ff')
    sinon.assert.calledOnce(getProvider)
    sinon.assert.calledOnce(provider.resolveObjectEvaluation)
  })

  it('clears the warm cache before the lazy manager is created', () => {
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-sdk-prompts-'))
    const config = getConfigFresh({})
    config.DD_API_KEY = 'api-key'
    config.DD_LLMOBS_PROMPTS_CACHE_DIR = cacheDir
    config.DD_LLMOBS_PROMPTS_CACHE_TTL_SECONDS = 60
    const cache = new WarmCache({
      cacheDir,
      ttlMs: 60_000,
    })
    cache.set(cacheKey('greeting', ['latest']), new ManagedPrompt({
      id: 'greeting', version: '1', source: 'cache', template: 'Hello',
    }))
    const llmobs = new LLMObsSDK(null, { disable () {} }, config)

    llmobs.clearPromptCache({ hot: false })

    assert.deepStrictEqual(fs.readdirSync(cacheDir), [])
    fs.rmSync(cacheDir, { recursive: true, force: true })
  })
})
