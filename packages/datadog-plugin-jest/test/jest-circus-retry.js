describe('jest-circus-test-retry', () => {
  // eslint-disable-next-line
  jest.retryTimes(2)
  let retryAttempt = 0
  it('can retry', () => {
    expect(retryAttempt++).toEqual(2)
  })
})
