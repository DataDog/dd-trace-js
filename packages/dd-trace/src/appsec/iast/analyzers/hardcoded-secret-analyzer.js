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
      .reduce((locAndRules, literal) => {
        literal.locations
          .map(location => {
            const value = location.ident ? `${location.ident}=${literal.value}` : literal.value

            const match = secretRules.find(rule => value.match(rule.regex))

            return match ? { location, ruleId: match.id } : undefined
          })
          .filter(locAndRuleId => !!locAndRuleId && locAndRuleId.location.line)
          .forEach(locAndRuleId => locAndRules.push(locAndRuleId))

        return locAndRules
      }, [])

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

module.exports = new HardcodedSecretAnalyzer()
