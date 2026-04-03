'use strict'

const assert = require('node:assert/strict')
const { fork } = require('node:child_process')
const path = require('node:path')

const { describe, it, afterEach } = require('mocha')

require('../../../../dd-trace/test/setup/core')

describe('test visibility with dynamic instrumentation', () => {
  // Dynamic Instrumentation - Test Visibility not currently supported for windows
  if (process.platform === 'win32') {
    return
  }
  let childProcess

  afterEach(() => {
    if (childProcess) {
      childProcess.kill()
    }
  })

  it('can grab local variables', (done) => {
    childProcess = fork(path.join(__dirname, 'target-app', 'test-visibility-dynamic-instrumentation-script.js'))

    childProcess.on('message', ({ snapshot: { language, stack, probe, captures }, probeId }) => {
      assert.ok(probeId)
      assert.ok(probe)
      assert.ok(stack)
      assert.strictEqual(language, 'javascript')

      assert.deepStrictEqual(captures, {
        lines: {
          9: {
            locals: {
              a: { type: 'number', value: '1' },
              b: { type: 'number', value: '2' },
              localVar: { type: 'number', value: '1' },
            },
          },
        },
      })

      done()
    })
  })
})
