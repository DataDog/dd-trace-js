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
