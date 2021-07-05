describe('jest-test-suite promises', () => {
  it('passes', () => {
    return new Promise((resolve) =>
      setTimeout(() => {
        expect(100).toEqual(100)
        resolve()
      }, 100)
    )
  })
  it('fails', () => {
    return new Promise((resolve) =>
      setTimeout(() => {
        expect(100).toEqual(200)
        resolve()
      }, 100)
    )
  })
  it('timeout', () => {
    return new Promise((resolve) =>
      setTimeout(() => {
        expect(100).toEqual(100)
        resolve()
      }, 6000)
    )
  })
})
