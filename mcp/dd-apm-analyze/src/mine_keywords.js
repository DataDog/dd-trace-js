'use strict'

const fs = require('fs/promises')
const path = require('path')

function categoryForBase (base) {
  if (base === 'database') return 'db'
  if (base === 'server') return 'web'
  if (base === 'outbound') return 'http'
  if (base === 'cache') return 'cache'
  if (base === 'producer' || base === 'consumer' || base === 'composite') return 'messaging'
  return 'other'
}

async function mineKeywords () {
  const repoRoot = path.resolve(path.join(__dirname, '..', '..', '..'))
  const pluginsRoot = path.join(repoRoot, 'packages')
  const entries = await fs.readdir(pluginsRoot)
  const pluginDirs = entries.filter((n) => n.startsWith('datadog-plugin-'))

  const initCat = () => ({ verbs: new Set(), keywords: new Set() })
  const mined = {
    categories: {
      db: initCat(),
      web: initCat(),
      http: initCat(),
      messaging: initCat(),
      cache: initCat(),
      other: initCat()
    }
  }

  for (const dirName of pluginDirs) {
    const pkgId = dirName.replace(/^datadog-plugin-/, '')
    const srcDir = path.join(pluginsRoot, dirName, 'src')
    const indexPath = path.join(srcDir, 'index.js')

    let src = ''
    try { src = await fs.readFile(indexPath, 'utf8') } catch { continue }

    let base = null
    if (/plugins\/database'\)/.test(src)) base = 'database'
    else if (/plugins\/server'\)/.test(src)) base = 'server'
    else if (/plugins\/outbound'\)/.test(src)) base = 'outbound'
    else if (/plugins\/cache'\)/.test(src)) base = 'cache'
    else if (/plugins\/composite'\)/.test(src)) base = 'composite'
    else if (/plugins\/producer'\)/.test(src)) base = 'producer'
    else if (/plugins\/consumer'\)/.test(src)) base = 'consumer'

    const category = categoryForBase(base)
    mined.categories[category].keywords.add(pkgId)

    const instrPath = path.join(
      repoRoot,
      'packages',
      'datadog-instrumentations',
      'src',
      `${pkgId}.js`
    )
    try {
      const instr = await fs.readFile(instrPath, 'utf8')
      // shimmer.wrap targets
      const reWrap = /shimmer\.wrap\([^,]+,\s*['"]([A-Za-z0-9_$]+)['"]/g
      let m
      while ((m = reWrap.exec(instr))) {
        mined.categories[category].verbs.add(m[1])
      }
      // apm:<op>:start channels
      const reCh = /apm:([a-zA-Z]+):(start|finish|error)/g
      while ((m = reCh.exec(instr))) {
        mined.categories[category].verbs.add(m[1])
      }
    } catch {}
  }

  const out = { categories: {} }
  for (const [cat, data] of Object.entries(mined.categories)) {
    out.categories[cat] = {
      verbs: Array.from(data.verbs),
      keywords: Array.from(data.keywords)
    }
  }

  const outPath = path.join(__dirname, 'mined_tokens.json')
  await fs.writeFile(outPath, JSON.stringify(out, null, 2))
  console.log(`Mined tokens written to: ${outPath}`)
}

module.exports = {
  command: 'mine-keywords',
  describe: 'Mine existing integrations to derive category verbs/keywords',
  builder: (y) => y,
  handler: async () => {
    try { await mineKeywords() } catch (e) {
      console.error('Mining failed:', e.message)
      process.exit(1)
    }
  }
}
