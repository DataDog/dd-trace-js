const { expect } = require('chai')

describe('mocha-fail-hook-async', function () {
  this.timeout(10000000)
  afterEach((done) => {
    setTimeout(() => {
      done(new Error('yeah error'))
    }, 200)
  })
  it('will run but be reported as failed', () => {
    expect(true).to.equal(true)
  })
})

describe('mocha-fail-hook-async-other', function () {
  this.timeout(10000000)
  afterEach((done) => {
    done()
  })
  it('will run and be reported as passed', () => {
    expect(true).to.equal(true)
  })
})
