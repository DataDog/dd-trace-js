'use strict'

function fail () {
  throw new Error('expected failure')
}

it('inherited', fail)
it('equal override', { retries: 1 }, fail)
it('different override', { retries: 2 }, fail)

describe('suite override', { retries: 1 }, () => {
  it('fails', fail)
})
