'use strict'

function getStatementLineNumbers (sourceText) {
  const lineNumbers = []
  const lines = sourceText.split(/\r?\n/)

  for (let index = 0; index < lines.length; index++) {
    if (lines[index].trim()) {
      lineNumbers.push(index + 1)
    }
  }

  return lineNumbers
}

function getCoverageData (filename, sourceText) {
  const statementMap = {}
  const s = {}
  const lines = sourceText.split(/\r?\n/)

  for (const [id, line] of getStatementLineNumbers(sourceText).entries()) {
    statementMap[id] = {
      start: {
        line,
        column: 0,
      },
      end: {
        line,
        column: lines[line - 1].length,
      },
    }
    s[id] = 0
  }

  return {
    path: filename,
    hash: 'escaped\\coverage',
    statementMap,
    fnMap: {},
    branchMap: {},
    s,
    f: {},
    b: {},
  }
}

module.exports = {
  canInstrument: true,
  process (sourceText, filename, options) {
    if (!options?.instrument || !filename.includes('/src/')) {
      return {
        code: sourceText,
      }
    }

    return {
      code: `var coverageData = ${JSON.stringify(getCoverageData(filename, sourceText))};\n${sourceText}`,
    }
  },
}
