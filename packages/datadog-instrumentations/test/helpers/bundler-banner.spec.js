'use strict'

const assert = require('node:assert/strict')
const vm = require('node:vm')

const createBundlerBanner = require('../../src/helpers/bundler-banner')

describe('bundler banner', () => {
  it('keeps the startup code that bundles and runtimes of other versions rely on', () => {
    assert.equal(
      createBundlerBanner('webpack'),
      '((r,b)=>{r.bundlers.push(b);r.onBundle?.(b)})(globalThis[Symbol.for("dd-trace:bundler")]??={bundlers:[]},' +
        '"webpack");'
    )
  })

  it('shares the record between bundlers without requiring dd-trace', () => {
    const context = vm.createContext({})
    vm.runInContext(createBundlerBanner('webpack'), context)
    vm.runInContext(createBundlerBanner('esbuild'), context)
    const record = vm.runInContext('globalThis[Symbol.for("dd-trace:bundler")]', context)

    assert.deepStrictEqual(Array.from(record.bundlers), ['webpack', 'esbuild'])
  })

  it('notifies a preloaded tracer of each later bundle', () => {
    const context = vm.createContext({})
    vm.runInContext(createBundlerBanner('webpack'), context)
    const record = vm.runInContext('globalThis[Symbol.for("dd-trace:bundler")]', context)
    const calls = []
    record.onBundle = bundler => calls.push(bundler)

    vm.runInContext(createBundlerBanner('esbuild'), context)

    assert.deepStrictEqual(calls, ['esbuild'])
    assert.deepStrictEqual(Array.from(record.bundlers), ['webpack', 'esbuild'])
  })

  it('JSON-encodes the bundler name rather than interpolating executable code', () => {
    const context = vm.createContext({})
    const name = '");throw new Error("injected");//'
    const banner = createBundlerBanner(name)

    assert.equal(banner.includes('\n'), false)
    vm.runInContext(banner, context)
    const record = vm.runInContext('globalThis[Symbol.for("dd-trace:bundler")]', context)
    assert.equal(record.bundlers[0], name)
  })
})
