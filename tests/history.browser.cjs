const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const baseURL = process.env.UI_BASE_URL || 'http://127.0.0.1:3211';
const output = path.resolve('Temp/history-qa');
fs.mkdirSync(output, { recursive: true });

const now = Math.floor(Date.now() / 1000);
const project = {
  id: 'project-alpha',
  name: 'Alpha 游戏项目',
  roots: ['E:/Games/Alpha'],
  active_thread_count: 2,
  archived_thread_count: 1,
  recency_at: now - 60,
};
const threads = [
  {
    id: 'thread-active', title: '修复排行榜结算异常', cwd: 'E:/Games/Alpha',
    project_id: project.id, source_kind: 'appServer', status: 'idle', active_flags: [],
    created_at: now - 7200, updated_at: now - 60, recency_at: now - 60,
    archived: false, descendant_count: 2, can_mutate: true,
  },
  {
    id: 'thread-vscode', title: '优化启动页加载速度', cwd: 'E:/Games/Alpha/client',
    project_id: project.id, source_kind: 'vscode', status: 'notLoaded', active_flags: [],
    created_at: now - 172800, updated_at: now - 3600, recency_at: now - 3600,
    archived: false, descendant_count: 0, can_mutate: true,
  },
  {
    id: 'thread-unassigned', title: '整理发布检查清单', cwd: 'E:/Notes',
    project_id: null, source_kind: 'cli', status: 'active', active_flags: ['waitingOnUserInput'],
    created_at: now - 300000, updated_at: now - 86400, recency_at: now - 86400,
    archived: false, descendant_count: 0, can_mutate: false,
  },
];

function overview(mode, archived = false) {
  const data = mode.value === 'empty'
    ? []
    : archived
      ? [{ ...threads[1], id: 'thread-archived', title: '旧版资源检查', archived: true }]
      : threads;
  return {
    capabilities: {
      available: true, cli_version: '0.153.4', cli_path: 'codex.exe',
      codex_home: 'C:/Users/Test/.codex', project_management: true,
      minimum_cli_version: '0.153.4',
    },
    totals: { projects: 1, active_threads: mode.value === 'empty' ? 0 : 3, archived_threads: 1 },
    projects: mode.value === 'empty' ? [] : [project],
    threads: data,
    filtered_count: data.length,
    next_cursor: null,
  };
}

