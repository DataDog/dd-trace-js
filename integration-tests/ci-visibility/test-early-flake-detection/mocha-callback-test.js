'use strict'

const assert = require('node:assert/strict')
const http = require('node:http')

describe('efd callback tests', () => {
  it('closes server with done callback', function (done) {
    const server = http.createServer((req, res) => {
      res.end('ok')
    })

    server.listen(0, function () {
      assert.strictEqual(server.listening, true)
      server.close(done)
    })
  })
})
