// Next.js API route support: https://nextjs.org/docs/api-routes/introduction

export default (req, res) => {
  const tracer = require('../../../../../dd-trace')

  if (req.query.createChildSpan === 'true') {
    const childSpan = tracer.startSpan('child.operation', {
      childOf: tracer.scope().active()
    })

    tracer.scope().activate(childSpan, () => {
      childSpan.finish()
    })
  }

  const span = tracer.scope().active()
  const name = span && span.context()._name

  res.status(200).json({ name })
}
