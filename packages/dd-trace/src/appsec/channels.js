'use strict'

const dc = require('dc-polyfill')

// TODO: use TBD naming convention
module.exports = {
  bodyParser: dc.channel('datadog:body-parser:read:finish'),
  cookieParser: dc.channel('datadog:cookie-parser:read:finish'),
  startGraphqlResolve: dc.channel('datadog:graphql:resolver:start'),
  graphqlMiddlewareChannel: dc.tracingChannel('datadog:apollo:middleware'),
  apolloChannel: dc.tracingChannel('datadog:apollo:request'),
  apolloServerCoreChannel: dc.tracingChannel('datadog:apollo-server-core:request'),
  incomingHttpRequestStart: dc.channel('dd-trace:incomingHttpRequestStart'),
  incomingHttpRequestEnd: dc.channel('dd-trace:incomingHttpRequestEnd'),
  passportVerify: dc.channel('datadog:passport:verify:finish'),
  queryParser: dc.channel('datadog:query:read:finish'),
  setCookieChannel: dc.channel('datadog:iast:set-cookie'),
  nextBodyParsed: dc.channel('apm:next:body-parsed'),
  nextQueryParsed: dc.channel('apm:next:query-parsed'),
  responseBody: dc.channel('datadog:express:response:json:start'),
  responseWriteHead: dc.channel('apm:http:server:response:writeHead:start'),
  httpClientRequestStart: dc.channel('apm:http:client:request:start')
}
