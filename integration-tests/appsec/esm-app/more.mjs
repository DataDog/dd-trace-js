import express from 'express'
import childProcess from 'node:child_process'

const router = express.Router()
router.get('/cmdi-vulnerable', (req, res) => {
  childProcess.execSync(`ls ${req.query.args}`)

  res.end()
})

export default router
