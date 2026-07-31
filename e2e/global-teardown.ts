import fs from 'node:fs'

export default function globalTeardown() {
  const directory = process.env.JOURNEY_UNFINISHED_E2E_DIR
  if (directory) fs.rmSync(directory, { recursive: true, force: true })
}
