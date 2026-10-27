'use strict'

it('inherited', () => {
  throw new Error('expected failure')
})

for (const retries of [1, 2]) {
  it(`native override ${retries}`, function () {
    this.retries(retries)
    throw new Error('expected failure')
  })
}
