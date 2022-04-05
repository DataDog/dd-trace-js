describe('jest-circus-hook-failure', () => {
  beforeEach(() => {
    throw new Error('hey')
  })
  it('will not run', () => {
    expect(true).toEqual(true)
  })
})

describe('jest-circus-hook-failure-after', () => {
  afterEach(() => {
    throw new Error('hey')
  })
  it('will not run', () => {
    expect(true).toEqual(true)
  })
})
