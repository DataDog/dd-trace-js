const crypto = require('crypto')
const app = require('express')()

for (let i = 0; i < 100; i++) {
  app.get(`/${crypto.randomBytes(8).toString('hex')}`, (req, res) => res.end(''))
}

app.get('/hello', (req, res) => res.end('hello world'))
app.listen(3000)
