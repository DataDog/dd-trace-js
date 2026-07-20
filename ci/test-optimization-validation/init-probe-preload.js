'use strict'

/* eslint-disable eslint-rules/eslint-process-env */

const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')

const { sanitizeForReport } = require('./redaction')

const PROBE_FILE_ENV = 'DD_TEST_OPTIMIZATION_INIT_PROBE_FILE'
const probeFile = process.env[PROBE_FILE_ENV]
const seenModuleLoads = new Set()

if (probeFile) {
  writeRecord('process-start', {
    argv: process.argv,
    cwd: process.cwd(),
    detectedTools: detectTools(process.argv),
    execArgv: process.execArgv,
    nodeOptionsPresent: Boolean(process.env.NODE_OPTIONS),
    pid: process.pid,
    ppid: process.ppid,
  })

  const originalLoad = Module._load
  Module._load = function loadWithProbe (request, parent, isMain) {
    const loaded = originalLoad.apply(this, arguments)
    const tool = detectTool(request) || detectTool(resolveFromParent(request, parent))

    if (tool) {
      const key = `${process.pid}:${request}:${tool.name}`
      if (!seenModuleLoads.has(key)) {
        seenModuleLoads.add(key)
        writeRecord('module-load', {
          argv: process.argv,
          cwd: process.cwd(),
          isMain: Boolean(isMain),
          parentFilename: parent && parent.filename,
          pid: process.pid,
          ppid: process.ppid,
          request,
          tool,
        })
      }
    }

    return loaded
  }
}

function resolveFromParent (request, parent) {
  try {
    return Module._resolveFilename(request, parent)
  } catch {
    return ''
  }
}

function detectTools (values) {
  const tools = []
  const seen = new Set()

  for (const value of values) {
    const tool = detectTool(value)
    if (!tool || seen.has(tool.name)) continue
    seen.add(tool.name)
    tools.push(tool)
  }

  return tools
}

function detectTool (value) {
  if (typeof value !== 'string' || value.length === 0) return null

  const normalized = value.split(path.sep).join('/').toLowerCase()

  if (/(^|\/)(jest|jest\.js)$/.test(normalized) ||
    /\/(?:jest|jest-cli|@jest\/core)\//.test(normalized) ||
    normalized === 'jest' ||
    normalized === 'jest-cli' ||
    normalized === '@jest/core') {
    return { name: 'jest', kind: 'test-runner' }
  }

  if (/(^|\/)(vitest|vitest\.mjs)$/.test(normalized) ||
    /\/(?:vitest|@vitest\/runner)\//.test(normalized) ||
    normalized === 'vitest' ||
    normalized === '@vitest/runner') {
    return { name: 'vitest', kind: 'test-runner' }
  }

  if (/(^|\/)(mocha|mocha\.js|_mocha)$/.test(normalized) ||
    /\/mocha\//.test(normalized) ||
    normalized === 'mocha') {
    return { name: 'mocha', kind: 'test-runner' }
  }

  if (/\/@cucumber\/cucumber\//.test(normalized) ||
    normalized === '@cucumber/cucumber' ||
    normalized === 'cucumber' ||
    normalized === 'cucumber-js') {
    return { name: 'cucumber', kind: 'test-runner' }
  }

  if (/(^|\/)playwright(?:\.js)?$/.test(normalized) ||
    /\/(?:@playwright\/test|playwright)\//.test(normalized) ||
    normalized === '@playwright/test' ||
    normalized === 'playwright' ||
    normalized === 'playwright/test') {
    return { name: 'playwright', kind: 'test-runner' }
  }

  if (/(^|\/)cypress(?:\.js)?$/.test(normalized) || /\/cypress\//.test(normalized) || normalized === 'cypress') {
    return { name: 'cypress', kind: 'test-runner' }
  }

  if (/(^|\/)(nx|nx\.js)$/.test(normalized) || /\/nx\//.test(normalized) || normalized === 'nx') {
    return { name: 'nx', kind: 'wrapper' }
  }

  if (/(^|\/)(turbo|turbo\.js)$/.test(normalized) || /\/turbo\//.test(normalized) || normalized === 'turbo') {
    return { name: 'turbo', kind: 'wrapper' }
  }

  if (/(^|\/)(lage|lage\.js)$/.test(normalized) || /\/lage\//.test(normalized) || normalized === 'lage') {
    return { name: 'lage', kind: 'wrapper' }
  }

  if (/(^|\/)(pnpm|pnpm\.cjs)$/.test(normalized) || /\/pnpm\//.test(normalized) || normalized === 'pnpm') {
    return { name: 'pnpm', kind: 'package-manager' }
  }

  if (/(^|\/)(npm|npm-cli\.js)$/.test(normalized) || /\/npm\//.test(normalized) || normalized === 'npm') {
    return { name: 'npm', kind: 'package-manager' }
  }

  if (/(^|\/)(yarn|yarn\.js)$/.test(normalized) || /\/yarn\//.test(normalized) || normalized === 'yarn') {
    return { name: 'yarn', kind: 'package-manager' }
  }

  return null
}

function writeRecord (type, data) {
  try {
    const record = sanitizeForReport({
      type,
      time: new Date().toISOString(),
      ...data,
    })
    const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0)
    const file = fs.openSync(probeFile, flags)
    try {
      fs.writeFileSync(file, `${JSON.stringify(record)}\n`)
    } finally {
      fs.closeSync(file)
    }
  } catch {
    // The probe must never change test behavior.
  }
}
