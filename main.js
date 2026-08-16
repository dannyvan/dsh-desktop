// DeepSeek Harness 轻量桌面壳（macOS）
// 职责：查找/启动 dsh web（默认复用 127.0.0.1:3080 现有实例），套原生窗口；
// 通过 preload 的 window.dshDesktop.getPathForFile 让页面拖拽直取 Finder 原始路径。
const { app, BrowserWindow, shell } = require('electron')
const { spawn, execFile } = require('node:child_process')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_PORT = 3080
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'DSH Desktop')
const BOOT_MARK = '__DSH_BOOT__'

let mainWindow = null
let serverProc = null
let startedPort = null

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

/** 用登录 shell（zsh）解析用户的真实 PATH —— .app 启动时 PATH 是精简的，nvm 等工具不在里面。 */
function resolveShellPath() {
  return new Promise((resolve) => {
    execFile('/bin/zsh', ['-lc', 'echo -n "$PATH"'], (err, stdout) => {
      if (err || !stdout || !stdout.trim()) return resolve(null)
      resolve(stdout.trim())
    })
  })
}

/**
 * 找 dsh CLI 的绝对路径；找不到时回退到 npx 的绝对路径。
 * 返回 { kind: 'cli'|'npx', path } 或 null。
 */
function findDshCli(shellPath) {
  const run = (cmd) => new Promise((resolve) => {
    const env = shellPath ? { ...process.env, PATH: `${shellPath}:${process.env.PATH || ''}` } : process.env
    execFile('/bin/zsh', ['-lc', `command -v ${cmd}`], { env }, (err, stdout) => {
      if (err || !stdout || !stdout.trim()) return resolve(null)
      resolve(stdout.trim().split('\n')[0])
    })
  })
  return run('dsh').then((cli) => {
    if (cli) return { kind: 'cli', path: cli }
    return run('npx').then((npx) => npx ? { kind: 'npx', path: npx } : null)
  })
}

/** 自起一个 dsh web 实例，轮询直到就绪。优先 dsh CLI，回退 npx 自动获取。 */
async function startOwnServer(port) {
  const shellPath = await resolveShellPath()
  const found = await findDshCli(shellPath)
  if (!found) throw new Error('未找到 dsh 或 npx，请先安装 @deepseek-ai/dsh（npm i -g @deepseek-ai/dsh）')
  // DSH_NO_OPEN=1：本机的 ~/.local/bin/dsh 是自定义包装，会自动 open 浏览器；
  // 壳自己开窗口，不需要它再弹系统浏览器。
  const env = { ...process.env, DSH_NO_OPEN: '1' }
  if (shellPath) env.PATH = `${shellPath}:${env.PATH || ''}`
  let argv
  if (found.kind === 'cli') {
    argv = [found.path, 'web', '--port', String(port)]
  } else {
    log(`PATH 中未找到 dsh，回退 npx（${found.path}）自动获取，首次需联网`)
    argv = [found.path, '--yes', '@deepseek-ai/dsh', 'web', '--port', String(port)]
  }
  const child = spawn(argv[0], argv.slice(1), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
  child.stdout.on('data', (d) => log('dsh: ' + String(d).trim()))
  child.stderr.on('data', (d) => log('dsh: ' + String(d).trim()))
  child.on('exit', (code) => { log('dsh 进程退出，code=' + code) })
  serverProc = child
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (await probeDsh(port, 1000)) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`dsh web 在 ${port} 端口 30s 内未就绪`)
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
  // 页面里丢了文件也没兜住时，阻止窗口直接打开文件
  mainWindow.webContents.on('will-navigate', (e, u) => {
    if (u.startsWith('file://')) e.preventDefault()
  })

  mainWindow.loadURL(url)
  mainWindow.on('closed', () => {
    mainWindow = null
    if (serverProc) { serverProc.kill(); serverProc = null }
    app.quit()
  })
}

app.whenReady().then(async () => {
  try {
    let url = null
    // 1) 复用现有实例（3080 及其后几个端口都试一下）
    for (const port of [DEFAULT_PORT, DEFAULT_PORT + 1, DEFAULT_PORT + 2]) {
      if (await probeDsh(port)) { url = `http://127.0.0.1:${port}`; break }
    }
    // 2) 没有现成实例 → 自己启动
    if (!url) {
      startedPort = DEFAULT_PORT
      await startOwnServer(startedPort)
      url = `http://127.0.0.1:${startedPort}`
    }
    log('加载 ' + url)
    createWindow(url)
  } catch (err) {
    log('启动失败: ' + String(err && err.message || err))
    // 失败也弹一个窗口显示错误
    createWindow(`data:text/html;charset=utf-8,${encodeURIComponent(
      `<h2 style="font-family:system-ui;color:#ddd">DSH Desktop 启动失败</h2>
       <pre style="font-family:monospace;color:#f88">${String(err && err.message || err)}</pre>
       <p style="font-family:system-ui;color:#aaa">请确认 dsh 已安装（<code>dsh --version</code>）。</p>`,
    )}`)
  }
})

app.on('window-all-closed', () => {
  if (serverProc) { serverProc.kill(); serverProc = null }
  app.quit()
})
