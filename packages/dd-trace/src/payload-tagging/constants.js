'use strict'

// Sentinel for values that could not be captured or were trimmed during tag
// flattening. A single definition keeps the tag value identical everywhere it
// is emitted.
const truncated = 'truncated'

// Max tag value length, in UTF-16 code units. Shared so the snapshot can size
// partial Buffer copies to exactly what flattening renders.
const maxValueLength = 5000

module.exports = { maxValueLength, truncated }
