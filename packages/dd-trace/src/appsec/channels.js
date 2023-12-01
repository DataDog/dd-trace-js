'use strict'

const dc = require('dc-polyfill')

// TODO: use TBD naming convention
module.exports = {
  bodyParser: dc.channel('datadog:body-parser:read:finish'),
  cookieParser: dc.channel('datadog:cookie-parser:read:finish'),
  startGraphqlResolve: dc.channel('apm:graphql:resolve:start'),
  startGraphqlMiddleware: dc.channel('datadog:apollo:middleware:start'),
  endGraphqlMiddleware: dc.channel('datadog:apollo:middleware:end'),
  startExecuteHTTPGraphQLRequest: dc.channel('datadog:apollo:request:start'),
  startGraphqlWrite: dc.channel('datadog:apollo:request:success'),
  incomingHttpRequestStart: dc.channel('dd-trace:incomingHttpRequestStart'),
  incomingHttpRequestEnd: dc.channel('dd-trace:incomingHttpRequestEnd'),
  passportVerify: dc.channel('datadog:passport:verify:finish'),
  queryParser: dc.channel('datadog:query:read:finish'),
  setCookieChannel: dc.channel('datadog:iast:set-cookie'),
  nextBodyParsed: dc.channel('apm:next:body-parsed'),
  nextQueryParsed: dc.channel('apm:next:query-parsed')
}
