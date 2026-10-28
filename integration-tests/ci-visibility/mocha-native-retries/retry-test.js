'use strict'

it('inherited', () => {
  throw new Error('expected failure')
})

for (const retries of [1, 2]) {
  for (const once of [false, true]) {
    it(`native override ${retries}${once ? ' once' : ''}`, function () {
      if (!once || this.test.currentRetry() === 0) this.retries(retries)
      throw new Error('expected failure')
    })
  }
}

for (const passes of [false, true]) {
  it(`stops ATR on retry ${passes ? 'pass' : 'fail'}`, function () {
    if (this.test.currentRetry() === 1) {
      this.retries(0)
      if (passes) return
    }
    throw new Error('expected failure')
  })
}

it('extends native budget on ATR retry', function () {
  if (this.test.currentRetry() === 1) this.retries(3)
  throw new Error('expected failure')
})

describe('afterEach changes budget', function () {
  afterEach(function () {
    this.currentTest.retries(0)
  })
  it('fails', function () {
    throw new Error('expected failure')
  })
})
