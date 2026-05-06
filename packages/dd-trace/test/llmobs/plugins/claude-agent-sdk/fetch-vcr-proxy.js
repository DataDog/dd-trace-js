'use strict'

// Injected into the Claude Agent SDK's CLI subprocess via NODE_OPTIONS=--require.
// Patches globalThis.fetch to redirect /v1/messages API calls to the VCR test agent,
// normalizing variable fields (messages, metadata, context_management) in the request
// body so the VCR cassette hash is stable across runs.
//
// This runs ONLY in the subprocess spawned by spawnClaudeCodeProcess in tests.
// It does NOT affect the parent test process or other providers' tests.

const VCR_URL = process.env._VCR_PROXY_URL
if (!VCR_URL) return

// Replace the entire body with a fixed canonical payload so that every API
// call—regardless of SDK version, model, or per-request fields—hashes to
// the same VCR cassette. We only need one cassette for all test scenarios.
const CANONICAL_BODY = '{"_":"normalized"}'
const origFetch = globalThis.fetch

globalThis.fetch = function patchedFetch (input, init) {
  let url
  if (typeof input === 'string') url = input
  else if (input instanceof URL) url = input.href
  else if (input && typeof input === 'object' && input.url) url = input.url

  if (url && url.includes('/v1/messages')) {
    const newUrl = url.replace(/https?:\/\/[^/]+/, VCR_URL)

    if (typeof input === 'string') {
      return origFetch(newUrl, { ...init, body: CANONICAL_BODY })
    }
    return origFetch(newUrl, {
      method: input.method,
      headers: Object.fromEntries(input.headers.entries()),
      body: CANONICAL_BODY,
      signal: input.signal,
    })
  }

  return origFetch.apply(this, arguments)
}
