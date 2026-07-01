import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const defaultScratch =
  'C:/Users/izhar/AppData/Local/Temp/grok-goal-ed122ecafab6/implementer'

export const baseUrl = 'http://127.0.0.1:3000'

export function stamp(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  return line
}

export function ensureScratch(scratchDir) {
  fs.mkdirSync(scratchDir, { recursive: true })
}

export function killPort(frontendDir) {
  stamp('Killing anything on port 3000')
  try {
    if (process.platform === 'win32') {
      execSync('npx kill-port 3000', {
        cwd: frontendDir,
        stdio: 'pipe',
        shell: true,
        timeout: 30_000,
      })
    } else {
      execSync('fuser -k 3000/tcp 2>/dev/null || true', {
        stdio: 'pipe',
        shell: true,
        timeout: 10_000,
      })
    }
  } catch {
    /* port may already be free */
  }
}

export function clearAuthCache(frontendDir) {
  const authDir = path.join(frontendDir, 'tests/smoke/.auth')
  fs.rmSync(authDir, { recursive: true, force: true })
  stamp('Cleared tests/smoke/.auth')
}

let devServerLogPath = null

function appendDevServerLog(line) {
  if (!devServerLogPath) return
  fs.appendFileSync(devServerLogPath, line, 'utf8')
}

export async function waitForServer(timeoutMs = 300_000) {
  const pollLine = stamp(`Polling ${baseUrl} until ready`)
  appendDevServerLog(pollLine + '\n')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl, { signal: AbortSignal.timeout(5_000) })
      if (res.status < 500) {
        const readyLine = stamp(`Server ready (HTTP ${res.status})`)
        appendDevServerLog(readyLine + '\n')
        return
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`Server not ready after ${timeoutMs}ms`)
}

export function startDevServer(frontendDir, scratchDir) {
  devServerLogPath = path.join(scratchDir, 'dev-server.log')
  fs.mkdirSync(scratchDir, { recursive: true })
  const startLine = stamp('Starting npm run dev -H 127.0.0.1 -p 3000')
  fs.writeFileSync(devServerLogPath, startLine + '\n', 'utf8')

  const server = spawn(
    'npm',
    ['run', 'dev', '--', '-H', '127.0.0.1', '-p', '3000'],
    {
      cwd: frontendDir,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    },
  )
  const tee = (chunk) => {
    process.stdout.write(chunk)
    appendDevServerLog(chunk.toString())
  }
  server.stdout?.on('data', tee)
  server.stderr?.on('data', tee)
  return server
}

export function readDevServerEvidence(scratchDir) {
  const logPath = path.join(scratchDir, 'dev-server.log')
  if (!fs.existsSync(logPath)) {
    return '(dev-server.log missing)\n'
  }
  return fs.readFileSync(logPath, 'utf8')
}

export function stopServer(server) {
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

export function runCommandWithLog({
  command,
  args,
  cwd,
  logPath,
  header,
  env = {},
}) {
  if (header) {
    fs.writeFileSync(logPath, header + '\n', 'utf8')
  }
  const logStream = fs.createWriteStream(logPath, { flags: header ? 'a' : 'w' })

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: true,
      env: { ...process.env, ...env },
    })

    const pipe = (chunk) => {
      process.stdout.write(chunk)
      logStream.write(chunk)
    }
    child.stdout?.on('data', pipe)
    child.stderr?.on('data', pipe)

    child.on('close', (code) => {
      logStream.end()
      if (code === 0) resolve()
      else reject(new Error(`Command failed (exit ${code}). See ${logPath}`))
    })
  })
}