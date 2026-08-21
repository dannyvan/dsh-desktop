const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

function loadStartOwnServer() {
  const filename = path.join(__dirname, '..', 'main.js')
  const source = fs.readFileSync(filename, 'utf8') + '\nmodule.exports = { startOwnServer }\n'
  const spawned = []
  const child = {
    pid: 43210,
    exitCode: null,
    stdout: { on() {} },
    stderr: { on() {} },
    on() {},
    kill() {},
  }
  const sandbox = {
    __dirname: path.dirname(filename),
    __filename: filename,
    Buffer,
    console,
    module: { exports: {} },
    process: { ...process, kill() {} },
    require(id) {
      if (id === 'electron') return { app: { whenReady: () => new Promise(() => {}), on() {} }, BrowserWindow: class {} }
      if (id === 'node:child_process') return { spawn: (...args) => { spawned.push(args); return child } }
      if (id === 'node:http') return {
        get(_options, callback) {
          const listeners = {}
          callback({
            setEncoding() {},
            on(event, listener) { listeners[event] = listener },
          })
          listeners.data('__DSH_BOOT__')
          listeners.end()
          return { on() {}, destroy() {} }
        },
      }
      if (id === 'node:fs') return { ...fs, existsSync: () => true, appendFileSync() {} }
      if (id === 'node:os') return { homedir: () => '/tmp/dsh-desktop-test' }
      return require(id)
    },
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(source, sandbox, { filename })
  return { startOwnServer: sandbox.module.exports.startOwnServer, spawned }
}

test('启动 DSH Web 时禁止额外打开默认浏览器', async () => {
  const { startOwnServer, spawned } = loadStartOwnServer()

  await startOwnServer(43123)

  assert.deepEqual(Array.from(spawned[0][1]), ['--yes', '@deepseek-ai/dsh', 'web', '--port', '43123', '--no-open'])
})
