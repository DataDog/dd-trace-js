const http = require('http')

describe('jest-test-integration-http', () => {
  it('can do integration http', (done) => {
    const req = http.request('http://test:123', (res) => {
      expect(res.statusCode).toEqual(200)
      done()
    })
    req.end()
  })
})
