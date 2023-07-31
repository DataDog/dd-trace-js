module.exports = require('../../..').init({
  service: 'test',
  flushInterval: 0,
  plugins: false
}).use('next', process.env.WITH_CONFIG ? {
  validateStatus: code => false,
  hooks: {
    request: (span) => {
      span.setTag('foo', 'bar')
    }
  }
} : true)
