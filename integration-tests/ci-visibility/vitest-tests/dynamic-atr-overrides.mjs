import { describe, test } from 'vitest'

function fail () {
  throw new Error('test failed')
}

test('inherited', fail)

for (const retry of [0, 2, 5, 8]) {
  test(`retry ${retry}`, { retry }, fail)
}

describe('suite override', { retry: 5 }, () => {
  test('failure', fail)
})

test('object override', { retry: { count: 2, condition: /test failed/ } }, fail)

let attempts = 0
test('eventual override', { retry: 5 }, () => {
  if (++attempts < 3) fail()
})
