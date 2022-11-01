'use strict'

module.exports = ({ Assertion, expect }) => {
  Assertion.addProperty('valueType', function () {
    const obj = this._obj

    expect(obj).to.be.a('object')
    expect(obj.type).to.be.a('number')
    expect(obj.unit).to.be.a('number')
  })

  Assertion.addProperty('profile', function () {
    const obj = this._obj

    expect(obj).to.be.an('object')

    expect(obj.timeNanos).to.be.a('bigint')
    expect(obj.period).to.be.a('number')
    expect(obj.periodType).to.be.a.valueType
    expect(obj.sampleType).to.be.an('array').and.have.length(2)
    expect(obj.sample).to.be.an('array')
    expect(obj.location).to.be.an('array')
    expect(obj.function).to.be.an('array')
    expect(obj.stringTable).to.be.an('array').and.have.length.at.least(1)
    expect(obj.stringTable[0]).to.equal('')

    for (const sampleType of obj.sampleType) {
      expect(sampleType).to.be.a.valueType
    }

    for (const fn of obj.function) {
      expect(fn.filename).to.be.a('number')
      expect(fn.systemName).to.be.a('number')
      expect(fn.name).to.be.a('number')
      expect(fn.id).to.match(/\d+/)
    }

    for (const location of obj.location) {
      expect(location.id).to.match(/\d+/)
      expect(location.line).to.be.an('array')

      for (const line of location.line) {
        expect(line.functionId).to.match(/\d+/)
        expect(line.line).to.be.a('number')
      }
    }

    for (const sample of obj.sample) {
      expect(sample.locationId).to.be.an('array')
      expect(sample.locationId.length).to.be.gte(1)
      expect(sample.value).to.be.an('array').and.have.length(obj.sampleType.length)
    }
  })
}
