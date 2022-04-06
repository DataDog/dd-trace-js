describe('jest-test-suite', () => {
  // eslint-disable-next-line
  jest.setTimeout(200)
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
  it('passes', () => {
    expect(true).toEqual(true)
  })
  it('fails', () => {
    expect(true).toEqual(false)
  })
  it('does not crash with missing stack', (done) => {
    setTimeout(() => {
      const error = new Error('fail')
      delete error.stack
      throw error
    }, 100)
  })
  it.skip('skips', () => {
    expect(100).toEqual(100)
  })
  it.todo('skips todo')
})
