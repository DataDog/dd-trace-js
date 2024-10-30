'use strict'

require('../../../../dd-trace/test/setup/tap')

const { fork } = require('child_process')
const path = require('path')

const { assert } = require('chai')

describe('test visibility with dynamic instrumentation', () => {
  let childProcess

  afterEach(() => {
    if (childProcess) {
      childProcess.kill()
    }
  })

  it('can grab local variables', (done) => {
    childProcess = fork(path.join(__dirname, 'target-app', 'test-visibility-dynamic-instrumentation-script.js'))

    childProcess.on('message', ({ snapshot: { language, stack, probe, captures }, snapshotId }) => {
      assert.exists(snapshotId)
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

      done()
    })
  })
})
