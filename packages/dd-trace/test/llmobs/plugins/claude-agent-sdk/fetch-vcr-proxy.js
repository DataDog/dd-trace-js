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

const NORMALIZE_FIELDS = ['messages', 'metadata', 'context_management']
const origFetch = globalThis.fetch

globalThis.fetch = function patchedFetch (input, init) {
  let url
  if (typeof input === 'string') url = input
  else if (input instanceof URL) url = input.href
  else if (input && typeof input === 'object' && input.url) url = input.url

  if (url && url.includes('/v1/messages')) {
    const newUrl = url.replace(/https?:\/\/[^/]+/, VCR_URL)

    let newInit = init
    if (init && init.body) {
      try {
        const body = JSON.parse(init.body)
        for (const field of NORMALIZE_FIELDS) {
          if (field in body) body[field] = '<normalized>'
        }
        newInit = { ...init, body: JSON.stringify(body) }
      } catch {}
    }

    if (typeof input === 'string') {
      return origFetch(newUrl, newInit)
    }
    return input.text().then(bodyText => {
      let normalizedBody = bodyText
      try {
        const body = JSON.parse(bodyText)
        for (const field of NORMALIZE_FIELDS) {
          if (field in body) body[field] = '<normalized>'
        }
        normalizedBody = JSON.stringify(body)
      } catch {}
      return origFetch(newUrl, {
        method: input.method,
        headers: Object.fromEntries(input.headers.entries()),
        body: normalizedBody,
        signal: input.signal,
      })
    })
  }

  return origFetch.apply(this, arguments)
}
