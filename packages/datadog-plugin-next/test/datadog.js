const { readFileSync, writeFileSync, existsSync } = require('fs')
const FILENAME = `${__dirname}/test.txt`

module.exports = require('../../..').init({
  service: 'test',
  flushInterval: 0,
  plugins: false
}).use('next', process.env.WITH_CONFIG ? {
  validateStatus: code => false,
  hooks: {
    request: (span, req) => {
      // to count the number of times this hook has run between all processes
      if (existsSync(FILENAME)) {
        let times = readFileSync(FILENAME)
        times = Number(times.toString()) + 1
        writeFileSync(FILENAME, String(times))
      }

      span.setTag('req', req.constructor.name)
      span.setTag('foo', 'bar')
    }
  }
} : true).use('http')
