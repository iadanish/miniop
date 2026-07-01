import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const docsDir = path.join(root, 'docs')

const BANNER = `> **Implementation status (2026-07-01):** Phase 2+ design — **not shipped** in Phase 1. Shipped today: Next.js auth, dashboard, video upload, \`/api/videos/*\` CRUD, R2 storage, Playwright smoke gate. See \`docs/product-strategy/03-roadmap.md\` and \`CONTEXT.md\`.

`

const BANNER_MARKER = 'Implementation status (2026-07-01)'

const PIPELINE_PATTERN = /Whisper|FFmpeg|virality|faster-whisper/i

/** Recursively collect all .md files under dir. */
function collectMarkdownFiles(dir, results = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectMarkdownFiles(fullPath, results)
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(fullPath)
    }
  }
  return results
}

const targets = collectMarkdownFiles(docsDir)
  .map((filePath) => path.relative(root, filePath).replace(/\\/g, '/'))
  .filter((rel) => {
    const content = fs.readFileSync(path.join(root, rel), 'utf8')
    return PIPELINE_PATTERN.test(content) && !content.includes(BANNER_MARKER)
  })
  .sort()

const updatedPaths = []

for (const rel of targets) {
  const filePath = path.join(root, rel)
  const content = fs.readFileSync(filePath, 'utf8')
  const lines = content.split('\n')
  const title = lines[0]
  const rest = lines.slice(1).join('\n')
  fs.writeFileSync(filePath, `${title}\n\n${BANNER}${rest}`, 'utf8')
  updatedPaths.push(rel)
  console.log('updated', rel)
}

console.log(`doc-phase-banner: ${updatedPaths.length} files updated`)
if (updatedPaths.length > 0) {
  console.log('updated files:')
  for (const rel of updatedPaths) {
    console.log(`  - ${rel}`)
  }
}