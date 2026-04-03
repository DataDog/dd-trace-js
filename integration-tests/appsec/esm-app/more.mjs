import childProcess from 'node:child_process'
import express from 'express'

const router = express.Router()
router.get('/cmdi-vulnerable', (req, res) => {
  childProcess.execSync(`ls ${req.query.args}`)

  res.end()
})

export default router
