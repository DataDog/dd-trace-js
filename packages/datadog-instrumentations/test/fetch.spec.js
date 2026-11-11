'use strict'

const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')

const { before, describe, it } = require('mocha')

describe('packages/datadog-instrumentations/src/fetch.js', () => {
  it('defers loading native fetch until first use and instruments every call', () => {
    const script = `
      const { channel, tracingChannel } = require('dc-polyfill')
      require(${JSON.stringify(require.resolve('../src/fetch'))})
      const undiciLoaded = () => process.moduleLoadList.includes('NativeModule internal/deps/undici/undici')
      const loadedBeforeFetch = undiciLoaded()
      let loads = 0
      let requests = 0
      channel('dd-trace:instrumentation:load').subscribe(() => loads++)
      tracingChannel('apm:fetch:request').start.subscribe(() => requests++)
      ;(async () => {
        const first = await fetch('data:text/plain,first')
        const second = await fetch('data:text/plain,second')
        console.log(JSON.stringify({
          loadedBeforeFetch,
          loadedAfterFetch: undiciLoaded(),
          loads,
          requests,
          bodies: [await first.text(), await second.text()],
        }))
      })().catch(error => { console.error(error); process.exitCode = 1 })
    `
    const result = spawnSync(process.execPath, ['--eval', script], { encoding: 'utf8', timeout: 10_000 })

    assert.strictEqual(result.status, 0, result.stderr)
    assert.deepStrictEqual(JSON.parse(result.stdout), {
      loadedBeforeFetch: false,
      loadedAfterFetch: true,
      loads: 1,
      requests: 2,
      bodies: ['first', 'second'],
    })
  })

  describe('globalThis.fetch identity', () => {
    let nameBefore

    before(() => {
      nameBefore = globalThis.fetch.name
      require('../src/fetch')
    })

    it('preserves the fetch function name after dd-trace loads', () => {
      assert.equal(nameBefore, 'fetch')
      assert.equal(globalThis.fetch.name, 'fetch')
    })

    it('forwards calls to the wrapped fetch without recursion', () => {
      return assert.rejects(globalThis.fetch('not-a-real-protocol://x'), TypeError)
    })
  })
})
