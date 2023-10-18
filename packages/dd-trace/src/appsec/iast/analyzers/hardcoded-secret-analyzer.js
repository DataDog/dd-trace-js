'use strict'

const Analyzer = require('./vulnerability-analyzer')
const { HARDCODED_SECRET } = require('../vulnerabilities')
const { getRelativePath } = require('../path-line')

const secretRules = require('./hardcoded-secrets-rules')

class HardcodedSecretAnalyzer extends Analyzer {
  constructor () {
    super(HARDCODED_SECRET)
  }

  onConfigure () {
    this.addSub('datadog:secrets:result', (secrets) => { this.analyze(secrets) })
  }

  analyze (secrets) {
    if (!secrets?.file || !secrets.literals) return

    const matches = secrets.literals
      .filter(literal => literal.value && literal.locations?.length)
      .map(literal => {
        const match = secretRules.find(rule => literal.value.match(rule.regex))

        return match ? { locations: literal.locations, ruleId: match.id } : undefined
      })
      .filter(match => !!match)

    if (matches.length) {
      const file = getRelativePath(secrets.file)

      matches.forEach(match => {
        match.locations
          .filter(location => location.line)
          .forEach(location => this._report({
            file,
            line: location.line,
            column: location.column,
            data: match.ruleId
          }))
      })
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

module.exports = new HardcodedSecretAnalyzer()
