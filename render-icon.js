// 一次性工具：用 Chromium 离屏渲染 SVG 图标 → PNG（比 qlmanage 可靠）
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')

const input = process.argv[2]
const output = process.argv[3]

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 1024,
      height: 1024,
      show: false,
      webPreferences: { offscreen: true },
    })
    await win.loadURL('file://' + input)
    // 等布局/字体稳定
    await new Promise((r) => setTimeout(r, 600))
    const image = await win.webContents.capturePage()
    fs.writeFileSync(output, image.toPNG())
    console.log('rendered:', output, image.getSize())
  } catch (err) {
    console.error('render failed:', err)
    process.exitCode = 1
  } finally {
    app.quit()
  }
})
