// Real browser regression: native chooser focus can arrive before its file change.
// Uses a synthetic empty JSON file, never a real account credential.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const baseURL = process.env.UI_BASE_URL || 'http://127.0.0.1:1420';
const output = path.resolve('Temp/file-picker-qa');
fs.mkdirSync(output, {recursive:true});

(async () => {
  const browser = await chromium.launch({headless:true});
  try {
    for (const viewport of [{width:1000,height:800},{width:375,height:667}]) {
    const context = await browser.newContext({locale:'zh-CN',viewport,isMobile:viewport.width<600,hasTouch:viewport.width<600});
    const page = await context.newPage();
    await page.goto(baseURL);
    await page.getByRole('button', {name:'账号 ▾',exact:true}).click();
    await page.getByRole('button', {name:'+ 添加账号',exact:true}).click();
    await page.getByRole('button', {name:'导入文件',exact:true}).click();
    await page.getByRole('button', {name:'导入',exact:true}).click();
    await page.getByText('请选择 auth.json 文件',{exact:true}).waitFor();
    const chooserReady = page.waitForEvent('filechooser');
    await page.getByRole('button', {name:'浏览…',exact:true}).click();
    const chooser = await chooserReady;
    const beforeFocus = await page.locator('input[type="file"]').count();
    // Reproduce the native dialog returning focus before file selection is delivered.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 20)));
    const afterFocus = await page.locator('input[type="file"]').count();
    assert.equal(beforeFocus,1);
    let selectionError;
    try {
      await chooser.setFiles({name:'auth-picker-test.json',mimeType:'application/json',buffer:Buffer.from('{}')});
    } catch (error) { selectionError = error.message; }
    await page.screenshot({path:path.join(output,`selection-${viewport.width}.png`),animations:'disabled'});
    assert.ok(await page.getByText('auth-picker-test.json',{exact:true}).isVisible(),
      'Selected file did not appear after focus returned. '+(selectionError || ''));
    assert.equal(afterFocus,1,'Focus alone must not settle the picker');
    assert.equal(await page.getByText('请选择 auth.json 文件',{exact:true}).count(),0,'Valid selection should clear the previous validation error');
    assert.equal(await page.locator('input[type="file"]').count(),0,'Picker should be cleaned up after selection');

    const cancelReady = page.waitForEvent('filechooser');
    await page.getByRole('button', {name:'浏览…',exact:true}).click();
    await cancelReady;
    await page.locator('input[type="file"]').dispatchEvent('cancel');
    assert.equal(await page.locator('input[type="file"]').count(),0,'Cancel should clean up the input');
    assert.ok(await page.getByText('auth-picker-test.json',{exact:true}).isVisible(),'Cancel must preserve the previous selection');

    const reselectReady = page.waitForEvent('filechooser');
    await page.getByRole('button', {name:'浏览…',exact:true}).click();
    await (await reselectReady).setFiles({name:'auth-picker-test.json',mimeType:'application/json',buffer:Buffer.from('{}')});
    assert.ok(await page.getByText('auth-picker-test.json',{exact:true}).isVisible());

    // The preview genuinely has no backend; do not label selection as successful import.
    await page.getByRole('button', {name:'导入',exact:true}).click();
    await page.getByRole('dialog',{name:'添加账号',exact:true}).getByText('后台接口不可用（404）。请启动包含 Rust 后端的完整应用，或检查后端连接后重试。',{exact:true}).waitFor();
    await page.screenshot({path:path.join(output,`backend-unavailable-${viewport.width}.png`),animations:'disabled'});
    assert.ok(await page.getByText('auth-picker-test.json',{exact:true}).isVisible(),'Failed import should retain the selected file');

    await page.evaluate(() => {
      const click = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () {
        if (this.type === 'file') throw new Error('File picker blocked by browser');
        return click.call(this);
      };
    });
    await page.getByRole('button', {name:'浏览…',exact:true}).click();
    await page.getByText('File picker blocked by browser',{exact:true}).waitFor();
    assert.equal(await page.locator('input[type="file"]').count(),0,'Failed opening should clean up the input');
    assert.equal(await page.locator('html').evaluate(el=>el.scrollWidth),viewport.width);
    console.log(`PASS ${viewport.width}x${viewport.height}: focus race, cancel, reselect, validation, backend error, dialog error`);
    await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode=1;});
