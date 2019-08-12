/*
it('should generate sampling priority', () => {
  writer.append(span)

  expect(prioritySampler.sample).to.have.been.calledWith(span.context())
})

it('should erase the trace once finished', () => {
  trace.started = [span]
  trace.finished = [span]

  writer.append(span)

  expect(trace).to.have.deep.property('started', [])
  expect(trace).to.have.deep.property('finished', [])
  expect(span.context()).to.have.deep.property('_tags', {})
  expect(span.context()).to.have.deep.property('_metrics', {})
})


    it('should skip traces with unfinished spans', () => {
      trace.started = [span]
      trace.finished = []
      writer.append(span)

      expect(writer._queue).to.be.empty
    })
*/
