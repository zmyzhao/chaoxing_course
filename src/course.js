const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rowLocator(page, id, fallbackIndex) {
  if (/^[a-zA-Z0-9_-]+$/.test(id || '')) return page.locator(`.posCatalog_select[id="${id}"]`).first();
  return page.locator('.posCatalog_select').nth(fallbackIndex);
}

async function findDetailPage(context, config, controller, report) {
  let opened = null;
  if (config.courseUrl) {
    opened = await context.newPage();
    try {
      await opened.goto(config.courseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch (error) {
      report.log('course_navigation_warning', { message: error.message });
    }
  } else if (context.pages().length === 0) {
    opened = await context.newPage();
  }
  process.stdout.write('请在专用 Edge 中手动登录并打开任意章节详情页；左侧目录出现后会自动继续。\n');
  const deadline = Date.now() + config.loginWaitMs;
  while (!controller.stopping && Date.now() < deadline) {
    for (const page of context.pages()) {
      if (page.isClosed()) continue;
      try {
        if (await page.locator('.posCatalog_select .posCatalog_name').count() > 0) {
          report.log('detail_page_ready', { message: '已识别章节详情页的目录结构' });
          return page;
        }
      } catch {
        // A tab may close while checking it.
      }
    }
    await sleep(1500);
  }
  if (controller.stopping) return null;
  const capturePage = opened && !opened.isClosed() ? opened : context.pages().find((page) => !page.isClosed());
  if (capturePage) await report.screenshot(capturePage, 'detail_not_found');
  throw new Error('等待章节详情页超时。请检查登录及课程链接。');
}

async function scanDirectory(page) {
  return page.locator('.posCatalog_select').evaluateAll((elements) => {
    let group = '';
    let groupId = '';
    const rows = [];
    elements.forEach((element, index) => {
      if (element.classList.contains('firstLayer')) {
        group = element.querySelector('.posCatalog_title')?.textContent?.trim() || '';
        groupId = element.id || '';
        return;
      }
      const name = element.querySelector('.posCatalog_name');
      if (!name) return;
      rows.push({
        id: element.id || '',
        elementIndex: index,
        group,
        groupId,
        title: name.getAttribute('title')?.trim() || name.textContent?.trim() || '',
        completed: Boolean(element.querySelector('.icon_Completed')),
      });
    });
    return rows;
  });
}

async function ensureVisibleAndClick(page, item) {
  const row = rowLocator(page, item.id, item.elementIndex);
  if (!await row.isVisible() && item.groupId) {
    const group = rowLocator(page, item.groupId, 0);
    await group.click({ timeout: 15000 });
  }
  await row.scrollIntoViewIfNeeded({ timeout: 15000 });
  await row.click({ timeout: 15000 });
  if (item.id) {
    await page.waitForFunction((id) => {
      const selected = document.getElementById(id);
      return selected?.classList.contains('posCatalog_active');
    }, item.id, { timeout: 10000 });
  }
  return row;
}

async function getCardsFrame(page) {
  const iframe = page.locator('iframe#iframe').first();
  await iframe.waitFor({ state: 'attached', timeout: 30000 });
  const handle = await iframe.elementHandle();
  const frame = await handle.contentFrame();
  if (!frame) throw new Error('任务内容框架尚未加载。');
  await frame.waitForLoadState('domcontentloaded', { timeout: 30000 });
  await frame.locator('body').waitFor({ state: 'attached', timeout: 30000 });
  return frame;
}

async function taskDescriptors(frame) {
  return frame.locator('.ans-attach-ct').evaluateAll((elements) => elements.map((element, index) => {
    const iframe = element.querySelector('iframe');
    const iframeClass = iframe?.className || '';
    let kind = 'other';
    if (element.querySelector('iframe.ans-insertvideo-online') || element.classList.contains('videoContainer')) kind = 'video';
    else if (/insertdoc-online-pdf/i.test(iframeClass)) kind = 'file';
    else if (/downloadfile/i.test(iframeClass)) kind = 'attachment';
    else if (/quiz|test|exam/i.test(`${element.className} ${iframeClass}`)) kind = 'quiz';
    return { index, kind, finished: element.classList.contains('ans-job-finished') };
  }));
}

async function waitForGreenCheck(page, item, controller, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (!controller.stopping && Date.now() < deadline) {
    const row = rowLocator(page, item.id, item.elementIndex);
    if (await row.locator('.icon_Completed').count() > 0) return true;
    await sleep(1000);
  }
  return false;
}

async function waitForTaskFinished(container, controller, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (!controller.stopping && Date.now() < deadline) {
    if (await container.evaluate((element) => element.classList.contains('ans-job-finished'))) return true;
    await sleep(500);
  }
  return false;
}

module.exports = {
  findDetailPage,
  scanDirectory,
  ensureVisibleAndClick,
  getCardsFrame,
  taskDescriptors,
  waitForGreenCheck,
  waitForTaskFinished,
  rowLocator,
};
