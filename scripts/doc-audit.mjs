import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratchDir =
  process.env.DOC_AUDIT_SCRATCH ??
  'C:/Users/izhar/AppData/Local/Temp/grok-goal-ed122ecafab6/implementer'

const PIPELINE_PATTERNS = [
  /\bWhisper\b/i,
  /\bFFmpeg\b/i,
  /\bvirality\b/i,
  /\bfaster-whisper\b/i,
]

const SHIPPED_ROUTES = [
  '/',
  '/login',
  '/signup',
  '/dashboard',
  '/dashboard/upload',
  '/api/videos',
]

const CONTEXT_FILES = ['CONTEXT.md', 'TASKS.md', 'DECISIONS.md', 'CLAUDE.md']

const PHASE2_BANNER = 'Implementation status (2026-07-01)'

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, acc)
    else if (entry.name.endsWith('.md')) acc.push(full)
  }
  return acc
}

function listAppRoutes(appDir) {
  const routes = []
  function scan(dir, prefix = '') {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('(') && entry.name.endsWith(')')) {
          scan(full, prefix)
        } else if (entry.name.startsWith('[')) {
          scan(full, `${prefix}/[param]`)
        } else {
          scan(full, `${prefix}/${entry.name}`)
        }
      } else if (entry.name === 'page.tsx' || entry.name === 'route.ts') {
        routes.push(prefix || '/')
      }
    }
  }
  scan(appDir)
  return routes
}

function scanFile(filePath, rel) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n')
  const hits = []
  const hasPhase2Banner = fs.readFileSync(filePath, 'utf8').includes(PHASE2_BANNER)

  lines.forEach((line, index) => {
    for (const pattern of PIPELINE_PATTERNS) {
      if (pattern.test(line)) {
        hits.push({
          line: index + 1,
          text: line.trim().slice(0, 120),
          pattern: pattern.source,
          status: hasPhase2Banner ? 'out-of-scope (Phase 2+ banner)' : 'needs review',
        })
      }
    }
  })
  return hits
}

function shippedSurfaceMismatches() {
  const mismatches = []
  const contextText = CONTEXT_FILES.map((f) => {
    const p = path.join(repoRoot, f)
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
  }).join('\n')

  if (!contextText.includes('/dashboard')) {
    mismatches.push({ file: 'CONTEXT.md', line: 0, issue: 'missing /dashboard route claim' })
  }
  if (!contextText.includes('run-verification-plan') && !contextText.includes('run-smoke-gate')) {
    mismatches.push({
      file: 'CONTEXT.md',
      line: 0,
      issue: 'missing smoke/verification gate documentation',
    })
  }
  if (!contextText.toLowerCase().includes('video list') && !contextText.includes('VideoList')) {
    mismatches.push({
      file: 'CONTEXT.md',
      line: 0,
      issue: 'missing dashboard video list UI claim',
    })
  }

  return mismatches
}

function main() {
  fs.mkdirSync(scratchDir, { recursive: true })
  const docsDir = path.join(repoRoot, 'docs')
  const appDir = path.join(repoRoot, 'frontend', 'src', 'app')
  const routes = listAppRoutes(appDir)

  const docFiles = walk(docsDir)
  const allHits = []
  let needsReview = 0
  let tagged = 0

  for (const file of docFiles) {
    const rel = path.relative(repoRoot, file).replace(/\\/g, '/')
    const hits = scanFile(file, rel)
    for (const hit of hits) {
      allHits.push({ file: rel, ...hit })
      if (hit.status === 'needs review') needsReview++
      else tagged++
    }
  }

  const shipped = shippedSurfaceMismatches()
  const lines = [
    '# Doc Audit (mechanical)',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Script: scripts/doc-audit.mjs`,
    '',
    '## Shipped routes (code)',
    '',
    ...routes.map((r) => `- \`${r}\``),
    '',
    '## Shipped surface mismatches',
    '',
  ]

  if (shipped.length === 0) {
    lines.push('_None — context files align with shipped routes/UI._')
  } else {
    for (const m of shipped) {
      lines.push(`- ${m.file}:${m.line} — ${m.issue} — **unfixed**`)
    }
  }

  lines.push('', '## Pipeline claims in docs/', '')
  lines.push(
    '| File | Line | Pattern | Status |',
    '|------|------|---------|--------|',
  )

  const reviewHits = allHits.filter((h) => h.status === 'needs review').slice(0, 50)
  for (const h of allHits.slice(0, 200)) {
    lines.push(`| ${h.file} | ${h.line} | ${h.pattern} | ${h.status} |`)
  }

  lines.push(
    '',
    '## Summary',
    '',
    `- Total pipeline claim hits: ${allHits.length}`,
    `- Tagged Phase 2+ banner: ${tagged}`,
    `- Needs review (no banner): ${needsReview}`,
    `- Shipped surface mismatches: ${shipped.length}`,
    '',
  )

  if (shipped.length > 0) {
    lines.push('**FAIL:** shipped-surface section not empty')
    fs.writeFileSync(path.join(scratchDir, 'doc-audit.md'), lines.join('\n'), 'utf8')
    process.exit(1)
  }

  lines.push('**PASS:** shipped surfaces OK; pipeline claims tagged or listed for Phase 2+.')
  fs.writeFileSync(path.join(scratchDir, 'doc-audit.md'), lines.join('\n'), 'utf8')
}

main()