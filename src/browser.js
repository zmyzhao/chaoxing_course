const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright-core');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findEdge(configured) {
  const candidates = [
    configured,
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('未找到 Microsoft Edge。请在 config.local.json 中填写 edgeExecutable。');
  return found;
}

async function endpointFromProfile(profileDir) {
  const portFile = path.join(profileDir, 'DevToolsActivePort');
  if (!fs.existsSync(portFile)) return null;
  const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const endpoint = `http://127.0.0.1:${port}`;
  try {
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1500) });
    return response.ok ? endpoint : null;
  } catch {
    return null;
  }
}

async function openDedicatedEdge(config, report) {
  fs.mkdirSync(config.profileDir, { recursive: true });
  let endpoint = await endpointFromProfile(config.profileDir);
  if (endpoint) {
    report.log('edge_reused', { message: '连接已运行的专用 Edge 窗口' });
  } else {
    const edge = findEdge(config.edgeExecutable);
    const args = [
      '--new-window',
      '--no-first-run',
      '--mute-audio',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      `--user-data-dir=${config.profileDir}`,
      'about:blank',
    ];
    const child = spawn(edge, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    report.log('edge_started', { message: '已启动使用独立配置的 Edge', processId: child.pid });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !endpoint) {
      endpoint = await endpointFromProfile(config.profileDir);
      if (!endpoint) await sleep(350);
    }
    if (!endpoint) throw new Error('专用 Edge 启动失败或未开放本地调试连接。浏览器窗口可能受到当前环境限制。');
  }
  const browser = await chromium.connectOverCDP(endpoint, { timeout: 20000 });
  const context = browser.contexts()[0];
  if (!context) throw new Error('无法取得专用 Edge 的浏览器上下文。');
  context.setDefaultTimeout(15000);
  return { browser, context };
}

module.exports = { openDedicatedEdge };
