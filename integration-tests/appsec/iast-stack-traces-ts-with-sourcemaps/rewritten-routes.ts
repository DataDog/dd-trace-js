import express from 'express'
import crypto from 'crypto'

const router = express.Router()

router.get('/stack-trace-from-unnamed-function', (req, res) => {
  res.send((new Error('Error ' + req.query.param).stack))
})

router.get('/stack-trace-from-named-function', function namedFunctionRewrittenFile (req, res) {
  res.send((new Error('Error ' + req.query.param).stack))
})

router.get('/vulnerability', (req, res) => {
  res.send(crypto.createHash('sha1').update('test').digest('hex'))
})

export default router
