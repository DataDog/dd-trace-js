'use strict'
const { getContext } = require('../gateway/engine')
const Addresses = require('./addresses')

function resolveHTTPAddresses () {
  const context = getContext()

  const path = context.resolve(Addresses.HTTP_INCOMING_URL)
  const headers = context.resolve(Addresses.HTTP_INCOMING_HEADERS)

  const url = new URL(path, `http://${headers.host}`)

  return {
    // scheme: context.resolve(Addresses.),
    method: context.resolve(Addresses.HTTP_INCOMING_METHOD),
    url: url.href,
    host: url.hostname,
    port: url.port, // context.resolve(Addresses.HTTP_INCOMING_PORT),
    path: url.pathname,
    // route: context.resolve(Addresses.),
    remote_ip: context.resolve(Addresses.HTTP_INCOMING_REMOTE_IP),
    remote_port: context.resolve(Addresses.HTTP_INCOMING_REMOTE_PORT),
    // responseCode: context.resolve(Addresses.),
    headers
  }
}

const HEADERS_TO_SEND = [
  'user-agent',
  'referer',
  'x-forwarded-for',
  'x-real-ip',
  'client-ip',
  'x-forwarded',
  'x-cluster-client-ip',
  'forwarded-for',
  'forwarded',
  'via'
]

function getHeadersToSend (headers) {
  const result = {}

  for (let i = 0; i < HEADERS_TO_SEND.length; ++i) {
    const headerName = HEADERS_TO_SEND[i]

    if (headers[headerName]) {
      result[headerName] = headers[headerName]
    }
  }

  return result
}

function formatAttack ({
  ruleId,
  ruleName,
  ruleTags,
  matchOperator,
  matchOperatorValue,
  matchParameters,
  matchHighlight
}) {
  return {
    rule: {
      id: ruleId,
      name: ruleName,
      tags: ruleTags
    },
    rule_match: {
      operator: matchOperator,
      operator_value: matchOperatorValue,
      parameters: matchParameters,
      highlight: matchHighlight
    }
  }
}

module.exports = {
  formatAttack
}
