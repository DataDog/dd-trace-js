import { describe, test } from 'vitest'

function fail () {
  throw new Error('expected failure')
}

test('inherited', fail)
test('equal override', { retry: 1 }, fail)
test('different override', { retry: 2 }, fail)

describe('suite override', { retry: 1 }, () => {
  test('fails', fail)
})
