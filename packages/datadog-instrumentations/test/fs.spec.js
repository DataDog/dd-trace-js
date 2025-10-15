'use strict'

const assert = require('node:assert')
const { describe, it, afterEach } = require('mocha')

const agent = require('../../dd-trace/test/plugins/agent')

describe('fs instrumentation', () => {
  afterEach(() => {
    return agent.close({ ritmReset: false })
  })

  it('require node:fs should work', () => {
    return agent.load('node:fs', undefined, { flushInterval: 1 }).then(() => {
      const fs = require('node:fs')
      assert(fs !== undefined)
    })
  })

  it('require fs should work', () => {
    return agent.load('fs', undefined, { flushInterval: 1 }).then(() => {
      const fs = require('fs')
      assert(fs !== undefined)
    })
  })
})
