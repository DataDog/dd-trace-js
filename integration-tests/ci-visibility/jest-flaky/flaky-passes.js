let counter = 0

describe('test-flaky-test-retries', () => {
  it('can retry flaky tests', () => {
    // eslint-disable-next-line
    expect(++counter).toEqual(3)
  })

  it('will not retry passed tests', () => {
    // eslint-disable-next-line
    expect(3).toEqual(3)
  })
})
