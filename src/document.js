const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function contentFrameFor(iframe, label) {
  await iframe.waitFor({ state: 'attached', timeout: 30000 });
  const handle = await iframe.elementHandle();
  const frame = await handle.contentFrame();
  if (!frame) throw new Error(`${label}尚未加载。`);
  return frame;
}

async function finishPdfByScrolling(container, controller, report, label) {
  const pdfFrame = await contentFrameFor(container.locator('iframe[class*="insertdoc"]').first(), '文件预览');
  const documentFrame = await contentFrameFor(pdfFrame.locator('iframe#panView').first(), '文件正文');
  await documentFrame.locator('body').waitFor({ state: 'visible', timeout: 30000 });
  const before = await documentFrame.evaluate(() => ({
    pages: document.querySelectorAll('li[id^="anchor"]').length,
    scrollY: window.scrollY,
    scrollMax: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
  }));
  if (!before.pages) throw new Error('文件预览中未识别到页面，无法确认已到末页。');
  report.log('file_loaded', { label, pages: before.pages });
  if (controller.stopping) return { status: 'stopped', pages: before.pages };

  // Give the document keyboard focus, then use its normal End shortcut.
  await documentFrame.locator('body').click({ position: { x: 400, y: 200 }, timeout: 15000 });
  await documentFrame.page().keyboard.press('Control+End');
  const deadline = Date.now() + 10000;
  let after;
  do {
    after = await documentFrame.evaluate(() => ({
      scrollY: window.scrollY,
      scrollMax: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
    }));
    if (after.scrollY >= after.scrollMax - 5) break;
    await sleep(250);
  } while (!controller.stopping && Date.now() < deadline);
  if (controller.stopping) return { status: 'stopped', pages: before.pages };
  if (after.scrollY < after.scrollMax - 5) throw new Error('已按文件页面的末尾快捷键，但没有到达末页。');

  report.log('file_last_page_reached', { label, pages: before.pages });
  return { status: 'last_page_reached', pages: before.pages };
}

module.exports = { finishPdfByScrolling };
