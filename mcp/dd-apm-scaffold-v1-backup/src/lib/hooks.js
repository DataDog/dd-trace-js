'use strict'

const fs = require('fs-extra')

async function updateHooksRegistry (hooksPath, integrationId, moduleNames) {
  const relRequire = `../${integrationId}`
  const src = await fs.readFile(hooksPath, 'utf8')

  const objStart = src.indexOf('module.exports = {')
  if (objStart === -1) return

  // find the closing brace that matches the opening after 'module.exports = {'
  let i = objStart + 'module.exports = {'.length
  let depth = 1
  while (i < src.length && depth > 0) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    i++
  }
  const objEnd = i - 1
  if (objEnd <= objStart) return

  const before = src.slice(0, objStart)
  const inner = src.slice(objStart + 'module.exports = {'.length, objEnd)
  const after = src.slice(objEnd)

  const lines = inner.split('\n')

  const keyInfo = (line) => {
    const m = line.match(/^(\s*)([^:]+):\s*(.+?)(,?)\s*$/)
    if (!m) return null
    const leading = m[1]
    const rawKey = m[2].trim()
    const value = m[3]
    const trailingComma = m[4]
    const normalized = rawKey.replace(/^["']|["']$/g, '')
    return { leading, rawKey, value, trailingComma, normalized }
  }

  const needsQuoting = (name) => !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)

  const makeLineForName = (name) => {
    const keyToken = needsQuoting(name) ? `'${name}'` : name
    return `  ${keyToken}: () => require('${relRequire}'),`
  }

  let updated = false
  for (const name of moduleNames) {
    // already present?
    const exists = lines.some(l => {
      const ki = keyInfo(l.trim())
      return ki && ki.normalized === name
    })
    if (exists) continue

    // determine insertion index based on normalized key comparison (case-insensitive)
    const target = name.toLowerCase()
    let insertIdx = -1
    for (let idx = 0; idx < lines.length; idx++) {
      const ki = keyInfo(lines[idx].trim())
      if (!ki) continue
      if (ki.normalized.toLowerCase() > target) { insertIdx = idx; break }
    }
    const newLine = makeLineForName(name)
    if (insertIdx === -1) lines.push(newLine)
    else lines.splice(insertIdx, 0, newLine)
    updated = true
  }

  if (updated) {
    const out = before + 'module.exports = {' + lines.join('\n') + after
    await fs.writeFile(hooksPath, out)
  }
}

module.exports = { updateHooksRegistry }
