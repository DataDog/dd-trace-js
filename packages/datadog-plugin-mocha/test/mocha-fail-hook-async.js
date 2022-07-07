const { expect } = require('chai')

describe('mocha-fail-hook-async', function () {
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
  afterEach((done) => {
    done()
  })
  it('will run and be reported as passed', () => {
    expect(true).to.equal(true)
  })
})

describe('mocha-fail-hook-async-other-before', function () {
  beforeEach((done) => {
    setTimeout(() => {
      done(new Error('yeah error'))
    }, 200)
  })
  it('will not run and be reported as failed', () => {
    expect(true).to.equal(true)
  })
})

describe('mocha-fail-hook-async-other-second-after', function () {
  afterEach((done) => {
    done()
  })
  afterEach((done) => {
    // the second afterEach will fail
    setTimeout(() => {
      done(new Error('yeah error'))
    }, 200)
  })
  it('will run and be reported as failed', () => {
    expect(true).to.equal(true)
  })
})
