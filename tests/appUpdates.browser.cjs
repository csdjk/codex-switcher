// Isolated component QA. All release responses and Tauri calls are mocked;
// no account UI, account storage, network credentials or installers are used.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve('Temp/update-source-qa');
const api = 'https://api.github.com/repos/csdjk/codex-switcher/releases/latest';
const releaseUrl = 'https://github.com/csdjk/codex-switcher/releases/tag/v0.2.17';
const fixture = { tag_name:'v0.2.17', draft:false, prerelease:false,
  html_url:releaseUrl, body:'测试发行说明：改进额度圆环，修正更新来源。' };

(async () => {
  fs.mkdirSync(output, { recursive:true });
  fs.writeFileSync(path.join(output,'harness.html'), '<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  fs.writeFileSync(path.join(output,'harness.tsx'), `import React from 'react';
import {createRoot} from 'react-dom/client';
import {UpdateChecker} from '../../src/components/UpdateChecker';
import '../../src/App.css';
createRoot(document.getElementById('root')!).render(<React.StrictMode><UpdateChecker /></React.StrictMode>);
window.__qaReady = true;
`);
  const { createServer } = await import('vite');
  const server = await createServer({ server:{host:'127.0.0.1',port:0,open:false}, clearScreen:false,
    optimizeDeps:{ include:['react','react-dom/client','@tauri-apps/api/app','@tauri-apps/api/core','@tauri-apps/plugin-opener'] } });
  let browser;
  const results = [];
  try {
    await server.listen();
    const base = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await chromium.launch({ headless:true });
    const cases = [
      {name:'zh-new-release', locale:'zh', available:true},
      {name:'en-new-release-dark', locale:'en', dark:true, available:true},
      {name:'same-version', payload:{...fixture,tag_name:'v0.2.16'}},
      {name:'upstream-link-rejected', payload:{...fixture,html_url:'https://github.com/Lampese/codex-switcher/releases/tag/v0.2.17'}},
      {name:'rate-limited', status:403},
      {name:'no-release', status:404},
      {name:'open-failure-retry', locale:'zh', available:true, failOpen:true},
      {name:'browser-mode-disabled', desktop:false},
    ];
    for (const item of cases) {
      const context = await browser.newContext({viewport:{width:600,height:440},locale:item.locale==='zh'?'zh-CN':'en-US'});
      const requests = [];
      const errors = [];
      await context.addInitScript(({desktop,locale,dark,failOpen}) => {
        localStorage.setItem('codex-switcher-language',locale || 'en');
        window.__qaCommands = [];
        window.__qaWarnings = [];
        const warn = console.warn;
        console.warn = (...args) => {window.__qaWarnings.push(args.map(String).join(' '));warn(...args);};
        if (desktop !== false) {
          window.__TAURI_INTERNALS__ = { invoke: async (command,args) => {
            window.__qaCommands.push({command,args});
            if(command==='plugin:app|version') return '0.2.16';
            if(command==='plugin:opener|open_url') {
              if(failOpen && window.__qaCommands.filter(x=>x.command===command).length===1) throw Error('QA open failure');
              return null;
            }
            throw Error('Unexpected native call: '+command);
          }};
        }
        document.addEventListener('DOMContentLoaded', () => {
          if (dark) document.documentElement.classList.add('dark');
          document.body.style.background = dark ? '#111827' : '#f3f4f6';
        });
      },item);
      await context.route('**/*',async route => {
        const url = route.request().url();
        if(url.startsWith(base+'/')) return route.continue();
        requests.push(url);
        if(url===api) return route.fulfill({status:item.status || 200,contentType:'application/json',body:JSON.stringify(item.payload || fixture)});
        return route.abort();
      });
      const page = await context.newPage();
      page.on('pageerror',error=>errors.push(String(error)));
      await page.goto(base+'/Temp/update-source-qa/harness.html');
      await page.waitForFunction(()=>window.__qaReady===true);
      const notice=page.getByTestId('app-update-notice');
      if(item.available) {
        await notice.waitFor({state:'visible'});
        assert.match(await notice.innerText(),/csdjk\/codex-switcher/);
        assert.match(await notice.innerText(),/0\.2\.17/);
        const download=page.getByRole('button',{name:item.locale==='zh'?'前往下载':'View release',exact:true});
        await download.click();
        if(item.failOpen) {
          await page.getByRole('alert').waitFor({state:'visible'});
          await download.click();
          await page.getByRole('alert').waitFor({state:'hidden'});
        }
        await page.waitForFunction(()=>window.__qaCommands.some(x=>x.command==='plugin:opener|open_url'));
        const opened=await page.evaluate(()=>window.__qaCommands.filter(x=>x.command==='plugin:opener|open_url'));
        assert.ok(opened.length>0);
        assert.ok(opened.every(x=>x.args.url===releaseUrl));
        await page.screenshot({path:path.join(output,item.name+'.png')});
        const geometry=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth}));
        assert.ok(geometry.width<=geometry.viewport,'No horizontal overflow');
        await page.getByRole('button',{name:item.locale==='zh'?'稍后':'Later',exact:true}).click();
        await notice.waitFor({state:'hidden'});
      } else {
        if(item.status===403) await page.waitForFunction(()=>window.__qaWarnings.length>0);
        await page.waitForTimeout(300);
        assert.equal(await notice.count(),0);
      }
      assert.deepEqual(errors,[]);
      if(item.desktop===false) assert.equal(requests.length,0);
      else assert.ok(requests.length>0 && requests.every(url=>url===api));
      const commands=await page.evaluate(()=>window.__qaCommands);
      assert.ok(commands.every(x=>['plugin:app|version','plugin:opener|open_url'].includes(x.command)));
      results.push({name:item.name,status:'pass',releaseRequests:requests.length});
      await context.close();
    }
    fs.writeFileSync(path.join(output,'ui-report.json'),JSON.stringify(results,null,2));
    console.log(JSON.stringify(results,null,2));
  } finally {
    await browser?.close();
    await server.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
