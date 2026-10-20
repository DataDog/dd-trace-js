'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')

const { describe, it } = require('mocha')

describe('cached Lambda shim completion adapter', () => {
  for (const disabled of [false, true]) {
    it(`${disabled ? 'preserves' : 'patches'} cached application and layer copies`, () => {
      const script = `
        const assert = require('node:assert/strict')
        const fs = require('node:fs')
        const os = require('node:os')
        const path = require('node:path')
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-cached-shim-'))
        try {
          const helpers = []
          for (const prefix of ['app', 'layer/nodejs']) {
            const base = path.join(root, prefix, 'node_modules/datadog-lambda-js')
            fs.mkdirSync(path.join(base, 'dist/utils'), { recursive: true })
            fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({
              name: 'datadog-lambda-js', version: '12.143.0', main: 'dist/index.js'
            }))
            fs.writeFileSync(path.join(base, 'dist/utils/handler.js'),
              'globalThis.helperLoads = (globalThis.helperLoads || 0) + 1; ' +
              'exports.promisifiedHandler = handler => handler')
            const helper = require(path.join(base, 'dist/utils/handler.js'))
            helpers.push([helper, helper.promisifiedHandler])
          }
          process.env.AWS_LAMBDA_FUNCTION_NAME = 'cached-helper-test'
          process.env.LAMBDA_TASK_ROOT = root
          process.env.DD_LAMBDA_HANDLER = 'handler.handler'
          process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = ${JSON.stringify(disabled ? 'lambda' : '')}
          require(${JSON.stringify(require.resolve('../../src/lambda'))})
          assert.strictEqual(globalThis.helperLoads, 2, 'cached modules must not be evaluated again')
          for (const [helper, original] of helpers) {
            assert.${disabled ? 'strictEqual' : 'notStrictEqual'}(helper.promisifiedHandler, original)
            assert.strictEqual(helper.promisifiedHandler(() => 'done')(), 'done')
          }
        } finally {
          fs.rmSync(root, { recursive: true, force: true })
        }
      `
      const result = spawnSync(process.execPath, ['--eval', script], { encoding: 'utf8', timeout: 5000 })
      assert.strictEqual(result.status, 0, result.stderr)
    })
  }

  it('does not load an available shim helper that has not been imported', () => {
    const script = `
      const assert = require('node:assert/strict')
      const fs = require('node:fs')
      const os = require('node:os')
      const path = require('node:path')
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-unloaded-shim-'))
      try {
        const base = path.join(root, 'node_modules/datadog-lambda-js')
        fs.mkdirSync(path.join(base, 'dist/utils'), { recursive: true })
        fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({
          name: 'datadog-lambda-js', version: '12.143.0', main: 'dist/index.js'
        }))
        const helper = path.join(base, 'dist/utils/handler.js')
        fs.writeFileSync(helper, 'throw new Error("shim helper must not be loaded eagerly")')
        process.env.AWS_LAMBDA_FUNCTION_NAME = 'unloaded-helper-test'
        process.env.LAMBDA_TASK_ROOT = root
        process.env.DD_LAMBDA_HANDLER = 'handler.handler'
        process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = ''
        require(${JSON.stringify(require.resolve('../../src/lambda'))})
        assert.strictEqual(require.cache[helper], undefined)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    `
    const result = spawnSync(process.execPath, ['--eval', script], { encoding: 'utf8', timeout: 5000 })
    assert.strictEqual(result.status, 0, result.stderr)
  })
})
