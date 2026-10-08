'use strict'

// Shared sentinel emitted for values that could not be captured or that were
// trimmed during tag flattening. Keeping a single definition guarantees the
// observable tag value stays identical everywhere it is produced.
const truncated = 'truncated'

// Maximum length, in UTF-16 code units, of a single tag value. Shared so the
// snapshot can size partial Buffer copies to exactly what flattening renders.
const maxValueLength = 5000

module.exports = { maxValueLength, truncated }
