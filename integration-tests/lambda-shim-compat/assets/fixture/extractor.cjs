'use strict'
exports.extract = () => Promise.resolve({ traceId: '1234', parentId: '5678', sampleMode: 1, source: 'event' })
