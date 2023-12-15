'use strict'

const dc = require('dc-polyfill')
const { channel } = require('../../../datadog-instrumentations/src/helpers/instrument')

// TODO: use TBD naming convention
module.exports = {
  bodyParser: dc.channel('datadog:body-parser:read:finish'),
  cookieParser: dc.channel('datadog:cookie-parser:read:finish'),
  startGraphqlResolve: dc.channel('datadog:graphql:resolver:start'),
  graphqlMiddlewareChannel: dc.tracingChannel('datadog:apollo:middleware'),
  startExecuteHTTPGraphQLRequest: dc.channel('datadog:apollo:request:start'),
  startGraphqlWrite: dc.channel('datadog:apollo:request:success'),
  startApolloServerCoreRequest: channel('datadog:apollo-server-core:request:start'),
  successApolloServerCoreRequest: channel('datadog:apollo-server-core:request:success'),
  incomingHttpRequestStart: dc.channel('dd-trace:incomingHttpRequestStart'),
  incomingHttpRequestEnd: dc.channel('dd-trace:incomingHttpRequestEnd'),
  passportVerify: dc.channel('datadog:passport:verify:finish'),
  queryParser: dc.channel('datadog:query:read:finish'),
  setCookieChannel: dc.channel('datadog:iast:set-cookie'),
  nextBodyParsed: dc.channel('apm:next:body-parsed'),
  nextQueryParsed: dc.channel('apm:next:query-parsed')
}
