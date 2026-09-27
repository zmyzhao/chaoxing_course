const fs = require('node:fs');
const path = require('node:path');

function safeText(value) {
  return String(value ?? '')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}[参数已隐藏]`;
      } catch {
        return '[链接已隐藏]';
      }
    })
    .replace(/[\r\n]+/g, ' ');
}

function clean(value) {
  if (typeof value === 'string') return safeText(value);
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
  }
  return value;
}

class RunReport {
  constructor(runsDir) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.dir = path.join(runsDir, stamp);
    this.shotsDir = path.join(this.dir, 'screenshots');
    fs.mkdirSync(this.shotsDir, { recursive: true });
    this.startedAt = new Date().toISOString();
    this.rows = [];
    this.status = 'running';
    this.eventsPath = path.join(this.dir, 'events.jsonl');
  }

  log(type, details = {}) {
    const entry = clean({ at: new Date().toISOString(), type, ...details });
    fs.appendFileSync(this.eventsPath, `${JSON.stringify(entry)}\n`, 'utf8');
    const suffix = entry.message ? `: ${entry.message}` : '';
    process.stdout.write(`[${entry.at}] ${type}${suffix}\n`);
  }

  addRow(row) {
    this.rows.push(clean(row));
    this.log('row_result', row);
  }

  async screenshot(page, label) {
    const filename = `${String(this.rows.length + 1).padStart(3, '0')}-${label.replace(/[^a-z0-9_-]/gi, '_')}.png`;
    const target = path.join(this.shotsDir, filename);
    try {
      await page.screenshot({ path: target, fullPage: true, timeout: 15000 });
      this.log('screenshot', { file: path.relative(this.dir, target) });
      return path.relative(this.dir, target);
    } catch (error) {
      this.log('screenshot_failed', { message: error.message });
      return null;
    }
  }

  finish(status, extra = {}) {
    this.status = status;
    const counts = {};
    for (const row of this.rows) counts[row.status] = (counts[row.status] || 0) + 1;
    const result = clean({
      status,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      counts,
      rows: this.rows,
      ...extra,
    });
    const jsonPath = path.join(this.dir, 'report.json');
    const mdPath = path.join(this.dir, 'report.md');
    fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    const escapeCell = (text) => safeText(text).replace(/\|/g, '\\|');
    const lines = [
      '# 课程视频运行报告',
      '',
      `- 结果：${status}`,
      `- 开始：${result.startedAt}`,
      `- 结束：${result.finishedAt}`,
      `- 统计：${Object.entries(counts).map(([key, count]) => `${key} ${count}`).join('；') || '无目录行'}`,
      '',
      '| 序号 | 周/分组 | 章节或知识点 | 结果 | 视频 | 文件 | 非视频任务 | 说明 |',
      '| ---: | --- | --- | --- | ---: | ---: | ---: | --- |',
    ];
    for (const [index, row] of this.rows.entries()) {
      lines.push(`| ${index + 1} | ${escapeCell(row.group)} | ${escapeCell(row.title)} | ${escapeCell(row.status)} | ${row.videos ?? 0} | ${row.files ?? 0} | ${row.otherTasks ?? 0} | ${escapeCell(row.message)} |`);
    }
    fs.writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8');
    this.log('run_finished', { status, counts, report: mdPath });
    return { jsonPath, mdPath };
  }
}

module.exports = { RunReport, safeText };
