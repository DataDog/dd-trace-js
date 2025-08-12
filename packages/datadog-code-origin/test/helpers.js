'use strict'

module.exports = {
  assertCodeOriginFromTraces (traces, frame) {
    const spans = traces[0]
    const tags = spans[0].meta

    expect(tags).to.have.property('_dd.code_origin.type', 'entry')

    expect(tags).to.have.property('_dd.code_origin.frames.0.file', frame.file)
    expect(tags).to.have.property('_dd.code_origin.frames.0.line', String(frame.line))
    expect(tags).to.have.property('_dd.code_origin.frames.0.column').to.match(/^\d+$/)
    if (frame.method) {
      expect(tags).to.have.property('_dd.code_origin.frames.0.method', frame.method)
    } else {
      expect(tags).to.not.have.property('_dd.code_origin.frames.0.method')
    }
    if (frame.type) {
      expect(tags).to.have.property('_dd.code_origin.frames.0.type', frame.type)
    } else {
      expect(tags).to.not.have.property('_dd.code_origin.frames.0.type')
    }

    // The second frame should not be present, because we only collect 1 frame for entry spans
    expect(tags).to.not.have.property('_dd.code_origin.frames.1.file')
  }
}
