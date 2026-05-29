'use strict'

const { obfuscateQs, calculateHttpEndpoint } = require('../../../packages/dd-trace/src/plugins/util/url')

const COUNT = Number(process.env.COUNT)

// The shipped default query-string obfuscation regex. Both functions run once
// per inbound HTTP server request: calculateHttpEndpoint normalizes the path
// for endpoint aggregation, obfuscateQs redacts secrets from the query string.
const qsRegex = new RegExp(
  '(?:p(?:ass)?w(?:or)?d|pass(?:_?phrase)?|secret|(?:api_?|private_?|public_?|access_?|secret_?)key(?:_?id)?|' +
  'token|consumer_?(?:id|key|secret)|sign(?:ed|ature)?|auth(?:entication|orization)?)' +
  '(?:(?:\\s|%20)*(?:=|%3D)[^&]+)|bearer(?:\\s|%20)+[a-z0-9\\._\\-]+|token(?::|%3A)[a-z0-9]{13}|' +
  'gh[opsu]_[0-9a-zA-Z]{36}',
  'gi'
)
const config = { queryStringObfuscation: qsRegex }

// Representative inbound URLs: REST paths with int and hex ids, query strings
// with and without secrets, and a short static path.
const urls = [
  'http://example.com/api/v2/users/12345/orders?token=abc123def456&page=2',
  'http://example.com/api/v2/products/list?category=books&sort=price',
  'http://example.com/health',
  'http://example.com/api/v2/users/9f8e7d6c5b4a/profile?password=hunter2',
]

let sink = 0
for (let i = 0; i < COUNT; i++) {
  const url = urls[i & 3]
  sink += calculateHttpEndpoint(url).length
  sink += obfuscateQs(config, url).length
}

if (sink === 0) throw new Error('unreachable')
