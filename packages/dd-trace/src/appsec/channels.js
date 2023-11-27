'use strict'

const dc = require('dc-polyfill')

// TODO: use TBD naming convention
module.exports = {
  bodyParser: dc.channel('datadog:body-parser:read:finish'),
  cookieParser: dc.channel('datadog:cookie-parser:read:finish'),
  graphqlStartResolve: dc.channel('apm:graphql:resolve:start'),
  graphqlFinishExecute: dc.channel('apm:graphql:execute:finish'),
  startGraphqlMiddleware: dc.channel('datadog:apollo:middleware:start'),
  endGraphqlMiddleware: dc.channel('datadog:apollo:middleware:end'),
  startExecuteHTTPGraphQLRequest: dc.channel('datadog:apollo:request:start'),
  startGraphqlWrite: dc.channel('datadog:apollo:response-write:start'),
  startRunHttpQuery: dc.channel('datadog:apollo-core:runhttpquery:start'),
  successRunHttpQuery: dc.channel('datadog:apollo-core:runhttpquery:success'),
  incomingHttpRequestStart: dc.channel('dd-trace:incomingHttpRequestStart'),
  incomingHttpRequestEnd: dc.channel('dd-trace:incomingHttpRequestEnd'),
  passportVerify: dc.channel('datadog:passport:verify:finish'),
  queryParser: dc.channel('datadog:query:read:finish'),
  setCookieChannel: dc.channel('datadog:iast:set-cookie'),
  nextBodyParsed: dc.channel('apm:next:body-parsed'),
  nextQueryParsed: dc.channel('apm:next:query-parsed')
}
