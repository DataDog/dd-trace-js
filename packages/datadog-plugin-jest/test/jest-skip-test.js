describe('jest-skip-test', () => {
  it.skip('will skip', () => {
    expect(100).toEqual(100)
  })
  test.skip('will skip with test too', () => {
    expect(100).toEqual(100)
  })
  it('will run', () => {
    expect(100).toEqual(100)
  })
})
