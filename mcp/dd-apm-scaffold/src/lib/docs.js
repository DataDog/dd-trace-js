'use strict'

const fs = require('fs-extra')

async function updateDocsAndTypes (repoRoot, ids) {
  const { integrationId, typesId } = ids
  const apiFile = require('path').join(repoRoot, 'docs', 'API.md')
  if (await fs.pathExists(apiFile)) {
    let api = await fs.readFile(apiFile, 'utf8')
    const lines = api.split('\n')
    const anchorLine = `<h5 id="${integrationId}"></h5>`
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ')
    if (!api.includes(anchorLine)) {
      const listHdrIdx = lines.findIndex(l => l.includes('<h3 id="integrations-list">'))
      const firstAnchorIdx = lines.findIndex(l => /^<h5 id="[^"]+"><\/h5>$/.test(l))
      if (firstAnchorIdx !== -1 && (listHdrIdx === -1 || firstAnchorIdx < listHdrIdx)) {
        let endIdx = firstAnchorIdx
        while (endIdx < lines.length && /^<h5 id="[^"]+"><\/h5>$/.test(lines[endIdx])) endIdx++
        let insertIdx = endIdx
        for (let i = firstAnchorIdx; i < endIdx; i++) {
          const m = lines[i].match(/^<h5 id="([^"]+)"><\/h5>$/)
          if (!m) continue
          const id = m[1]
          if (/-tags$/.test(id) || /-config$/.test(id)) continue
          if (norm(id) > norm(integrationId)) { insertIdx = i; break }
        }
        lines.splice(insertIdx, 0, anchorLine)
        api = lines.join('\n')
      }
    }

    const linkLine = `* [${integrationId}](./interfaces/export_.plugins.${typesId}.html)`
    if (!api.includes(linkLine)) {
      const listStart = lines.findIndex(l => l.includes('<h3 id="integrations-list">'))
      if (listStart !== -1) {
        let i = listStart + 1
        while (i < lines.length && lines[i].trim() === '') i++
        const firstBullet = i
        while (i < lines.length && /^\* \[/.test(lines[i])) i++
        const endBullet = i
        if (firstBullet < endBullet) {
          let insertAt = endBullet
          for (let j = firstBullet; j < endBullet; j++) {
            const m = lines[j].match(/^\* \[([^\]]+)\]/)
            if (!m) continue
            if (norm(m[1]) > norm(integrationId)) { insertAt = j; break }
          }
          // avoid duplicates and mis-sorting: remove and re-insert within block
          const block = lines.slice(firstBullet, endBullet)
          if (!block.includes(linkLine)) block.push(linkLine)
          block.sort((a, b) => a.localeCompare(b))
          lines.splice(firstBullet, endBullet - firstBullet, ...block)
          api = lines.join('\n')
        }
      }
    }
    await fs.writeFile(apiFile, api)
  }

  const redirectsFile = require('path').join(repoRoot, 'docs', 'add-redirects.sh')
  if (await fs.pathExists(redirectsFile)) {
    let sh = await fs.readFile(redirectsFile, 'utf8')
    const startIdx = sh.indexOf('declare -a plugins=(')
    if (startIdx !== -1) {
      const endIdx = sh.indexOf(')', startIdx)
      if (endIdx !== -1) {
        const body = sh.slice(startIdx + 'declare -a plugins=('.length, endIdx)
        const items = body.split('\n').map(s => s.trim()).filter(Boolean).map(s => s.replace(/^["']|["']$/g, ''))
        if (!items.includes(typesId)) items.push(typesId)
        const sorted = items.sort((a, b) => a.localeCompare(b))
        const rebuilt = 'declare -a plugins=(\n' + sorted.map(i => `  "${i}"`).join('\n') + '\n)'
        sh = sh.slice(0, startIdx) + rebuilt + sh.slice(endIdx + 1)
      }
    }
    await fs.writeFile(redirectsFile, sh)
  }

  const testTs = require('path').join(repoRoot, 'docs', 'test.ts')
  if (await fs.pathExists(testTs)) {
    let ts = await fs.readFile(testTs, 'utf8')
    const useLine = `tracer.use('${integrationId}');`
    if (!ts.includes(useLine)) {
      const tsLines = ts.split('\n')
      let bestStart = -1; let bestEnd = -1; let curStart = -1
      for (let i = 0; i <= tsLines.length; i++) {
        const isUse = i < tsLines.length && /^tracer\.use\('[^']+'\);\s*$/.test(tsLines[i])
        if (isUse) {
          if (curStart === -1) curStart = i
        } else if (curStart !== -1) {
          const blockLen = i - curStart
          if (blockLen > (bestEnd - bestStart)) { bestStart = curStart; bestEnd = i }
          curStart = -1
        }
      }
      if (bestStart !== -1) {
        let insertAt = bestEnd
        const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ')
        for (let i = bestStart; i < bestEnd; i++) {
          const m = tsLines[i].match(/^tracer\.use\('([^']+)'\);/)
          if (!m) continue
          if (norm(m[1]) > norm(integrationId)) { insertAt = i; break }
        }
        tsLines.splice(insertAt, 0, useLine)
        ts = tsLines.join('\n')
      } else {
        ts += `\n${useLine}\n`
      }
      await fs.writeFile(testTs, ts)
    }
  }

  const dts = require('path').join(repoRoot, 'index.d.ts')
  if (await fs.pathExists(dts)) {
    let d = await fs.readFile(dts, 'utf8')
    const pluginsIdx = d.indexOf('interface Plugins {')
    if (pluginsIdx !== -1) {
      const endIdx = d.indexOf('}', pluginsIdx)
      if (endIdx !== -1) {
        const head = d.slice(0, pluginsIdx + 'interface Plugins {'.length)
        const body = d.slice(pluginsIdx + 'interface Plugins {'.length, endIdx)
        const tail = d.slice(endIdx)
        const lines = body.split('\n')
        const mapLine = `  "${integrationId}": tracer.plugins.${typesId};`
        const exists = lines.some(l => l.trim().startsWith(`"${integrationId}"`))
        if (!exists) {
          const norm = (s) => s.toLowerCase().replace(/^["']|["']$/g, '').replace(/[^a-z0-9]+/g, ' ')
          let insertAt = lines.length
          for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(/^\s*\"([^\"]+)\"\s*:/)
            if (!m) continue
            if (norm(m[1]) > norm(integrationId)) { insertAt = i; break }
          }
          lines.splice(insertAt, 0, mapLine)
          d = head + lines.join('\n') + tail
        }
      }
    }
    const ifaceBlock = `interface ${typesId} extends Instrumentation {}`
    if (!d.includes(ifaceBlock)) {
      d += `\n\n    /**\n     * This plugin automatically instruments the\n     * [${integrationId}](https://npmjs.com/package/${integrationId}) module.\n     */\n    interface ${typesId} extends Instrumentation {}`
    }
    // also add interface under export namespace plugins { ... }
    const pluginsNsMarker = 'export namespace plugins {'
    const nsStart = d.indexOf(pluginsNsMarker)
    if (nsStart !== -1) {
      // find the closing brace of this namespace block
      let i = nsStart + pluginsNsMarker.length
      let depth = 0
      while (i < d.length) {
        const ch = d[i]
        if (ch === '{') depth++
        else if (ch === '}') {
          if (depth === 0) break
          depth--
        }
        i++
      }
      const nsEnd = i
      if (nsEnd > nsStart) {
        const nsHead = d.slice(0, nsStart)
        const nsBody = d.slice(nsStart, nsEnd)
        const nsTail = d.slice(nsEnd)
        const ifaceDecl = `    interface ${typesId} extends Instrumentation {}`
        if (!nsBody.includes(ifaceDecl)) {
          // insert just before nsEnd to minimize diff
          d = nsHead + nsBody + `\n${ifaceDecl}` + nsTail
        }
      }
    }
    await fs.writeFile(dts, d)
  }
}

module.exports = { updateDocsAndTypes }
