// Next.js API route support: https://nextjs.org/docs/api-routes/introduction

export default (req, res) => {
  const tracer = require('../../../../../dd-trace')
  const span = tracer.scope().active()
  const name = span && span.context()._name

  res.status(200).json({ name })
}
