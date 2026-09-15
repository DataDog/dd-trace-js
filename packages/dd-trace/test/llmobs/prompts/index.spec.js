'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const os = require('node:os')
const path = require('node:path')
const { describe, it } = require('mocha')
const sinon = require('sinon')

const { createPrompts } = require('../../../src/llmobs/prompts')
const { Prompts } = require('../../../src/llmobs/prompts')
const log = require('../../../src/log')

describe('prompt facade', () => {
  it('returns a no-op facade while LLMObs is disabled', async () => {
    const prompts = createPrompts({ llmobs: { DD_LLMOBS_ENABLED: false } })
    assert.strictEqual(typeof prompts.get, 'function')
    const prompt = await prompts.get('id', { fallback: 'fallback' })
    assert.strictEqual(prompt.render(), 'fallback')
    await assert.rejects(prompts.list(),
      error => error instanceof Error && 'status' in error && error.status === 0)
  })

  it('returns a fallback from the no-op facade and warns once', async () => {
    const prompts = createPrompts({ llmobs: { DD_LLMOBS_ENABLED: false } })
    const warn = sinon.stub(log, 'warn')
    try {
      await prompts.get('id', { fallback: 'fallback' })
      await prompts.get('id', { fallback: 'fallback' })
      assert.strictEqual(warn.calledOnce, true)
    } finally {
      warn.restore()
    }
  })

  it('constructs canonical prompt config properties from environment variables', () => {
    const cacheDir = path.join(os.tmpdir(), 'dd-prompts-config-test')
    const output = execFileSync(process.execPath, ['-e', `
      const config = require(${JSON.stringify(require.resolve('../../../src/config'))})()
      process.stdout.write(JSON.stringify({
        cacheTtl: config.llmobs.promptsCacheTtl,
        fileCacheEnabled: config.llmobs.promptsFileCacheEnabled,
        fileCacheDir: config.llmobs.promptsFileCacheDir,
        timeout: config.llmobs.promptsTimeout,
      }))
    `], {
      env: {
        ...process.env,
        DD_LLMOBS_ENABLED: 'true',
        DD_API_KEY: 'api',
        DD_LLMOBS_PROMPTS_CACHE_TTL: '120',
        DD_LLMOBS_PROMPTS_FILE_CACHE_ENABLED: 'true',
        DD_LLMOBS_PROMPTS_CACHE_DIR: cacheDir,
        DD_LLMOBS_PROMPTS_TIMEOUT: '7',
      },
    }).toString()
    assert.deepEqual(JSON.parse(output), {
      cacheTtl: 120,
      fileCacheEnabled: true,
      fileCacheDir: cacheDir,
      timeout: 7,
    })
  })

  it('delegates all facade operations to its manager', async () => {
    const calls = []
    const manager = {
      get: (...args) => calls.push(['get', args]),
      create: (...args) => calls.push(['create', args]),
      createVersion: (...args) => calls.push(['createVersion', args]),
      update: (...args) => calls.push(['update', args]),
      updateVersion: (...args) => calls.push(['updateVersion', args]),
      delete: (...args) => calls.push(['delete', args]),
      list: (...args) => calls.push(['list', args]),
      listVersions: (...args) => calls.push(['listVersions', args]),
      refresh: (...args) => calls.push(['refresh', args]),
      clearCache: (...args) => calls.push(['clearCache', args]),
    }
    const prompts = new Prompts(manager)
    prompts.get('id')
    prompts.create({ id: 'id', template: 'x' })
    prompts.createVersion('id', { template: 'x' })
    prompts.update('id', { title: 'x' })
    prompts.updateVersion('id', 1, { description: 'x' })
    prompts.delete('id')
    prompts.list()
    prompts.listVersions('id')
    prompts.refresh('id')
    prompts.clearCache()
    assert.deepEqual(calls.map(([name]) => name), [
      'get', 'create', 'createVersion', 'update', 'updateVersion', 'delete',
      'list', 'listVersions', 'refresh', 'clearCache',
    ])
  })
})
