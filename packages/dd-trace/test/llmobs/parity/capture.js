'use strict'

const fs = require('node:fs')
const http = require('node:http')
const { execFile } = require('node:child_process')
const path = require('node:path')
const { promisify } = require('node:util')

const { startStubProvider } = require('./stub-provider')

const execFileAsync = promisify(execFile)
const ROOT = path.resolve(__dirname, '../../../../../')
const CAPTURES_DIR = path.join(__dirname, 'captures')
const AGENT_URL = process.env.PARITY_AGENT_URL ?? 'http://127.0.0.1:9126'

function request (method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const req = http.request(target, { method, headers }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed
        try { parsed = JSON.parse(text) } catch { parsed = text }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

function findValues (value, key, result = []) {
  if (!value || typeof value !== 'object') return result
  if (Array.isArray(value)) {
    for (const item of value) findValues(item, key, result)
    return result
  }
  if (Object.hasOwn(value, key) && Array.isArray(value[key])) result.push(...value[key])
  for (const child of Object.values(value)) findValues(child, key, result)
  return result
}

function decodeBody (value) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string') return undefined
  const candidates = [value]
  try { candidates.push(Buffer.from(value, 'base64').toString('utf8')) } catch {}
  for (const candidate of candidates) {
    try { return JSON.parse(candidate) } catch {}
  }
  return undefined
}

function isLlmObsRequest (requestValue) {
  const text = JSON.stringify(requestValue).toLowerCase()
  return text.includes('llmobs') || text.includes('/api/v2/llmobs')
}

function extractSpans (requests) {
  const spans = []
  for (const requestValue of requests) {
    if (!isLlmObsRequest(requestValue)) continue
    const body = decodeBody(requestValue.body) ?? decodeBody(requestValue.data) ?? requestValue
    spans.push(...findValues(body, 'spans'))
  }
  return spans.flat()
}

async function fetchAgentRequests () {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await request('GET', `${AGENT_URL}/test/session/requests`)
      if (result.status >= 200 && result.status < 300) {
        const values = Array.isArray(result.body) ? result.body : result.body?.requests ?? result.body?.data ?? []
        return values.map(value => ({ ...value, body: decodeBody(value.body) ?? value.body }))
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  return []
}

async function startSession () {
  const token = `llmobs-parity-${Date.now()}-${Math.random().toString(16).slice(2)}`
  try {
    const result = await request('GET', `${AGENT_URL}/test/session/start?token=${encodeURIComponent(token)}`)
    if (result.status >= 200 && result.status < 300) {
      return result.body?.token ?? token
    }
  } catch {}
  return token
}

async function ensurePythonEnvironment () {
  const python = path.join(__dirname, '.parity-venv', 'bin', 'python')
  if (!fs.existsSync(python)) {
    const venv = path.join(__dirname, '.parity-venv')
    await execFileAsync(process.env.PYTHON ?? 'python', ['-m', 'venv', venv], { cwd: ROOT })
    await execFileAsync(python, [
      '-m', 'pip', 'install', '--disable-pip-version-check', 'ddtrace', 'openai', 'anthropic',
    ], { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 })
  }
  return python
}

function scenarioPath (sdk, integration, scenario) {
  return path.join(__dirname, 'scenarios', integration, `${scenario}.${sdk === 'js' ? 'js' : 'py'}`)
}

function fixturePath (integration, scenario) {
  return path.join(__dirname, 'fixtures', integration, `${scenario}.json`)
}

function capturePath (sdk, integration, scenario) {
  return path.join(CAPTURES_DIR, sdk, integration, `${scenario}.json`)
}

async function runScenario ({ sdk, integration, scenario }) {
  const fixture = JSON.parse(fs.readFileSync(fixturePath(integration, scenario), 'utf8'))
  const provider = await startStubProvider(fixture)
  const token = await startSession()
  const previousRequests = await fetchAgentRequests()
  const env = {
    ...process.env,
    PROVIDER_BASE_URL: `http://127.0.0.1:${provider.port()}`,
    DD_TRACE_AGENT_URL: AGENT_URL,
    DD_LLMOBS_ENABLED: '1',
    DD_LLMOBS_ML_APP: 'parity',
    DD_LLMOBS_AGENTLESS_ENABLED: '0',
    DD_TRACE_AGENT_FLUSH_AFTER_EACH_TRACE: 'true',
    _DD_LLMOBS_FLUSH_INTERVAL: '0',
    OPENAI_API_KEY: 'test-api-key',
    ANTHROPIC_API_KEY: 'test-api-key',
    DD_TEST_SESSION_TOKEN: token,
    PYTHONPATH: path.join(__dirname, 'scenarios'),
  }
  const script = scenarioPath(sdk, integration, scenario)
  const python = sdk === 'py' ? await ensurePythonEnvironment() : undefined
  const command = sdk === 'js'
    ? [process.execPath, [script]]
    : [python, [script]]

  try {
    await execFileAsync(command[0], command[1], { cwd: ROOT, env, maxBuffer: 10 * 1024 * 1024 })
  } finally {
    await new Promise(resolve => setTimeout(resolve, 250))
    await provider.close()
  }

  const requests = (await fetchAgentRequests()).slice(previousRequests.length)
  const spans = extractSpans(requests)
  const sdkVersion = sdk === 'js'
    ? require(path.join(ROOT, 'package.json')).version
    : (await execFileAsync(command[0], ['-c', 'import ddtrace; print(ddtrace.__version__)'], { env })).stdout.trim()
  const capture = { sdk_version: sdkVersion, spans }
  const output = capturePath(sdk, integration, scenario)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, `${JSON.stringify(capture, null, 2)}\n`)
  process.stdout.write(`${sdk}/${integration}/${scenario}: captured ${spans.length} spans\n`)
  return capture
}

async function capture ({ sdk, integration, scenario }) {
  if (!sdk || !integration || !scenario) throw new Error('capture requires --sdk, --integration, and --scenario')
  return runScenario({ sdk, integration, scenario })
}

module.exports = { capture, capturePath, runScenario }
