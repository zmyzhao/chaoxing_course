const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { openDedicatedEdge } = require('./browser');
const { RunReport } = require('./report');
const { playVideo, pauseActiveVideo } = require('./player');
const { finishPdfByScrolling } = require('./document');
const {
  findDetailPage,
  scanDirectory,
  ensureVisibleAndClick,
  getCardsFrame,
  taskDescriptors,
  waitForGreenCheck,
  waitForTaskFinished,
  rowLocator,
} = require('./course');

const projectDir = path.resolve(__dirname, '..');

function usage() {
  process.stdout.write([
    '用法：node src/index.js [--config config.local.json] [--url 课程链接] [--list]',
    '首次使用：在专用 Edge 中手动登录并打开任意章节详情页。',
    '--list 只读取目录及完成标志，不打开任务或播放视频。',
  ].join('\n') + '\n');
}

function parseArgs(argv) {
  const options = { configFile: 'config.local.json', courseUrl: '', listOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--list') options.listOnly = true;
    else if (arg === '--config') options.configFile = argv[++index];
    else if (arg === '--url') options.courseUrl = argv[++index];
    else throw new Error(`未知参数：${arg}`);
  }
  if (!options.configFile || options.courseUrl === undefined) throw new Error('参数缺少值。');
  return options;
}

