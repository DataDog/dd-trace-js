'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

describe('loader-hook', () => {
  let importCounter = 0
  let originalTinypoolWorkerId
  let originalDdVitestWorker
  let originalVitestLightInit

  beforeEach(() => {
    originalTinypoolWorkerId = process.env.TINYPOOL_WORKER_ID
    originalDdVitestWorker = process.env.DD_VITEST_WORKER
    originalVitestLightInit = process.env.DD_EXPERIMENTAL_TEST_OPT_VITEST_LIGHT_INIT
    delete process.env.TINYPOOL_WORKER_ID
    delete process.env.DD_VITEST_WORKER
    delete process.env.DD_EXPERIMENTAL_TEST_OPT_VITEST_LIGHT_INIT
  })

  afterEach(() => {
    if (originalTinypoolWorkerId === undefined) {
      delete process.env.TINYPOOL_WORKER_ID
    } else {
      process.env.TINYPOOL_WORKER_ID = originalTinypoolWorkerId
    }
    if (originalDdVitestWorker === undefined) {
      delete process.env.DD_VITEST_WORKER
    } else {
      process.env.DD_VITEST_WORKER = originalDdVitestWorker
    }
    if (originalVitestLightInit === undefined) {
      delete process.env.DD_EXPERIMENTAL_TEST_OPT_VITEST_LIGHT_INIT
    } else {
      process.env.DD_EXPERIMENTAL_TEST_OPT_VITEST_LIGHT_INIT = originalVitestLightInit
    }
  })

  it('uses the default ESM loader outside Vitest workers', async () => {
    const loaderHook = await importLoaderHook()
    const result = await resolveModule(loaderHook, 'left-pad', 'file:///app/node_modules/left-pad/index.js')

    assert.deepStrictEqual(result, {
      url: 'file:///app/node_modules/left-pad/index.js?iitm=true',
      shortCircuit: true,
      format: undefined,
    })
  })

  it('uses the default ESM loader when only TINYPOOL_WORKER_ID is set', async () => {
    process.env.TINYPOOL_WORKER_ID = '1'
    process.env.DD_EXPERIMENTAL_TEST_OPT_VITEST_LIGHT_INIT = 'true'

    const loaderHook = await importLoaderHook()
    const result = await resolveModule(loaderHook, 'left-pad', 'file:///app/node_modules/left-pad/index.js')

    assert.deepStrictEqual(result, {
      url: 'file:///app/node_modules/left-pad/index.js?iitm=true',
      shortCircuit: true,
      format: undefined,
    })
  })

  it('uses the default ESM loader in Vitest workers when light init is disabled', async () => {
    process.env.DD_VITEST_WORKER = '1'

    const loaderHook = await importLoaderHook()
    const result = await resolveModule(loaderHook, 'left-pad', 'file:///app/node_modules/left-pad/index.js')

    assert.deepStrictEqual(result, {
      url: 'file:///app/node_modules/left-pad/index.js?iitm=true',
      shortCircuit: true,
      format: undefined,
    })
  })

  it('skips import-in-the-middle for non-target modules when Vitest light init is enabled', async () => {
    enableVitestLightInit()

    const loaderHook = await importLoaderHook()
    const result = await resolveModule(loaderHook, 'left-pad', 'file:///app/node_modules/left-pad/index.js')

    assert.deepStrictEqual(result, {
      url: 'file:///app/node_modules/left-pad/index.js',
    })
  })

  it('uses import-in-the-middle for Vitest runner modules when Vitest light init is enabled', async () => {
    enableVitestLightInit()

    const loaderHook = await importLoaderHook()
    const result = await resolveModule(
      loaderHook,
      '@vitest/runner',
      'file:///app/node_modules/@vitest/runner/dist/index.js'
    )

    assert.deepStrictEqual(result, {
      url: 'file:///app/node_modules/@vitest/runner/dist/index.js?iitm=true',
      shortCircuit: true,
      format: undefined,
    })
  })

  it('uses import-in-the-middle for HTTP builtins when Vitest light init is enabled', async () => {
    enableVitestLightInit()

    const loaderHook = await importLoaderHook()
    const result = await resolveModule(loaderHook, 'node:http', 'node:http')

    assert.deepStrictEqual(result, {
      url: 'node:http?iitm=true',
      shortCircuit: true,
      format: undefined,
    })
  })

  it('does not use import-in-the-middle for DNS and net builtins when Vitest light init is enabled', async () => {
    enableVitestLightInit()

    const loaderHook = await importLoaderHook()

    assert.deepStrictEqual(await resolveModule(loaderHook, 'node:dns', 'node:dns'), {
      url: 'node:dns',
    })
    assert.deepStrictEqual(await resolveModule(loaderHook, 'node:dns/promises', 'node:dns/promises'), {
      url: 'node:dns/promises',
    })
    assert.deepStrictEqual(await resolveModule(loaderHook, 'node:net', 'node:net'), {
      url: 'node:net',
    })
  })

  function enableVitestLightInit () {
    process.env.DD_VITEST_WORKER = '1'
    process.env.DD_EXPERIMENTAL_TEST_OPT_VITEST_LIGHT_INIT = 'true'
  }

  function importLoaderHook () {
    const loaderHookUrl = pathToFileURL(path.join(__dirname, '../../..', 'loader-hook.mjs'))
    loaderHookUrl.search = `?test=${++importCounter}`
    return import(loaderHookUrl)
  }

  function resolveModule (loaderHook, specifier, url) {
    return loaderHook.resolve(specifier, { parentURL: 'file:///app/test.mjs' }, () => ({ url }))
  }
})
