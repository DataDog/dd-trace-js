'use strict'

const REDACTION_DIR = '../packages/dd-trace/src/appsec/iast/vulnerabilities-formatter/evidence-redaction'
const sensitiveHandler = require(`${REDACTION_DIR}/sensitive-handler`)
const ldapAnalyzer = require(`${REDACTION_DIR}/sensitive-analyzers/ldap-sensitive-analyzer`)
const urlAnalyzer = require(`${REDACTION_DIR}/sensitive-analyzers/url-sensitive-analyzer`)
const vulnerabilities = require('../packages/dd-trace/src/appsec/iast/vulnerabilities')

const benchmark = require('./benchmark')
const suite = benchmark('iast-evidence-redaction')

// Fixtures cover both the matching-happy paths and the irregular-input paths that the
// analyzers must scan in linear time. The benchmark guards against regressions in
// scanner/regex linearity and in the evidence-length cap.

const KB = 1024

// LDAP: deeply parenthesised with no operator — exercises the scanner's no-match path.
const ldapIrregular8k = '('.repeat(8 * KB) + 'attr'
// LDAP: many real assertion filters chained together — exercises the scanner happy path.
const ldapWellFormed = '(&' + '(uid=alice)(mail=a@example.com)'.repeat(200) + ')'

// URL: many `?aaaa` fragments with no `=` — exercises the tightened key class.
const urlIrregular16k = 'http://x/?' + '?aaaaaaaa'.repeat(2 * KB)
const urlWellFormed = 'http://x/?' + 'k1=v1&k2=v2&k3=v3&'.repeat(400)

// SQL Oracle: q-quote starts with no terminator — exercises the under-cap regex path.
const sqlOracleIrregular = "q'<".repeat(2 * KB)

// Just over the internal MAX_EVIDENCE_LENGTH (32_768 chars) — exercises the cap path.
const overCap = 'a'.repeat(32_768 + 1)

suite
  .add('LDAP scanner - well-formed (~6KB)', {
    fn () {
      ldapAnalyzer({ value: ldapWellFormed })
    },
  })
  .add('LDAP scanner - no-match (8KB)', {
    fn () {
      ldapAnalyzer({ value: ldapIrregular8k })
    },
  })
  .add('URL analyzer - well-formed (~7KB)', {
    fn () {
      urlAnalyzer({ value: urlWellFormed })
    },
  })
  .add('URL analyzer - no-match (16KB)', {
    fn () {
      urlAnalyzer({ value: urlIrregular16k })
    },
  })
  .add('SQL Oracle - no-match (~6KB, under cap)', {
    fn () {
      sensitiveHandler.scrubEvidence(
        vulnerabilities.SQL_INJECTION,
        { value: sqlOracleIrregular, dialect: 'ORACLE' },
        [],
        []
      )
    },
  })
  .add('scrubEvidence - over cap', {
    fn () {
      sensitiveHandler.scrubEvidence(
        vulnerabilities.LDAP_INJECTION,
        { value: overCap },
        [],
        []
      )
    },
  })
  .run()
