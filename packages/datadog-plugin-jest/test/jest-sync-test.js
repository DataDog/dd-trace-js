describe('jest-test-suite', () => {
  it('passes', () => {
    expect(true).toEqual(true)
  })
  it('fails', () => {
    expect(true).toEqual(false)
  })
  it.skip('skips', () => {
    expect(100).toEqual(100)
  })
  test.skip('skips with test too', () => {
    expect(100).toEqual(100)
  })
})
