const { expect } = require('chai')

let currentTestTraceId

describe('mocha-active-span-in-hooks', function () {
  before(() => {
    expect(global._ddtrace.scope().active()).to.equal(null)
  })
  after(() => {
    expect(global._ddtrace.scope().active()).to.equal(null)
  })
  beforeEach(() => {
    currentTestTraceId = global._ddtrace.scope().active().context().toTraceId()
  })
  afterEach(() => {
    expect(currentTestTraceId).to.equal(global._ddtrace.scope().active().context().toTraceId())
  })
  it('first test', () => {
    expect(currentTestTraceId).to.equal(global._ddtrace.scope().active().context().toTraceId())
  })
  it('second test', () => {
    expect(currentTestTraceId).to.equal(global._ddtrace.scope().active().context().toTraceId())
  })
})
