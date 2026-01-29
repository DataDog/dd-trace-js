'use strict'

const assert = require('assert')
const { setup } = require('./utils')

describe('Dynamic Instrumentation', function () {
  const t = setup({ testApp: 'target-app/basic.js', dependencies: ['fastify'] })

  it('base case: target app should work as expected if no test probe has been added', async function () {
    const response = await t.axios.get(t.breakpoint.url)
    assert.strictEqual(response.status, 200)
    assert.deepStrictEqual(response.data, { hello: 'bar' })
  })
})
