'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { diffAll } = require('./diff')

const REPORT_PATH = path.join(__dirname, 'report.md')

function writeReport (results = diffAll()) {
  const lines = [
    '# LLMObs Python/JavaScript parity',
    '',
    '| Integration | Scenario | Result |',
    '| --- | --- | --- |',
  ]
  for (const result of results) {
    const outcome = result.not_captured
      ? 'not captured'
      : result.matched
        ? 'matched'
        : `${result.divergences.length + result.missing_in_js.length + result.missing_in_py.length} divergences`
    lines.push(`| ${result.integration} | ${result.scenario} | ${outcome} |`)
  }
  lines.push('', '## Divergences', '')
  for (const result of results) {
    if (result.matched || result.not_captured) continue
    lines.push(`### ${result.integration}/${result.scenario}`, '')
    for (const item of result.divergences) {
      const reason = item.reason ? ` (${item.reason})` : ''
      const detail = item.path.endsWith('.tags')
        ? `only_in_py=${JSON.stringify(item.py)} only_in_js=${JSON.stringify(item.js)}`
        : `py=${JSON.stringify(item.py)} js=${JSON.stringify(item.js)}`
      lines.push(`- \`${item.path}\`${reason}: ${detail}`)
    }
    for (const key of result.missing_in_js) lines.push(`- missing in js: \`${key}\``)
    for (const key of result.missing_in_py) lines.push(`- missing in py: \`${key}\``)
    lines.push('')
  }
  const report = `${lines.join('\n')}\n`
  fs.writeFileSync(REPORT_PATH, report)
  process.stdout.write(report)
  return report
}

module.exports = { REPORT_PATH, writeReport }
