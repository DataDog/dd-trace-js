/* eslint-disable */
jest.setTimeout(100)
describe('ci visibility', () => {
  it('will timeout', (done) => {
    setTimeout(() => {
      done()
    }, 200)
  })
})
