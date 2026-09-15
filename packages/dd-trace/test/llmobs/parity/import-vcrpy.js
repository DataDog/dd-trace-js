'use strict'

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const yaml = require(path.resolve(__dirname, '../../../../../node_modules/js-yaml'))

function bodyBytes (body) {
  if (Buffer.isBuffer(body)) return body
  if (body && typeof body === 'object' && body.string !== undefined) return bodyBytes(body.string)
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const values = Object.values(body)
    if (values.every(value => Number.isInteger(value))) return Buffer.from(values)
  }
  return Buffer.from(String(body ?? ''), 'utf8')
}

function decodeBody (body, headers) {
  const bytes = bodyBytes(body)
  const contentEncoding = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === 'content-encoding')?.[1]
  const compressed = contentEncoding === 'gzip' || (bytes[0] === 0x1f && bytes[1] === 0x8b)
  if (compressed) {
    try {
      return zlib.gunzipSync(bytes).toString('utf8')
    } catch {
      return bytes.toString('utf8')
    }
  }
  return bytes.toString('utf8')
}

function headersObject (headers = {}) {
  return Object.fromEntries(Object.entries(headers)
    .filter(([key]) => !['content-encoding', 'content-length'].includes(key.toLowerCase()))
    .map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]))
}

function importCassette (cassettePath, outputPath, provider) {
  if (!provider) throw new Error('provider is required')
  const cassette = yaml.load(fs.readFileSync(cassettePath, 'utf8'))
  const responses = (cassette.interactions ?? []).map(interaction => {
    const request = interaction.request ?? {}
    const requestUrl = new URL(request.uri)
    const headers = headersObject(interaction.response?.headers)
    const body = decodeBody(interaction.response?.body, interaction.response?.headers)
    let requestBody
    try {
      requestBody = JSON.parse(request.body ?? '{}')
    } catch {}
    const stream = Boolean(requestBody?.stream) ||
      String(headers['content-type'] ?? '').includes('event-stream') ||
      body.startsWith('event:')
    return {
      match: { method: request.method ?? 'GET', path: requestUrl.pathname },
      status: interaction.response?.status?.code ?? 200,
      headers,
      body,
      stream,
    }
  })

  const fixture = { responses }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, `${JSON.stringify(fixture, null, 2)}\n`)
  process.stdout.write(`imported ${responses.length} interactions from ${cassettePath} to ${outputPath}\n`)
  return fixture
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const value = name => args[args.indexOf(name) + 1]
  const cassettePath = value('--cassette')
  const outputPath = value('--output')
  const provider = value('--provider')
  if (!cassettePath || !outputPath || !provider) {
    throw new Error('usage: node import-vcrpy.js --cassette FILE --output FILE --provider NAME')
  }
  importCassette(cassettePath, outputPath, provider)
}

module.exports = { importCassette }
