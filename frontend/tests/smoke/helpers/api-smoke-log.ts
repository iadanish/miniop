import fs from 'node:fs'
import path from 'node:path'

const defaultScratch =
  'C:/Users/izhar/AppData/Local/Temp/grok-goal-ed122ecafab6/implementer'

export function getApiSmokeLogPath() {
  return (
    process.env.API_SMOKE_LOG_PATH ??
    path.join(defaultScratch, 'api-smoke.log')
  )
}

export function initApiSmokeLog() {
  const logPath = getApiSmokeLogPath()
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  const header = [
    `[${new Date().toISOString()}] API CRUD via Playwright request fixture`,
    `log: ${logPath}`,
    '',
  ].join('\n')
  fs.writeFileSync(logPath, header, 'utf8')
  return logPath
}

export function appendApiSmokeLog(line: string) {
  const logPath = getApiSmokeLogPath()
  fs.appendFileSync(logPath, line + '\n', 'utf8')
  console.log(line)
}