function loadConfig(options) {
  const examplePath = path.join(projectDir, 'config.example.json');
  const selectedPath = path.resolve(projectDir, options.configFile);
  const configPath = fs.existsSync(selectedPath) ? selectedPath : examplePath;
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const resolveLocal = (value) => path.resolve(projectDir, value);
  const courseUrl = options.courseUrl || raw.courseUrl || '';
  if (courseUrl && !/^https:\/\//i.test(courseUrl)) throw new Error('courseUrl 必须是 HTTPS 链接，或留空后手动打开页面。');
  return {
    courseUrl,
    edgeExecutable: raw.edgeExecutable || '',
    profileDir: resolveLocal(raw.profileDir || 'data/edge-profile'),
    runsDir: resolveLocal(raw.runsDir || 'runs'),
    loginWaitMs: Math.max(1, Number(raw.loginWaitMinutes) || 10) * 60000,
    stallMs: Math.max(1, Number(raw.stallMinutes) || 2) * 60000,
  };
}

async function processDirectory(page, controller, report) {
  const items = await scanDirectory(page);
  report.log('directory_scanned', { rows: items.length, completed: items.filter((item) => item.completed).length });
  if (!items.length) throw new Error('章节详情页没有可识别的目录行。');

  for (const [ordinal, item] of items.entries()) {
    if (controller.stopping) break;
    const result = {
      group: item.group,
      title: item.title,
      status: 'pending',
      videos: 0,
      files: 0,
      otherTasks: 0,
      otherTaskResults: [],
      taskResults: [],
      message: '',
    };
    const label = `row-${ordinal + 1}`;
    report.log('row_started', { ordinal: ordinal + 1, group: item.group, title: item.title });
    if (item.completed || await rowLocator(page, item.id, item.elementIndex).locator('.icon_Completed').count() > 0) {
      result.status = 'skipped_completed';
      result.message = '目录行已有绿色对勾';
      report.addRow(result);
      continue;
    }

    try {
      const iframe = page.locator('iframe#iframe').first();
      const oldSrc = await iframe.count() ? await iframe.getAttribute('src') : null;
      const wasActive = await rowLocator(page, item.id, item.elementIndex).evaluate((element) => element.classList.contains('posCatalog_active'));
      await ensureVisibleAndClick(page, item);
      if (oldSrc && !wasActive) {
        await page.waitForFunction((previous) => {
          const current = document.querySelector('iframe#iframe')?.getAttribute('src');
          return current && current !== previous;
        }, oldSrc, { timeout: 15000 });
      }
      const cardsFrame = await getCardsFrame(page);
      const tasks = await taskDescriptors(cardsFrame);
      result.videos = tasks.filter((task) => task.kind === 'video').length;
      result.files = tasks.filter((task) => task.kind === 'file').length;
      result.otherTasks = tasks.length - result.videos;
      if (!result.videos && !result.files) {
        for (const task of tasks) {
          const detail = { position: task.index + 1, kind: task.kind, alreadyFinished: task.finished, action: 'skipped' };
          result.otherTaskResults.push(detail);
          report.log('other_task_skipped', { row: label, ...detail });
        }
        result.status = 'skipped_no_supported_tasks';
        result.message = '该目录项没有可处理的视频或文件任务';
        continue;
      }

      for (const task of tasks) {
        if (controller.stopping) break;
        const container = cardsFrame.locator('.ans-attach-ct').nth(task.index);
        const taskLabel = `${label}-task-${task.index + 1}`;
        if (task.kind === 'file') {
          const detail = { position: task.index + 1, kind: 'file', alreadyFinished: task.finished, action: task.finished ? 'already_finished' : 'pending' };
          result.otherTaskResults.push(detail);
          if (task.finished) {
            report.log('file_skipped_finished', { row: label, position: task.index + 1 });
            continue;
          }
          const outcome = await finishPdfByScrolling(container, controller, report, taskLabel);
          detail.action = outcome.status;
          detail.pages = outcome.pages;
          if (controller.stopping) break;
          if (!await waitForTaskFinished(container, controller, 30000)) throw new Error(`第 ${task.index + 1} 个文件已到末页，但 30 秒内未显示任务完成。`);
          detail.action = 'completed';
          report.log('file_task_finished', { row: label, position: task.index + 1, pages: outcome.pages });
          continue;
        }
        if (task.kind !== 'video') {
          const detail = { position: task.index + 1, kind: task.kind, alreadyFinished: task.finished, action: 'skipped' };
          result.otherTaskResults.push(detail);
          report.log('other_task_skipped', { row: label, ...detail });
          continue;
        }
        if (task.finished) {
          result.taskResults.push({ position: task.index + 1, status: 'already_finished' });
          report.log('video_skipped_finished', { row: label, position: task.index + 1 });
          continue;
        }
        const outcome = await playVideo(container, controller, report, taskLabel);
        const detail = { position: task.index + 1, status: outcome.status, method: outcome.method, attempts: [outcome.status] };
        result.taskResults.push(detail);
        if (controller.stopping) break;
        let finished = await waitForTaskFinished(container, controller, outcome.method === 'seek' ? 10000 : 30000);
        if (controller.stopping) break;
        if (!finished) {
          report.log('video_natural_fallback_started', {
            row: label,
            position: task.index + 1,
            reason: outcome.method === 'seek' ? '快进播放结束后任务未完成' : '首次播放结束后任务未完成',
          });
          const fallback = await playVideo(container, controller, report, taskLabel, 'natural');
          detail.method = 'natural';
          detail.status = fallback.status;
          detail.attempts.push(fallback.status);
          if (controller.stopping) break;
          finished = await waitForTaskFinished(container, controller, 30000);
        }
        if (controller.stopping) break;
        if (!finished) throw new Error(`第 ${task.index + 1} 个视频快进与 2× 完整播放后仍未显示任务完成。`);
        detail.status = 'completed';
        report.log('video_task_finished', { row: label, position: task.index + 1, method: detail.method });
      }
      if (controller.stopping) {
        result.status = 'stopped';
        result.message = '收到 Ctrl+C，已安全停止';
      } else if (await waitForGreenCheck(page, item, controller, 60000)) {
        result.status = 'completed';
        result.message = '对应目录行出现绿色对勾';
      } else {
        const skipped = result.otherTaskResults.filter((task) => task.action === 'skipped').length;
        result.status = controller.stopping ? 'stopped' : 'row_unconfirmed';
        result.message = controller.stopping
          ? '收到 Ctrl+C，已安全停止'
          : skipped
            ? `视频和文件已按页面操作完成；另有 ${skipped} 个其他任务被跳过，60 秒内目录未出现绿色对勾`
            : '视频和文件任务处理后 60 秒内目录未出现绿色对勾';
        if (!controller.stopping) result.screenshot = await report.screenshot(page, `${label}-check-timeout`);
      }
    } catch (error) {
      if (controller.stopping) {
        result.status = 'stopped';
        result.message = '收到 Ctrl+C，已安全停止';
      } else {
        result.status = 'error';
        result.message = error.message;
        result.screenshot = await report.screenshot(page, `${label}-error`);
      }
    } finally {
      await pauseActiveVideo(controller.active);
      controller.active = null;
      report.addRow(result);
    }
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    if (options.help) return usage();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    usage();
    process.exitCode = 2;
    return;
  }
  const config = loadConfig(options);
  const report = new RunReport(config.runsDir);
  const controller = { stopping: false, active: null, stallMs: config.stallMs };
  const requestStop = () => {
    if (!controller.stopping) {
      controller.stopping = true;
      report.log('stop_requested', { message: '收到 Ctrl+C，正在暂停当前视频并写入报告' });
    }
  };
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop);
  if (process.platform === 'win32') process.on('SIGBREAK', requestStop);
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', (_character, key) => {
      if (key?.ctrl && key.name === 'c') requestStop();
    });
    process.stdin.resume();
  }

  let page = null;
  let exitCode = 0;
  let edgeConnected = false;
  try {
    const { context } = await openDedicatedEdge(config, report);
    edgeConnected = true;
    page = await findDetailPage(context, config, controller, report);
    if (page && options.listOnly) {
      const items = await scanDirectory(page);
      for (const item of items) report.addRow({ group: item.group, title: item.title, status: item.completed ? 'completed' : 'pending' });
    } else if (page) {
      await processDirectory(page, controller, report);
    }
  } catch (error) {
    report.log('fatal_error', { message: error.message });
    if (page && !page.isClosed()) await report.screenshot(page, 'fatal-error');
    exitCode = 1;
  } finally {
    await pauseActiveVideo(controller.active);
    const rowFailures = report.rows.some((row) => ['error', 'timeout', 'row_unconfirmed'].includes(row.status));
    const status = controller.stopping ? 'stopped' : exitCode ? 'failed' : rowFailures ? 'finished_with_errors' : 'finished';
    const outputs = report.finish(status, { edgeWindowPreserved: edgeConnected });
    process.stdout.write(`报告：${outputs.mdPath}\n${edgeConnected ? 'Edge 窗口将保持打开。' : '未能连接专用 Edge。'}\n`);
    // Edge was started as an independent process. Exiting disconnects the
    // automation client without closing the visible browser window.
    process.exit(controller.stopping ? 130 : exitCode);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
