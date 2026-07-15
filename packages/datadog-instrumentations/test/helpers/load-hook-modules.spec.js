'use strict'

const assert = require('node:assert/strict')

const loadHookModules = require('../../src/helpers/load-hook-modules')

describe('loadHookModules', () => {
  it('loads function hooks and object hooks that declare a function', () => {
    const loaded = []
    const hooks = {
      direct: () => loaded.push('direct'),
      configured: { fn: () => loaded.push('configured') },
      orchestrion: { orchestrion: true },
      disabled: null,
    }

    loadHookModules(hooks)

    assert.deepStrictEqual(loaded, ['direct', 'configured'])
  })
})
