describe('jest-test-suite async', () => {
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
})
