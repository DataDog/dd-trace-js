const agent = require('../../dd-trace/test/plugins/agent')
describe('fs instrumentation', () => {
  it('require node:fs should work', () => {
    return agent.load('node:fs', undefined, { flushInterval: 1 }).then(() => {
      const fs = require('node:fs')
      expect(fs).not.to.be.undefined
    })
  })
  it('require fs should work', () => {
    return agent.load('fs', undefined, { flushInterval: 1 }).then(() => {
      const fs = require('fs')
      expect(fs).not.to.be.undefined
    })
  })
})
