'use strict'

const path = require('path')
const { spawn } = require('child_process')

const CORE_METHOD_RE = /(connect|disconnect|sendCommand|execute|pipeline|multi|quit|destroy|publish|subscribe|unsubscribe|scanIterator)/i
const CORE_CLASS_RE = /(Client|Cluster|Sentinel)$/
const DROP_PATH_RE = /(cache\.js|parser\.js|RESP\/|errors\.js|commands\/|validator\.js|headers?\.js)/i

async function judgeWithLLM (pkgRoot, pkgName, targets, opts = {}) {
  const maxTotal = typeof opts.maxTotal === 'number' ? opts.maxTotal : 50
  const useLLM = !!opts.useLLM && !!process.env.OPENAI_API_KEY

  // Pre-filter obvious non-core by path
  const filtered = targets.filter(t => {
    if (!t || !t.file_path) return true
    const fp = String(t.file_path)
    return !DROP_PATH_RE.test(fp)
  })

  // Strong keep if matches core class or method
  const strongKeeps = []
  const others = []
  for (const t of filtered) {
    const isCoreMethod = CORE_METHOD_RE.test(t.function_name || '')
    const isCoreClass = CORE_CLASS_RE.test((t.export_name || '').split('.').pop() || '') || /^(default)$/i.test(t.export_name || '')
    if (isCoreClass && isCoreMethod) strongKeeps.push(t)
    else others.push(t)
  }

  // Sort by score and truncate
  strongKeeps.sort((a, b) => (b.confidence_score || 0) - (a.confidence_score || 0))

  let selected = [...strongKeeps]

  // Fill remaining slots by score but prefer items under core dirs
  if (selected.length < maxTotal) {
    others.sort((a, b) => (b.confidence_score || 0) - (a.confidence_score || 0))
    for (const t of others) {
      if (selected.length >= maxTotal) break
      const fp = String(t.file_path || '')
      const prefer = /(lib\/client\/index\.js|lib\/cluster\/index\.js|lib\/sentinel\/index\.js|lib\/application\.js|lib\/response\.js|lib\/request\.js)/.test(fp)
      if (prefer || (t.confidence_score || 0) >= 0.85) selected.push(t)
    }
  }

  // Optional: call LLM to rank/trim further
  if (useLLM) {
    try {
      const payload = buildLLMPrompt(pkgName, selected, maxTotal)
      const ranked = await callOpenAI(payload)
      if (Array.isArray(ranked) && ranked.length) {
        const key = t => `${t.module || pkgName}:${t.export_name}.${t.function_name}`
        const set = new Set(ranked)
        selected = selected.filter(t => set.has(key(t)))
      }
    } catch {
      // ignore LLM failure; keep heuristic selection
    }
  }

  return selected.slice(0, maxTotal)
}

function buildLLMPrompt (pkgName, selected, maxTotal) {
  const items = selected.map(t => ({
    module: t.module || pkgName,
    export: t.export_name,
    method: t.function_name,
    file: t.file_path,
    score: t.confidence_score,
    reason: t.reasoning
  }))
  const sys = 'You are an expert APM instrumentation engineer. Pick only core user-facing operations to trace.'
  const user = `Library: ${pkgName}\nPick up to ${maxTotal} most important API points to instrument. Return a JSON array of unique keys in the form "module:export.method".\nCandidates:\n${JSON.stringify(items, null, 2)}`
  return { system: sys, user }
}

async function callLLMViaPython (messages, model, maxTokens = 300, temperature = 0.2) {
  return new Promise((resolve, reject) => {
    const pythonScript = path.join(__dirname, 'llm_bridge.py')
    const python = spawn('python3', [pythonScript], {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    const input = JSON.stringify({
      messages,
      model,
      max_tokens: maxTokens,
      temperature
    })
    let output = ''
    let error = ''

    python.stdout.on('data', (data) => {
      output += data.toString()
    })

    python.stderr.on('data', (data) => {
      error += data.toString()
    })

    python.on('close', (code) => {
      if (code !== 0) {
        console.warn('Python LLM bridge failed:', error)
        resolve(null)
        return
      }

      try {
        const result = JSON.parse(output)
        if (result.success) {
          resolve(result.content)
        } else {
          console.warn('LLM call failed:', result.error)
          resolve(null)
        }
      } catch (parseError) {
        console.warn('Failed to parse LLM response:', parseError.message)
        resolve(null)
      }
    })

    python.stdin.write(input)
    python.stdin.end()
  })
}

async function callOpenAI (payload) {
  const messages = [
    { role: 'system', content: payload.system },
    { role: 'user', content: payload.user }
  ]
  const model = process.env.DD_APM_LLM_MODEL || 'gpt-4o-mini'

  // Use company AI gateway via Python bridge if configured
  if (process.env.DD_AI_GATEWAY) {
    const result = await callLLMViaPython(messages, model, 300, 0.2)
    return result
  }

  // Fallback to direct OpenAI for development
  const body = {
    model: model.replace('openai/', ''), // Remove provider prefix for direct OpenAI
    messages,
    temperature: 0.2,
    max_tokens: 300
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify(body)
  })
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`)
  const data = await res.json()
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return parsed
  } catch {}
  return []
}

module.exports = { judgeWithLLM }
