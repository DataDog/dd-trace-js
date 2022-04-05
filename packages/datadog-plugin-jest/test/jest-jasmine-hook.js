describe('jest-test-suite-hook-failure', () => {
  beforeEach(() => {
    throw new Error('hey, hook error before')
  })
  it('will not run', () => {
    expect(true).toEqual(true)
  })
})

describe('jest-test-suite-hook-failure-after', () => {
  afterEach(() => {
    throw new Error('hey, hook error after')
  })
  it('will not run', () => {
    expect(true).toEqual(true)
  })
})
