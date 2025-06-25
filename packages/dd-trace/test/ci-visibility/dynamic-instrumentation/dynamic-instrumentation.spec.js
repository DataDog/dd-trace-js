'use strict'

const t = require('tap')
require('../../../../dd-trace/test/setup/core')

const { fork } = require('child_process')
const path = require('path')

const { assert } = require('chai')

t.test('test visibility with dynamic instrumentation', t => {
  // Dynamic Instrumentation - Test Visibility not currently supported for windows
  if (process.platform === 'win32') {
    return
  }
  let childProcess

  t.afterEach(() => {
    if (childProcess) {
      childProcess.kill()
    }
  })

  t.test('can grab local variables', (t) => {
    childProcess = fork(path.join(__dirname, 'target-app', 'test-visibility-dynamic-instrumentation-script.js'))

    childProcess.on('message', ({ snapshot: { language, stack, probe, captures }, probeId }) => {
      assert.exists(probeId)
      assert.exists(probe)
      assert.exists(stack)
      assert.equal(language, 'javascript')

      assert.deepEqual(captures, {
        lines: {
          9: {
            locals: {
              a: { type: 'number', value: '1' },
              b: { type: 'number', value: '2' },
              localVar: { type: 'number', value: '1' }
            }
          }
        }
      })

      t.end()
    })
  })
  t.end()
})
