describe('jest-test-parameterized', () => {
  it.each([[1, 2, 3], [2, 3, 5]])('can do parameterized test', (a, b, expected) => {
    expect(a + b).toEqual(expected)
  })
})