async function installFixtures(context, mode) {
  await context.route('**/api/invoke/*', async route => {
    const command = route.request().url().split('/').pop();
    const args = route.request().postDataJSON() || {};
    let payload;
    switch (command) {
      case 'list_accounts': payload = []; break;
      case 'get_masked_account_ids': payload = []; break;
      case 'check_codex_processes': payload = mode.value === 'blocked'
        ? { count: 1, background_count: 0, can_switch: false, pids: [4242] }
        : { count: 0, background_count: 0, can_switch: true, pids: [] }; break;
      case 'get_display_settings': payload = { tray_display_mode: 'icon_and_session', dock_display_mode: null }; break;
      case 'get_dock_display_mode': payload = null; break;
      case 'report_usage': payload = null; break;
      case 'cancel_login': payload = null; break;
      case 'get_history_capabilities': payload = overview(mode).capabilities; break;
      case 'list_history_overview':
        if (mode.value === 'error') {
          await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Codex app server unavailable' }) });
          return;
        }
        payload = overview(mode, args.query?.archived === true);
        break;
      case 'mutate_sessions':
        if (mode.value === 'blocked') {
          await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Cannot manage Codex history while 1 Codex process is running' }) });
          return;
        }
        if (mode.value === 'partial') {
          payload = {
            total: args.actions.length, succeeded: 1, failed: args.actions.length - 1,
            warning: 'Timed out waiting for Codex app server to stop.',
            results: args.actions.map((action, index) => ({
              thread_id: action.threadId, action: action.action, success: index === 0,
              skipped_descendant: false, error: index === 0 ? null : 'Write lock conflict',
            })),
          };
          break;
        }
        payload = {
          total: args.actions.length, succeeded: args.actions.length, failed: 0,
          results: args.actions.map(action => ({
            thread_id: action.threadId, action: action.action, success: true,
            skipped_descendant: false, error: null,
          })),
        };
        break;
      case 'mutate_project': payload = { project_id: args.action.projectId, success: true }; break;
      default: throw new Error(`Unexpected backend call: ${command}`);
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
}

async function assertViewport(page, name) {
  const viewport = page.viewportSize();
  const geometry = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
  }));
  assert.ok(geometry.width <= viewport.width, `${name}: horizontal overflow ${geometry.width}/${viewport.width}`);
  await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const report = [];
  try {
    for (const viewport of [{ width: 900, height: 700 }, { width: 600, height: 500 }]) {
      const context = await browser.newContext({ viewport, locale: 'zh-CN', deviceScaleFactor: 1 });
      const mode = { value: 'list' };
      await installFixtures(context, mode);
      await context.addInitScript(() => localStorage.setItem('codex-switcher-language', 'zh'));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(String(error)));
      await page.goto(`${baseURL}/?historyFixture=1`);
      await page.getByRole('button', { name: '会话管理', exact: true }).click();
      await page.getByText('修复排行榜结算异常', { exact: true }).waitFor();
      await assertViewport(page, `zh-history-list-${viewport.width}`);

      await page.getByRole('button', { name: '修复排行榜结算异常的更多操作', exact: true }).click();
      await page.getByRole('button', { name: '永久删除', exact: true }).click();
      await page.getByRole('dialog', { name: '永久删除会话？' }).waitFor();
      assert.match(await page.getByRole('dialog').innerText(), /2 个派生会话/);
      await assertViewport(page, `zh-history-delete-${viewport.width}`);
      await page.getByRole('button', { name: '取消', exact: true }).click();

      if (viewport.width < 768) {
        await page.getByRole('combobox', { name: '项目' }).selectOption(`project:${project.id}`);
      }
      await page.getByRole('button', { name: '移除 Alpha 游戏项目', exact: true }).click();
      await page.getByRole('dialog', { name: '移除项目？' }).waitFor();
      assert.match(await page.getByRole('dialog').innerText(), /不会删除代码目录/);
      await assertViewport(page, `zh-history-remove-project-${viewport.width}`);
      await page.getByRole('button', { name: '取消', exact: true }).click();

      await page.getByLabel('选择修复排行榜结算异常').check();
      await page.getByRole('button', { name: '批量归档', exact: true }).click();
      await page.getByRole('dialog', { name: '归档所选会话？' }).waitFor();
      await assertViewport(page, `zh-history-bulk-archive-${viewport.width}`);
      await page.getByRole('button', { name: '取消', exact: true }).click();

      if (viewport.width === 900) {
        await page.getByLabel('选择修复排行榜结算异常').check();
        await page.getByLabel('选择优化启动页加载速度').check();
        await page.getByRole('button', { name: '批量归档', exact: true }).click();
        mode.value = 'partial';
        await page.getByRole('dialog', { name: '归档所选会话？' }).getByRole('button', { name: '批量归档', exact: true }).click();
        await page.getByText(/成功：修复排行榜结算异常。失败：优化启动页加载速度: Write lock conflict。/).waitFor();
        await page.getByText(/修改已完成，但停止 Codex App Server 失败/).waitFor();
        await assertViewport(page, 'zh-history-partial-failure-900');

        mode.value = 'blocked';
        await page.getByRole('button', { name: '修复排行榜结算异常的更多操作', exact: true }).click();
        await page.getByRole('button', { name: '归档', exact: true }).click();
        await page.getByRole('dialog', { name: '关闭 Codex 后继续？' }).waitFor();
        await assertViewport(page, 'zh-history-process-block-900');
        await page.getByRole('button', { name: '取消', exact: true }).click();
        mode.value = 'list';
      }

      mode.value = 'empty';
      await page.getByRole('button', { name: '刷新会话', exact: true }).click();
      await page.getByText('暂无会话', { exact: true }).waitFor();
      await assertViewport(page, `zh-history-empty-${viewport.width}`);

      mode.value = 'error';
      await page.getByRole('button', { name: '刷新会话', exact: true }).click();
      await page.getByText('Codex app server unavailable', { exact: true }).waitFor();
      await assertViewport(page, `zh-history-error-${viewport.width}`);
      assert.deepEqual(errors, []);
      report.push({ viewport, errors });
      await context.close();
    }

    const context = await browser.newContext({ viewport: { width: 900, height: 700 }, locale: 'en-US' });
    const mode = { value: 'list' };
    await installFixtures(context, mode);
    await context.addInitScript(() => {
      localStorage.setItem('codex-switcher-language', 'en');
      localStorage.setItem('codex-switcher-theme', 'dark');
    });
    const page = await context.newPage();
    await page.goto(`${baseURL}/?historyFixture=1`);
    await page.getByRole('button', { name: 'Sessions', exact: true }).click();
    await page.getByText('Fix leaderboard settlement', { exact: true }).waitFor({ timeout: 1000 }).catch(() => {});
    await page.getByText('修复排行榜结算异常', { exact: true }).waitFor();
    await assertViewport(page, 'en-dark-history-list-900');
    await context.close();

    const webContext = await browser.newContext({ viewport: { width: 900, height: 700 }, locale: 'zh-CN' });
    const webMode = { value: 'list' };
    await installFixtures(webContext, webMode);
    await webContext.addInitScript(() => localStorage.setItem('codex-switcher-language', 'zh'));
    const webPage = await webContext.newPage();
    await webPage.goto(baseURL);
    assert.equal(await webPage.getByRole('button', { name: '会话管理', exact: true }).count(), 0);
    await webContext.close();
  } finally {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ baseURL, fixture: true, report }, null, 2));
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
