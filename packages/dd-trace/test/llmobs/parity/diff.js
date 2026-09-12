'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { capturePath } = require('./capture')
const { normalizeCapture } = require('./normalize')

const ALLOWLIST_PATH = path.join(__dirname, 'allowlist.json')

function allowlistFor (integration, scenario) {
  const allowlist = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'))
  return allowlist[`${integration}/${scenario}`] ?? []
}

function allowed (pathValue, entries) {
  return entries.some(entry => (typeof entry === 'string' ? entry : entry.path) === pathValue)
}

function spanKind (span) {
  return span.meta?.span?.kind ?? span.meta?.['span.kind']
}

function compare (left, right, pathValue, output, entries) {
  if (Object.is(left, right)) return
  if (pathValue.endsWith('.tags')) {
    const py = new Set(left ?? [])
    const js = new Set(right ?? [])
    const onlyInPy = [...py].filter(tag => !js.has(tag)).sort()
    const onlyInJs = [...js].filter(tag => !py.has(tag)).sort()
    if ((onlyInPy.length || onlyInJs.length) && !allowed(pathValue, entries)) {
      output.push({ path: pathValue, py: onlyInPy, js: onlyInJs })
    }
    return
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    if (Array.isArray(left) !== Array.isArray(right)) {
      if (!allowed(pathValue, entries)) output.push({ path: pathValue, py: left, js: right })
      return
    }
    const keys = new Set([...Object.keys(left), ...Object.keys(right)].sort())
    for (const key of keys) {
      const childPath = pathValue ? `${pathValue}.${key}` : key
      if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) {
        if (!allowed(childPath, entries)) output.push({ path: childPath, py: left[key], js: right[key] })
      } else {
        compare(left[key], right[key], childPath, output, entries)
      }
    }
    return
  }
  if (!allowed(pathValue, entries)) output.push({ path: pathValue, py: left, js: right })
}

function diffCaptures (integration, scenario) {
  const pyPath = capturePath('py', integration, scenario)
  const jsPath = capturePath('js', integration, scenario)
  if (!fs.existsSync(pyPath) || !fs.existsSync(jsPath)) {
    return {
      integration,
      scenario,
      matched: false,
      divergences: [],
      missing_in_js: [],
      missing_in_py: [],
      not_captured: true,
    }
  }
  const py = normalizeCapture(JSON.parse(fs.readFileSync(pyPath, 'utf8')))
  const js = normalizeCapture(JSON.parse(fs.readFileSync(jsPath, 'utf8')))
  const entries = allowlistFor(integration, scenario)
  const pyByKey = new Map()
  const jsByKey = new Map()
  for (const [index, span] of py.spans.entries()) pyByKey.set(`${index}:${spanKind(span)}`, span)
  for (const [index, span] of js.spans.entries()) jsByKey.set(`${index}:${spanKind(span)}`, span)
  const divergences = []
  const missingInJs = []
  const missingInPy = []
  for (const key of new Set([...pyByKey.keys(), ...jsByKey.keys()])) {
    if (!jsByKey.has(key)) missingInJs.push(key)
    else if (!pyByKey.has(key)) missingInPy.push(key)
    else compare(pyByKey.get(key), jsByKey.get(key), key, divergences, entries)
  }
  return {
    integration,
    scenario,
    matched: divergences.length === 0 && missingInJs.length === 0 && missingInPy.length === 0,
    divergences,
    missing_in_js: missingInJs,
    missing_in_py: missingInPy,
    not_captured: false,
  }
}

function diffAll (integration, scenario) {
  const integrations = integration ? [integration] : fs.readdirSync(path.join(__dirname, 'fixtures'))
  const results = []
  for (const currentIntegration of integrations) {
    const scenarios = scenario
      ? [scenario]
      : fs.readdirSync(path.join(__dirname, 'fixtures', currentIntegration))
        .filter(file => file.endsWith('.json')).map(file => file.slice(0, -5))
    for (const currentScenario of scenarios) results.push(diffCaptures(currentIntegration, currentScenario))
  }
  return results
}

module.exports = { diffAll, diffCaptures }
