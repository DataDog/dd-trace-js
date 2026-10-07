'use strict'

// Shared sentinel emitted for values that could not be captured or that were
// trimmed during tag flattening. Keeping a single definition guarantees the
// observable tag value stays identical everywhere it is produced.
const truncated = 'truncated'

module.exports = { truncated }
