'use strict'

// eslint-disable-next-line no-console
console.log(JSON.stringify({
  DD_SERVICE: process.env.DD_SERVICE,
  DD_ENV: process.env.DD_ENV,
  DD_TRACE_SAMPLE_RATE: process.env.DD_TRACE_SAMPLE_RATE,
  MY_APP_VAR: process.env.MY_APP_VAR,
}))
process.exit()
