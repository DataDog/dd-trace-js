const http = require('http')

describe('mocha-test-integration-http', () => {
  it('can do integration http', (done) => {
    setTimeout(() => {
      const req = http.request('http://test:123', (res) => {
        expect(res.statusCode).to.equal(200)
        done()
      })
      req.end()
    }, 100)
  })
})
