/**
 * Canonical verification runner — one log file per plan step.
 * Usage: node scripts/run-verification-plan.mjs
 * Env: VERIFICATION_SCRATCH (default: grok implementer scratch dir)
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  baseUrl,
  clearAuthCache,
  defaultScratch,
  ensureScratch,
  killPort,
  runCommandWithLog,
  stamp,
  startDevServer,
  stopServer,
  waitForServer,
} from './verification-lib.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const frontendDir = path.resolve(__dirname, '..')
const repoRoot = path.resolve(frontendDir, '..')
const scratchDir = process.env.VERIFICATION_SCRATCH ?? defaultScratch

ensureScratch(scratchDir)

async function step1_cli() {
  stamp('=== Step 1: CLI verification ===')
  const logPath = path.join(scratchDir, 'cli-verify.log')
  const lines = []
  const run = (label, cmd) => {
    lines.push(`=== ${label} ===`)
    try {
      lines.push(execSync(cmd, { cwd: repoRoot, encoding: 'utf8', shell: true }))
    } catch (err) {
      lines.push(err.stdout ?? '')
      lines.push(err.stderr ?? '')
      throw new Error(`${label} failed: ${err.message}`)
    }
    lines.push('')
  }
  run('gh auth status', 'gh auth status')
  run('supabase projects list', 'supabase projects list')
  run('wrangler whoami', 'wrangler whoami')
  run('vercel whoami', 'vercel whoami')
  fs.writeFileSync(logPath, lines.join('\n'), 'utf8')
  stamp(`Step 1 OK — ${logPath}`)
}

async function step2_vitest() {
  stamp('=== Step 2: Vitest ===')
  const logPath = path.join(scratchDir, 'vitest.log')
  await runCommandWithLog({
    command: 'npm',
    args: ['test'],
    cwd: frontendDir,
    logPath,
    header: stamp('command: npm test'),
  })
  stamp(`Step 2 OK — ${logPath}`)
}

async function step3_smokeDev() {
  stamp('=== Step 3: npm run dev + playwright smoke (×2) ===')
  const env = {
    CI: 'true',
    PW_EXTERNAL_SERVER: '1',
    PLAYWRIGHT_BASE_URL: baseUrl,
    BASE_URL: baseUrl,
  }

  for (const pass of [1, 2]) {
    const logPath = path.join(scratchDir, `smoke-run-${pass}.log`)
    const header = [
      stamp(`=== Verification plan step 3 pass ${pass} ===`),
      'command: npm run dev (external) + npx playwright test tests/smoke --grep-invert "API CRUD via request"',
      `baseURL: ${baseUrl}`,
      '',
    ].join('\n')
    await runCommandWithLog({
      command: 'npx',
      args: [
        'playwright',
        'test',
        'tests/smoke',
        '--grep-invert',
        'API CRUD via request',
        '--reporter=line',
      ],
      cwd: frontendDir,
      logPath,
      header,
      env,
    })
    stamp(`Step 3 pass ${pass} OK — ${logPath}`)
  }
}

async function step4_apiCrud() {
  stamp('=== Step 4: API CRUD via Playwright request ===')
  const logPath = path.join(scratchDir, 'api-smoke.log')
  const env = {
    CI: 'true',
    PW_EXTERNAL_SERVER: '1',
    PLAYWRIGHT_BASE_URL: baseUrl,
    BASE_URL: baseUrl,
    API_SMOKE_LOG_PATH: logPath,
  }
  await runCommandWithLog({
    command: 'npx',
    args: ['playwright', 'test', 'tests/smoke/api-crud.spec.ts', '--reporter=line'],
    cwd: frontendDir,
    logPath: path.join(scratchDir, 'api-crud-playwright.log'),
    header: stamp('command: npx playwright test tests/smoke/api-crud.spec.ts'),
    env,
  })
  if (!fs.existsSync(logPath)) {
    throw new Error(`api-smoke.log not written by spec — expected ${logPath}`)
  }
  stamp(`Step 4 OK — ${logPath}`)
}

async function step5_build() {
  stamp('=== Step 5: Production build ===')
  const logPath = path.join(scratchDir, 'build.log')
  await runCommandWithLog({
    command: 'npm',
    args: ['run', 'build'],
    cwd: frontendDir,
    logPath,
    header: stamp('command: npm run build'),
  })
  stamp(`Step 5 OK — ${logPath}`)
}

async function step6_github() {
  stamp('=== Step 6: GitHub hygiene ===')
  const logPath = path.join(scratchDir, 'github-status.log')
  const lines = [
    stamp('command: gh pr list + gh issue list + gh run list'),
    '',
    '=== gh pr list --state open ===',
    execSync('gh pr list --repo iadanish/miniop --state open', {
      encoding: 'utf8',
      shell: true,
    }),
    '',
    '=== gh issue list --state open ===',
    execSync('gh issue list --repo iadanish/miniop --state open', {
      encoding: 'utf8',
      shell: true,
    }),
    '',
    '=== gh run list --branch main --limit 8 ===',
    execSync('gh run list --repo iadanish/miniop --branch main --limit 8', {
      encoding: 'utf8',
      shell: true,
    }),
  ]
  fs.writeFileSync(logPath, lines.join('\n'), 'utf8')
  stamp(`Step 6 OK — ${logPath}`)
}

async function step7_docAudit() {
  stamp('=== Step 7: Doc audit ===')
  execSync('node scripts/doc-audit.mjs', {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, DOC_AUDIT_SCRATCH: scratchDir },
  })
  const logPath = path.join(scratchDir, 'doc-audit.md')
  if (!fs.existsSync(logPath)) {
    throw new Error(`doc-audit.md missing at ${logPath}`)
  }
  stamp(`Step 7 OK — ${logPath}`)
}

function writeVerificationSummary() {
  const summaryPath = path.join(scratchDir, 'verification-summary.md')
  const readTail = (file, pattern) => {
    if (!fs.existsSync(path.join(scratchDir, file))) return 'missing'
    const text = fs.readFileSync(path.join(scratchDir, file), 'utf8')
    const m = text.match(pattern)
    return m ? m[0].trim() : 'see file'
  }

  const body = `# Verification Summary (auto-generated)

Generated: ${new Date().toISOString()}
Runner: \`node frontend/scripts/run-verification-plan.mjs\`

| Step | Log | Result |
|------|-----|--------|
| 1 CLI | cli-verify.log | generated |
| 2 Vitest | vitest.log | ${readTail('vitest.log', /\\d+ passed/)} |
| 3 Smoke dev×2 | smoke-run-1.log, smoke-run-2.log | ${readTail('smoke-run-2.log', /\\d+ passed/)} |
| 4 API CRUD | api-smoke.log | ${readTail('api-smoke.log', /DELETE_STATUS: 200/)} |
| 5 Build | build.log | generated |
| 6 GitHub | github-status.log | generated |
| 7 Docs | doc-audit.md | generated |

Gate logs (pre-commit/CI only): smoke-gate-run-1.log, smoke-gate-run-2.log — **not** plan step 3 evidence.
`
  fs.writeFileSync(summaryPath, body, 'utf8')
  stamp(`Summary — ${summaryPath}`)
}

async function main() {
  let server
  try {
    await step1_cli()
    await step2_vitest()

    killPort(frontendDir)
    clearAuthCache(frontendDir)
    server = startDevServer(frontendDir)
    await waitForServer()

    await step3_smokeDev()
    await step4_apiCrud()

    stopServer(server)
    killPort(frontendDir)

    await step5_build()
    await step6_github()
    await step7_docAudit()
    writeVerificationSummary()
    stamp('Verification plan: ALL STEPS PASSED')
  } catch (err) {
    console.error(err.message ?? err)
    process.exit(1)
  } finally {
    stopServer(server)
    killPort(frontendDir)
  }
}

main()