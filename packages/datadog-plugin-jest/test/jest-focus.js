describe('jest-test-focused', () => {
  it('will be skipped', () => {
    expect(true).toEqual(true)
  })
  it.only('can do focused test', () => {
    expect(true).toEqual(true)
  })
})

describe('jest-test-focused-2', () => {
  it('will be skipped too', () => {
    expect(true).toEqual(true)
  })
})
