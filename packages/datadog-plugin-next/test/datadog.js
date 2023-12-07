module.exports = require('../../..').init({
  service: 'test',
  flushInterval: 0,
  plugins: false
}).use('next', Number(process.env.WITH_CONFIG) ? {
  validateStatus: code => false,
  hooks: {
    request: (span, req, res) => {
      // convert error
      const statusCode = res.statusCode
      if ((statusCode < 200 || statusCode > 299) && statusCode !== 304) {
        span.setTag('resource.name', `GET /${statusCode}`)
      }

      // to count the number of times this hook has run between all processes
      const times = Number(process.env.TIMES_HOOK_CALLED) + 1
      process.env.TIMES_HOOK_CALLED = times + 1
      span.setTag('times_hook_called', String(times))

      span.setTag('req', req.constructor.name)
      span.setTag('foo', 'bar')
    }
  }
} : true).use('http')
