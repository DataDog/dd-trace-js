describe('jest-circus-test-suite', () => {
  // eslint-disable-next-line
  jest.setTimeout(200)
  it('passes', () => {
    expect(true).toEqual(true)
  })
  it('fails', () => {
    expect(true).toEqual(false)
  })
  it('done', (done) => {
    setTimeout(() => {
      expect(100).toEqual(100)
      done()
    }, 100)
  })
  it('done fail', (done) => {
    setTimeout(() => {
      try {
        expect(100).toEqual(200)
        done()
      } catch (e) {
        done(e)
      }
    }, 100)
  })
  it('done fail uncaught', (done) => {
    setTimeout(() => {
      expect(100).toEqual(200)
      done()
    }, 100)
  })
  it('promise passes', () => {
    return new Promise((resolve) =>
      setTimeout(() => {
        expect(100).toEqual(100)
        resolve()
      }, 100)
    )
  })
  it('promise fails', () => {
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
      }, 300)
    )
  })
  it.skip('skip', () => {
    expect(true).toEqual(true)
  })
  describe('retry', () => {
    // eslint-disable-next-line
    jest.retryTimes(2)
    let retryAttempt = 0
    it('can retry', () => {
      expect(retryAttempt++).toEqual(2)
    })
  })
})
