'use strict'

const Analyzer = require('./vulnerability-analyzer')
const { getRelativePath } = require('../path-line')

module.exports = class HardcodedBaseAnalyzer extends Analyzer {
  onConfigure () {
    this.addSub('datadog:secrets:result', (secrets) => { this.analyze(secrets) })
  }

  get rules () {
    return []
  }

  analyze (secrets) {
    if (!secrets?.file || !secrets.literals) return

    const { rules } = this

    const matches = []
    for (const literal of secrets.literals) {
      const { value, locations } = literal
      if (!value || !locations) continue

      for (const location of locations) {
        const fullValue = location.ident ? `${location.ident}=${value}` : value
        const match = rules.find(rule => fullValue.match(rule.regex))

        if (match) {
          matches.push({ location, ruleId: match.id })
        }
      }
    }

    if (matches.length) {
      const file = getRelativePath(secrets.file)

      matches
        .forEach(match => this._report({
          file,
          line: match.location.line,
          column: match.location.column,
          data: match.ruleId
        }))
    }
  }

  _getEvidence (value) {
    return { value: `${value.data}` }
  }

  _getLocation (value) {
    return {
      path: value.file,
      line: value.line,
      column: value.column,
      isInternal: false
    }
  }
}
