// Isolated subscription UI regression fixtures. No real credentials or account mutations.
const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const baseURL = process.env.UI_BASE_URL || 'http://127.0.0.1:1420';
const output = path.resolve('Temp/subscription-qa');
const checked = new Date().toISOString();
const live = {renews_at:'2026-10-08T04:28:49Z',expires_at:'2026-10-09T05:28:49Z',checked_at:checked};
const account = {id:'subscription-test',name:'Subscription test',email:'test@example.invalid',auth_mode:'chat_g_p_t',plan_type:'pro',subscription_expires_at:'2026-08-31T00:00:00Z',subscription:null,is_active:true,created_at:checked,last_used_at:null};
const usage = id => ({account_id:id,plan_type:'pro',primary_used_percent:25,primary_window_minutes:300,secondary_used_percent:65,secondary_window_minutes:10080,primary_resets_at:null,secondary_resets_at:null,has_credits:false,unlimited_credits:false,credits_balance:null,error:null});
const scenarios = ['renewal','expiry-only','unverified-error','cached-error','no-date'];
(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const browser=await chromium.launch({headless:true});
  const report=[];
  try {
    for(const viewport of [{width:1000,height:800},{width:320,height:568},{width:375,height:667},{width:390,height:844}]) {
      for(const scenario of scenarios) {
        const mobile=viewport.width<600;
        const context=await browser.newContext({viewport,locale:'zh-CN',timezoneId:'Asia/Shanghai',isMobile:mobile,hasTouch:mobile});
        let accounts=[{...account,subscription:scenario==='cached-error'?live:null}];
        let calls=0;
        const unexpected=[];
        await context.route('**/api/invoke/*',async route=>{
          const command=route.request().url().split('/').pop();
          const args=route.request().postDataJSON();
          let data,status=200;
          switch(command){
            case 'list_accounts':data=accounts;break;
            case 'refresh_account_metadata':{
              calls++;
              if(scenario.endsWith('error')) {status=503;data={error:'Subscription service unavailable'};break;}
              const subscription=scenario==='expiry-only'?{...live,renews_at:null}:scenario==='no-date'?{...live,renews_at:null,expires_at:null}:live;
              accounts=accounts.map(a=>a.id===args.accountId?{...a,subscription}:a);
              data=accounts.find(a=>a.id===args.accountId);break;
            }
            case 'get_usage':data=usage(args.accountId);break;
            case 'check_codex_processes':data={count:0,background_count:0,can_switch:true,pids:[]};break;
            case 'get_masked_account_ids':data=[];break;
            case 'get_account_usage_stats':data={account_id:args.accountId,available:false,error:null,reset_credits:null};break;
            case 'add_account_from_auth_json_text':data={...account,id:'imported-test',name:'Imported test',is_active:false};accounts.push(data);break;
            default:unexpected.push(command);status=500;data={error:'Unexpected test request'};
          }
          await route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
        });
        const page=await context.newPage();
        const errors=[];page.on('pageerror',e=>errors.push(e.message));
        await page.goto(baseURL);
        const label=scenario==='renewal'?'下次续订：2026年10月8日':scenario==='expiry-only'?'权益截止：2026年10月9日':scenario==='unverified-error'?'订阅日期同步失败':scenario==='cached-error'?'下次续订：2026年10月8日（上次查询）':'接口未提供订阅日期';
        await page.getByText(label,{exact:true}).waitFor();
        await page.getByText('35%',{exact:false}).first().waitFor();
        assert.equal(await page.getByText(/已于.*到期/).count(),0);
        assert.ok(calls>=1,'Opening a page must sync subscription metadata');
        if(scenario.endsWith('error')) assert.equal(await page.getByText(label,{exact:true}).getAttribute('title'),'Subscription service unavailable');
        const countBefore=calls;
        await page.getByTitle('刷新用量',{exact:true}).click();
        await page.waitForFunction(()=>!document.querySelector('button[title="刷新用量"]')?.disabled);
        assert.ok(calls>countBefore,'Manual refresh must sync subscription metadata');
        await page.screenshot({path:path.join(output,`${scenario}-${viewport.width}.png`),fullPage:true});
        assert.equal(await page.locator('html').evaluate(el=>el.scrollWidth),viewport.width,'Horizontal overflow');
        if(scenario==='renewal'&&viewport.width===1000){
          await page.getByRole('button',{name:'账号 ▾',exact:true}).click();
          await page.getByRole('button',{name:'+ 添加账号',exact:true}).click();
          await page.getByRole('button',{name:'导入文件',exact:true}).click();
          const chooser=page.waitForEvent('filechooser');
          await page.getByRole('button',{name:'浏览…',exact:true}).click();
          await (await chooser).setFiles({name:'test-auth.json',mimeType:'application/json',buffer:Buffer.from('{}')});
          await page.getByRole('button',{name:'导入',exact:true}).click();
          await page.getByRole('dialog').waitFor({state:'hidden'});
          assert.equal(await page.getByText(label,{exact:true}).count(),2,'Imported account must show live renewal');
        }
        assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);
        report.push({scenario,viewport,mobile,metadataCalls:calls});
        await context.close();
      }
      console.log(`PASS subscription states ${viewport.width}x${viewport.height}`);
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({baseURL,fixtures:true,report},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
