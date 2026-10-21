'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')

const { describe, it } = require('mocha')

describe('cached datadog-lambda-js completion adapter', () => {
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
            for (const directory of ['dist', '']) {
              const base = path.join(root, directory || 'published', prefix, 'node_modules/datadog-lambda-js')
              const helperPath = path.join(base, directory, 'utils/handler.js')
              fs.mkdirSync(path.dirname(helperPath), { recursive: true })
              fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({
                name: 'datadog-lambda-js', version: '12.143.0', main: path.join(directory, 'index.js')
              }))
              fs.writeFileSync(helperPath,
                'globalThis.helperLoads = (globalThis.helperLoads || 0) + 1; ' +
                'exports.promisifiedHandler = handler => handler')
              const helper = require(helperPath)
              helpers.push([helper, helper.promisifiedHandler])
            }
          }
          process.env.AWS_LAMBDA_FUNCTION_NAME = 'cached-helper-test'
          process.env.LAMBDA_TASK_ROOT = root
          process.env.DD_LAMBDA_HANDLER = 'handler.handler'
          process.env.DD_TRACE_DISABLED_INSTRUMENTATIONS = ${JSON.stringify(disabled ? 'lambda' : '')}
          require(${JSON.stringify(require.resolve('../../src/lambda'))})
          assert.strictEqual(globalThis.helperLoads, 4, 'cached modules must not be evaluated again')
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

  for (const directory of ['dist', '']) {
    it(`does not eagerly load an available ${directory || 'published'} datadog-lambda-js helper`, () => {
      const script = `
        const assert = require('node:assert/strict')
        const fs = require('node:fs')
        const os = require('node:os')
        const path = require('node:path')
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lambda-unloaded-shim-'))
        try {
          const base = path.join(root, 'node_modules/datadog-lambda-js')
          const directory = ${JSON.stringify(directory)}
          const helper = path.join(base, directory, 'utils/handler.js')
          fs.mkdirSync(path.dirname(helper), { recursive: true })
          fs.writeFileSync(path.join(base, 'package.json'), JSON.stringify({
            name: 'datadog-lambda-js', version: '12.143.0', main: path.join(directory, 'index.js')
          }))
          fs.writeFileSync(helper, 'throw new Error("datadog-lambda-js helper must not be loaded eagerly")')
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
  }
})
