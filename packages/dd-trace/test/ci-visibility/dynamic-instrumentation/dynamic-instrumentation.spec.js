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

    childProcess.on('message', ({ snapshot, probeId }) => {
      if (!snapshot) return

      const { language, stack, probe, captures } = snapshot
      assert.ok(probeId)
      assert.ok(probe)
      assert.ok(stack)
      assert.strictEqual(language, 'javascript')
      assert.strictEqual(probe.version, 0)

      assert.deepStrictEqual(captures, {
        lines: {
          10: {
            locals: {
              a: { type: 'number', value: '1' },
              b: { type: 'number', value: '2' },
              localVar: { type: 'number', value: '1' },
              users: { type: 'Array' },
            },
          },
        },
      })

      done()
    })
  })

  it('omits empty collection payloads from captured values', (done) => {
    childProcess = fork(path.join(__dirname, 'target-app', 'test-visibility-dynamic-instrumentation-script.js'))

    childProcess.on('message', ({ snapshot }) => {
      if (!snapshot) return

      const users = snapshot.captures.lines[10].locals.users
      assert.strictEqual(users.type, 'Array')
      assert.strictEqual('elements' in users, false)
      assert.doesNotMatch(JSON.stringify(snapshot), /"elements":\[\]/)

      done()
    })
  })

  it('waits for in-flight breakpoint hits', (done) => {
    childProcess = fork(path.join(__dirname, 'target-app', 'test-visibility-dynamic-instrumentation-script.js'))

    const messages = []
    childProcess.on('message', (message) => {
      messages.push(message)

      if (!message.drained) return

      assert.ok(messages[0].snapshot)
      assert.ok(messages.some(({ drained }) => drained))
      done()
    })
  })
})
