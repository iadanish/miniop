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
  stamp('Killing anything on port 3000')
  try {
    execSync('npx kill-port 3000', {
      cwd: frontendDir,
      stdio: 'pipe',
      shell: true,
    })
  } catch {
    /* port may already be free */
  }
}

function clearAuthCache() {
  const authDir = path.join(frontendDir, 'tests/smoke/.auth')
  fs.rmSync(authDir, { recursive: true, force: true })
  stamp('Cleared tests/smoke/.auth')
}

function runBuild() {
  stamp('Running npm run build (once)')
  execSync('npm run build', {
    cwd: frontendDir,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env },
  })
  const buildId = path.join(frontendDir, '.next', 'BUILD_ID')
  if (!fs.existsSync(buildId)) {
    throw new Error('Build finished but .next/BUILD_ID is missing')
  }
  stamp(`Build OK — BUILD_ID present`)
}

async function waitForServer(timeoutMs = 120_000) {
  stamp(`Polling ${baseUrl} until ready`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl, { signal: AbortSignal.timeout(5_000) })
      if (res.status < 500) {
        stamp(`Server ready (HTTP ${res.status})`)
        return
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Server not ready after ${timeoutMs}ms`)
}

function startServer() {
  stamp('Starting next start -H 127.0.0.1 -p 3000')
  const server = spawn('npx', ['next', 'start', '-H', '127.0.0.1', '-p', '3000'], {
    cwd: frontendDir,
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  })
  server.stdout?.on('data', (chunk) => process.stdout.write(chunk))
  server.stderr?.on('data', (chunk) => process.stderr.write(chunk))
  return server
}

async function runSmokePass(passNumber) {
  const logPath = path.join(scratchDir, `smoke-run-${passNumber}.log`)
  const header = [
    stamp(`=== Smoke pass ${passNumber} ===`),
    `command: PW_EXTERNAL_SERVER=1 CI=true npm run test:smoke:ci`,
    `baseURL: ${baseUrl}`,
    '',
  ].join('\n')
  fs.writeFileSync(logPath, header + '\n', 'utf8')
  const logStream = fs.createWriteStream(logPath, { flags: 'a' })

  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'test:smoke:ci'], {
      cwd: frontendDir,
      shell: true,
      env: {
        ...process.env,
        CI: 'true',
        PW_EXTERNAL_SERVER: '1',
        PLAYWRIGHT_BASE_URL: baseUrl,
        BASE_URL: baseUrl,
      },
    })

    const pipe = (chunk) => {
      process.stdout.write(chunk)
      logStream.write(chunk)
    }
    child.stdout?.on('data', pipe)
    child.stderr?.on('data', pipe)

    child.on('close', (code) => {
      logStream.end()
      if (code === 0) {
        stamp(`Smoke pass ${passNumber} PASSED — log: ${logPath}`)
        resolve()
      } else {
        reject(new Error(`Smoke pass ${passNumber} failed (exit ${code}). See ${logPath}`))
      }
    })
  })
}

function stopServer(server) {
  if (!server || server.killed) return
  stamp(`Stopping server (pid ${server.pid})`)
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
    runBuild()
    server = startServer()
    await waitForServer()
    await runSmokePass(1)
    await runSmokePass(2)
    stamp('Smoke gate: 2/2 passes succeeded')
  } finally {
    stopServer(server)
    killPort()
  }
}

main().catch((err) => {
  console.error(err.message ?? err)
  process.exit(1)
})