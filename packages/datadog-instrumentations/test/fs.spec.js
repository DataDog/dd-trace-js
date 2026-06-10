'use strict'

const assert = require('node:assert')
const { describe, it, afterEach } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')

describe('fs instrumentation', () => {
  afterEach(() => {
    return agent.close()
  })

  it('require node:fs should work', async () => {
    await agent.load('node:fs', undefined, { flushInterval: 1 })
    const fs = require('node:fs')
    assert.notStrictEqual(fs, undefined)
  })

  it('require fs should work', async () => {
    await agent.load('fs', undefined, { flushInterval: 1 })
    const fs = require('fs')
    assert.notStrictEqual(fs, undefined)
  })
})
