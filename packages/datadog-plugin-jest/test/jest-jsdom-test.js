describe('jest-jsdom-test', () => {
  it('will run with jsdom', () => {
    expect(window).not.toEqual(undefined)
  })
})
