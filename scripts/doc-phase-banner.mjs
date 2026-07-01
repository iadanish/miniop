import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const BANNER = `> **Implementation status (2026-07-01):** Phase 2+ design — **not shipped** in Phase 1. Shipped today: Next.js auth, dashboard, video upload, \`/api/videos/*\` CRUD, R2 storage, Playwright smoke gate. See \`docs/product-strategy/03-roadmap.md\` and \`CONTEXT.md\`.

`

const TARGETS = [
  'docs/ai-ml-pipeline/01-whisper-transcription.md',
  'docs/ai-ml-pipeline/02-clip-analysis.md',
  'docs/ai-ml-pipeline/04-virality-scoring.md',
  'docs/performance/03-video-processing-optimization.md',
  'docs/system-architecture/02-microservices.md',
  'docs/system-architecture/03-data-flow.md',
  'docs/system-architecture/04-infrastructure.md',
  'docs/backend-architecture/01-server-structure.md',
  'docs/testing-strategy/02-integration-testing.md',
  'docs/staging-environment/02-staging-workflow.md',
  'docs/devops/02-containerization.md',
  'docs/deployment/02-environment-setup.md',
  'docs/monitoring-logging/01-application-monitoring.md',
  'docs/monitoring-logging/02-logging-strategy.md',
  'docs/monitoring-logging/03-alerting.md',
  'docs/scalability/01-horizontal-scaling.md',
  'docs/scalability/02-auto-scaling.md',
  'docs/scalability/03-database-scaling.md',
  'docs/agentic-orchestration/01-agent-architecture.md',
  'docs/api-documentation/01-api-design.md',
]

let updated = 0
for (const rel of TARGETS) {
  const filePath = path.join(root, rel)
  if (!fs.existsSync(filePath)) {
    console.warn('skip missing', rel)
    continue
  }
  const content = fs.readFileSync(filePath, 'utf8')
  if (content.includes('Implementation status (2026-07-01)')) {
    console.log('already tagged', rel)
    continue
  }
  const lines = content.split('\n')
  const title = lines[0]
  const rest = lines.slice(1).join('\n')
  fs.writeFileSync(filePath, `${title}\n\n${BANNER}${rest}`, 'utf8')
  updated++
  console.log('updated', rel)
}
console.log(`doc-phase-banner: ${updated} files updated`)