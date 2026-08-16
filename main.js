// DeepSeek Harness 轻量桌面壳（macOS）
// 职责：官方入口拉起 dsh web（默认复用 127.0.0.1:3080 现有实例），套原生窗口；
// 通过 preload 的 window.dshDesktop.getPathForFile 让页面拖拽直取 Finder 原始路径。
//
// 拉起只走 ~/.local/bin/npx --yes @deepseek-ai/dsh（官方 README 同一条）。
// 禁止扫 ~/.nvm/versions/node/v*/bin/dsh，禁止登录 zsh 找命令。
const { app, BrowserWindow } = require('electron')
const { spawn } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_PORT = 3080
const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin')
const NPX = path.join(LOCAL_BIN, 'npx')
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'DSH Desktop')
const BOOT_MARK = '__DSH_BOOT__'
const BOOT_MS = 60000
const KILL_GRACE_MS = 1500

let mainWindow = null
let serverProc = null
let killTimer = null

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(path.join(LOG_DIR, 'server.log'), line)
  } catch { /* 日志失败不阻塞 */ }
  console.log(line.trim())
}

/** 探测某端口是否已在响应 DSH 页面（含 __DSH_BOOT__ 标记）。 */
function probeDsh(port, timeout = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve(body.includes(BOOT_MARK)))
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
  })
}

function stopOwnServer() {
  if (killTimer) {
    clearTimeout(killTimer)
    killTimer = null
  }
  if (!serverProc) return
  const pid = serverProc.pid
  const child = serverProc
  serverProc = null
  if (!pid) return
  log(`停自己起的 dsh 进程组 ${pid}`)
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try { child.kill('SIGTERM') } catch { /* 已经没了 */ }
  }
  killTimer = setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL') } catch { /* 已经没了 */ }
    killTimer = null
  }, KILL_GRACE_MS)
}

/** 官方入口：~/.local/bin/npx --yes @deepseek-ai/dsh web --port N */
async function startOwnServer(port) {
  if (!fs.existsSync(NPX)) {
    throw new Error(`没有 ${NPX}。先跑 dotfiles 的 bin/install-node-toolset.sh`)
  }
  const args = ['--yes', '@deepseek-ai/dsh', 'web', '--port', String(port)]
  const env = {
    ...process.env,
    PATH: `${LOCAL_BIN}:/usr/bin:/bin:/usr/sbin:/sbin`,
  }
  log(`启动 ${NPX} ${args.join(' ')}`)
  const child = spawn(NPX, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    detached: true,
  })
  child.stdout.on('data', (d) => log('dsh: ' + String(d).trim()))
  child.stderr.on('data', (d) => log('dsh: ' + String(d).trim()))
  child.on('exit', (code) => { log('dsh 进程退出，code=' + code) })
  serverProc = child
  const deadline = Date.now() + BOOT_MS
  while (Date.now() < deadline) {
    if (await probeDsh(port, 1000)) return
    if (child.exitCode != null) {
      throw new Error(`npx @deepseek-ai/dsh 提前退出，code=${child.exitCode}`)
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  stopOwnServer()
  throw new Error(`dsh web 在 ${port} 端口 ${BOOT_MS / 1000}s 内未就绪`)
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness',
    backgroundColor: '#111114',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 需要 require('electron')
    },
  })

  // 壳内一律不弹外部浏览器窗口：页面里任何 window.open 都被拦截，
  // 避免 DSH 页面自动弹出的外部链接每次都在系统浏览器里新开标签。
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, u) => {
    if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(u)) e.preventDefault()
  })
  mainWindow.webContents.on('will-navigate', (e, u) => {
    if (u.startsWith('file://')) e.preventDefault()
  })

  mainWindow.loadURL(url)
  mainWindow.on('closed', () => {
    mainWindow = null
    stopOwnServer()
    app.quit()
  })
}

app.whenReady().then(async () => {
  try {
    let url = null
    for (const port of [DEFAULT_PORT, DEFAULT_PORT + 1, DEFAULT_PORT + 2]) {
      if (await probeDsh(port)) {
        url = `http://127.0.0.1:${port}`
        log(`复用已有实例 ${url}（关窗不会停这份服务）`)
        break
      }
    }
    if (!url) {
      await startOwnServer(DEFAULT_PORT)
      url = `http://127.0.0.1:${DEFAULT_PORT}`
    }
    log('加载 ' + url)
    createWindow(url)
  } catch (err) {
    log('启动失败: ' + String(err && err.message || err))
    createWindow(`data:text/html;charset=utf-8,${encodeURIComponent(
      `<h2 style="font-family:system-ui;color:#ddd">DSH Desktop 启动失败</h2>
       <pre style="font-family:monospace;color:#f88">${String(err && err.message || err)}</pre>
       <p style="font-family:system-ui;color:#aaa">需要 <code>~/.local/bin/npx</code>（跑 dotfiles 的 <code>bin/install-node-toolset.sh</code>）。</p>`,
    )}`)
  }
})

app.on('before-quit', () => {
  stopOwnServer()
})

app.on('window-all-closed', () => {
  stopOwnServer()
  app.quit()
})
