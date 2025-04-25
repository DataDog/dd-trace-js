const { expect } = require('chai')
const sum = require('./sum')
const ddTrace = require('dd-trace')

describe('ci visibility', () => {
  beforeEach(() => {
    const testSpan = ddTrace.scope().active()
    testSpan.setTag('custom_tag.beforeEach', 'true')
  })

  it('can report tests', () => {
    const testSpan = ddTrace.scope().active()
    testSpan.setTag('custom_tag.it', 'true')
    expect(sum(1, 2)).to.equal(3)
  })

  afterEach(() => {
    const testSpan = ddTrace.scope().active()
    testSpan.setTag('custom_tag.afterEach', 'true')
  })
})
