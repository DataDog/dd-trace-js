'use strict'

// Injected into the Claude Agent SDK's CLI subprocess via NODE_OPTIONS=--require.
// It redirects Anthropic message calls to the local VCR proxy and normalizes the
// body so one cassette can replay deterministic Claude responses across runs.

const VCR_URL = process.env._VCR_PROXY_URL
if (!VCR_URL) return

const CANONICAL_BODY = '{"_":"normalized"}'
const origFetch = globalThis.fetch

globalThis.fetch = function patchedFetch (input, init) {
  let url
  if (typeof input === 'string') url = input
  else if (input instanceof URL) url = input.href
  else if (input && typeof input === 'object' && input.url) url = input.url

  if (url && url.includes('/v1/messages')) {
    const newUrl = url.startsWith(VCR_URL) ? url : url.replace(/https?:\/\/[^/]+/, VCR_URL)

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
