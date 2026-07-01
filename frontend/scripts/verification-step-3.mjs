/**
 * Verification plan step 3: npm run dev + npx playwright test (smoke) × 2
 * Logs: {SCRATCH}/verification-step-3-run-1.log, verification-step-3-run-2.log
 */
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const frontendDir = path.resolve(__dirname, '..')
const scratchDir =
  process.env.SMOKE_GATE_SCRATCH ??
  'C:/Users/izhar/AppData/Local/Temp/grok-goal-ed122ecafab6/implementer'
const baseUrl = 'http://127.0.0.1:3000'

fs.mkdirSync(scratchDir, { recursive: true })

function stamp(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  return line
}

function killPort() {
  try {
    if (process.platform === 'win32') {
      execSync('npx kill-port 3000', { cwd: frontendDir, stdio: 'pipe', shell: true, timeout: 30_000 })
    } else {
      execSync('fuser -k 3000/tcp 2>/dev/null || true', { stdio: 'pipe', shell: true, timeout: 10_000 })
    }
  } catch {
    /* port may be free */
  }
}

function clearAuthCache() {
  fs.rmSync(path.join(frontendDir, 'tests/smoke/.auth'), { recursive: true, force: true })
}

async function waitForServer(timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl, { signal: AbortSignal.timeout(5_000) })
      if (res.status < 500) return
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Dev server not ready after ${timeoutMs}ms`)
}

function startDevServer() {
  return spawn('npm', ['run', 'dev', '--', '-H', '127.0.0.1', '-p', '3000'], {
    cwd: frontendDir,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })
}

async function runPlaywrightPass(passNumber) {
  const logPath = path.join(scratchDir, `verification-step-3-run-${passNumber}.log`)
  const header = [
    stamp(`=== Verification step 3 pass ${passNumber} ===`),
    'command: npm run dev (external) + npx playwright test tests/smoke',
    `baseURL: ${baseUrl}`,
    '',
  ].join('\n')
  fs.writeFileSync(logPath, header + '\n', 'utf8')
  const logStream = fs.createWriteStream(logPath, { flags: 'a' })

  return new Promise((resolve, reject) => {
    const child = spawn(
      'npx',
      ['playwright', 'test', 'tests/smoke', '--reporter=line'],
      {
        cwd: frontendDir,
        shell: true,
        env: {
          ...process.env,
          CI: 'true',
          PW_EXTERNAL_SERVER: '1',
          PLAYWRIGHT_BASE_URL: baseUrl,
          BASE_URL: baseUrl,
        },
      },
    )

    const pipe = (chunk) => {
      process.stdout.write(chunk)
      logStream.write(chunk)
    }
    child.stdout?.on('data', pipe)
    child.stderr?.on('data', pipe)

    child.on('close', (code) => {
      logStream.end()
      if (code === 0) {
        stamp(`Pass ${passNumber} PASSED — ${logPath}`)
        resolve()
      } else {
        reject(new Error(`Pass ${passNumber} failed (exit ${code}). See ${logPath}`))
      }
    })
  })
}

function stopServer(server) {
  if (!server || server.killed) return
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${server.pid} /T /F`, { stdio: 'pipe' })
    } else {
      server.kill('SIGTERM')
    }
  } catch {
    server.kill('SIGKILL')
  }
}

async function main() {
  let server
  try {
    killPort()
    clearAuthCache()
    stamp('Starting npm run dev')
    server = startDevServer()
    await waitForServer()
    await runPlaywrightPass(1)
    await runPlaywrightPass(2)
    stamp('Verification step 3: 2/2 passes succeeded')
  } finally {
    stopServer(server)
    killPort()
  }
}

main().catch((err) => {
  console.error(err.message ?? err)
  process.exit(1)
})