/* eslint-disable */

it('retries an earlier user hook', { retries: 0 }, () => {
  throw new Error('the test body should not run')
})
