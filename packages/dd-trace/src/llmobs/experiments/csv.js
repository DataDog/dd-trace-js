'use strict'

// Minimal RFC 4180 CSV reader used by `experiments.createDatasetFromCsv`.
// Mirrors dd-trace-py's `csv.DictReader` usage: first row is the header, quoted
// fields may contain the delimiter, doubled quotes, and newlines.

const CSV_FIELD_MAX_SIZE = 10 * 1024 * 1024

/**
 * @param {string} text
 * @param {string} delimiter Single character.
 * @returns {string[][]}
 */
function parseCsv (text, delimiter) {
  if (typeof delimiter !== 'string' || delimiter.length !== 1) {
    throw new Error('csv_delimiter must be a single character')
  }
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  let fieldStart = true

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"' && fieldStart) {
      quoted = true
      fieldStart = false
    } else if (char === delimiter) {
      pushField()
    } else if (char === '\r' || char === '\n') {
      if (char === '\r' && text[i + 1] === '\n') i++
      pushField()
      rows.push(row)
      row = []
    } else {
      field += char
      fieldStart = false
    }
  }
  if (quoted) throw new Error('CSV file has an unterminated quoted field')
  if (field !== '' || row.length > 0) {
    pushField()
    rows.push(row)
  }
  return rows

  function pushField () {
    if (field.length > CSV_FIELD_MAX_SIZE) throw new Error(`CSV field exceeds the ${CSV_FIELD_MAX_SIZE} byte limit`)
    row.push(field)
    field = ''
    fieldStart = true
  }
}

/**
 * Parse CSV text into header + row objects keyed by header name.
 * @param {string} text
 * @param {string} delimiter
 * @returns {{ header: string[], rows: Array<Record<string, string>> }}
 */
function readCsvRecords (text, delimiter) {
  const lines = parseCsv(text, delimiter)
  const header = lines[0]
  if (header === undefined || header.every(column => column.trim() === '')) {
    throw new Error('CSV file appears to be empty or header is missing.')
  }
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i]
    if (values.length === 1 && values[0] === '') continue
    const record = {}
    for (let j = 0; j < header.length; j++) record[header[j]] = values[j] ?? ''
    rows.push(record)
  }
  return { header, rows }
}

module.exports = { parseCsv, readCsvRecords }
