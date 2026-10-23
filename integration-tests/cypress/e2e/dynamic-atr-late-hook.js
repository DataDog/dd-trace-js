/* eslint-disable */

afterEach(function () {
  if (this.currentTest.title === 'always fails in a late hook' || this.currentTest.currentRetry() === 0) {
    throw new Error('late afterEach failure')
  }
})

it('eventually passes the late hook', () => {})
it('always fails in a late hook', () => {})
