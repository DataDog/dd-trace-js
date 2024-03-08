'use strict'

const Analyzer = require('./vulnerability-analyzer')
const { getRelativePath } = require('../path-line')

module.exports = class HardcodedBaseAnalyzer extends Analyzer {
  onConfigure () {
    this.addSub('datadog:secrets:result', (secrets) => { this.analyze(secrets) })
  }

  getAllRules () {
    return []
  }

  getValueOnlyRules () {
    return []
  }

  analyze (secrets) {
    if (!secrets?.file || !secrets.literals) return

    const allRules = this.getAllRules()
    const valueOnlyRules = this.getValueOnlyRules()

    const matches = []
    for (const literal of secrets.literals) {
      const { value, locations } = literal
      if (!value || !locations) continue

      for (const location of locations) {
        let match
        if (location.ident) {
          const fullValue = `${location.ident}=${value}`
          match = allRules.find(rule => fullValue.match(rule.regex))
        } else {
          match = valueOnlyRules.find(rule => value.match(rule.regex))
        }

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
