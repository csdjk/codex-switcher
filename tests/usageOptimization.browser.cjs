// Run against Vite with Playwright available (locally or through NODE_PATH).
// All account/backend responses are isolated fixtures; never access real credentials.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const baseURL = process.env.UI_BASE_URL || 'http://127.0.0.1:3218';
const output = path.resolve('Temp/usage-optimization/qa');
fs.mkdirSync(output, { recursive: true });
const now = Date.now();
const iso = days => new Date(now + days * 86400000).toISOString();
const accounts = [
  { id:'qa-active', name:'UI Test Account', email:'ui-test@example.invalid', auth_mode:'chat_g_p_t', plan_type:'plus', subscription_expires_at:iso(5), is_active:true, created_at:iso(-30), last_used_at:iso(0) },
  { id:'qa-other', name:'备用测试账号 · Long Account Name', email:'secondary@example.invalid', auth_mode:'chat_g_p_t', plan_type:'pro', subscription_expires_at:null, is_active:false, created_at:iso(-30), last_used_at:null },
  { id:'qa-api', name:'API Test', email:null, auth_mode:'api_key', plan_type:'api_key', subscription_expires_at:null, is_active:false, created_at:iso(-30), last_used_at:null },
];
function usage(accountId) {
  return {account_id:accountId,plan_type:'plus',primary_used_percent:32,primary_window_minutes:300,primary_resets_at:Math.floor(now/1000)+6900,secondary_used_percent:81,secondary_window_minutes:10080,secondary_resets_at:Math.floor(now/1000)+220000,has_credits:true,unlimited_credits:false,credits_balance:'12.50',error:accountId==='qa-api'?'Usage info not available for API key accounts':null};
}
function stats(accountId) {
  return {account_id:accountId,available:true,source:'Codex usage stats via ChatGPT backend',generated_at:iso(0),stats_as_of:null,summary:{lifetime_tokens:12345678,peak_daily_tokens:998877,longest_task_seconds:5100,current_streak_days:7,longest_streak_days:20},activity:{fast_mode_percent:20,reasoning_effort:'high',reasoning_effort_percent:60,skills_explored:12,total_skills_used:19,total_threads:32},daily:Array.from({length:30},(_,i)=>({date:iso(-i).slice(0,10),tokens:10000+i*3000})),top_invocations:[{kind:'plugin',display_name:'Test integration',usage_count:12}],reset_credits:{available_count:2,next_expires_at:iso(2),credits:[{id:'qa-reset-1',reset_type:'manual',status:'available',expires_at:iso(2),title:null,description:null},{id:'qa-reset-2',reset_type:'manual',status:'available',expires_at:null,title:null,description:null}]},error:null};
}
const report=[];
const runtimeErrors=[];
async function fixtures(context, mode) {
  await context.route('**/api/invoke/*',async route=>{
    const command=route.request().url().split('/').pop();
    const args=route.request().postDataJSON() || {};
    let payload;
    switch(command){
      case 'list_accounts': payload=mode.value==='empty'?[]:accounts;break;
      case 'get_usage': payload=usage(args.accountId);break;
      case 'get_account_usage_stats': payload=stats(args.accountId);break;
      case 'get_masked_account_ids': payload=[];break;
      case 'check_codex_processes': payload={count:1,background_count:0,can_switch:false,pids:[12345]};break;
      case 'get_dock_display_mode': payload=null;break;
      case 'get_display_settings': payload={tray_display_mode:'icon_and_session',dock_display_mode:null};break;
      case 'refresh_account_metadata': payload=accounts.find(a=>a.id===args.accountId);break;
      case 'report_usage': payload=null;break;
      case 'cancel_login': payload=null;break;
      default: throw Error('Unexpected backend call: '+command);
    }
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(payload)});
  });
}
async function capture(page, name, modal=false) {
  await page.evaluate(()=>{window.scrollTo(0,0);return new Promise(resolve=>requestAnimationFrame(resolve));});
  await page.screenshot({path:path.join(output,`${name}.png`),fullPage:!modal,animations:'disabled'});
  const geometry=await page.evaluate(()=>({width:document.documentElement.scrollWidth,lang:document.documentElement.lang}));
  geometry.viewport=page.viewportSize();
  report.push({name,...geometry});
  assert.ok(geometry.width<=geometry.viewport.width,`${name}: horizontal overflow ${geometry.width}`);
  if(modal){
    const rect=await page.locator('[role="dialog"]').boundingBox();
    if(rect)assert.ok(rect.y>=8&&rect.y+rect.height<=geometry.viewport.height-8,`${name}: dialog outside viewport ${JSON.stringify(rect)}`);
  }
}
async function openSettings(page, lang) {
  await page.getByRole('button',{name:lang==='zh'?'菜单':'Menu',exact:true}).click();
  await page.getByRole('button',{name:lang==='zh'?'设置':'Settings',exact:true}).click();
}
async function chooseLanguage(page, previous, next) {
  await openSettings(page, previous);
  await page.locator('#language').selectOption(next);
  assert.equal(await page.locator('html').getAttribute('lang'),next==='zh'?'zh-CN':'en-US');
}
(async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  // Hold billing and one account indefinitely until the fast quota is visible.
  const context=await browser.newContext({viewport:{width:1000,height:800}});
  await context.addInitScript(()=>{
   localStorage.setItem('codex-switcher-language','en');
   localStorage.setItem('usage-stats-open:qa-active','0');
  });
  await fixtures(context,{value:'accounts'});
  let releaseMetadata,releaseSlow;
  const metadataGate=new Promise(resolve=>releaseMetadata=resolve);
  const slowGate=new Promise(resolve=>releaseSlow=resolve);
  let metadataDone=false, slowDone=false, activeRequests=0, statsRequests=0;
  await context.route('**/api/invoke/*',async route=>{
   const command=route.request().url().split('/').pop(), args=route.request().postDataJSON();
   let payload;
   if(command==='get_usage'){
    if(args.accountId==='qa-active')activeRequests++;
    if(args.accountId==='qa-other')await slowGate;
    payload={...usage(args.accountId),cached:false,fetched_at:new Date().toISOString()};
    if(args.accountId==='qa-other')slowDone=true;
   }else if(command==='refresh_account_metadata'){
    await metadataGate; metadataDone=true;payload=accounts.find(a=>a.id===args.accountId);
   }else if(command==='get_account_usage_stats'){
    if(args.accountId==='qa-active')statsRequests++;
    payload=stats(args.accountId);
   }else return route.fallback();
   await route.fulfill({json:payload});
  });
  const page=await context.newPage(); page.on('pageerror',e=>runtimeErrors.push(String(e)));
  await page.goto(baseURL);
  const active=page.locator('.neu-account[data-active="true"]');
  await active.getByRole('progressbar').first().waitFor();
  assert.equal(metadataDone,false,'billing must not block quota');
  assert.equal(slowDone,false,'slow account must not block fast account');
  assert.equal(activeRequests,1);
  await active.getByRole('button',{name:'Show usage statistics',exact:true}).click();
  await active.getByText('12.3M',{exact:true}).waitFor();
  assert.equal(statsRequests,1,'credit badge and stats should reuse a recent result');
  await active.getByRole('button',{name:'Hide usage statistics',exact:true}).click();
  await active.getByRole('button',{name:'Show usage statistics',exact:true}).click();
  await active.getByText('12.3M',{exact:true}).waitFor();
  assert.equal(statsRequests,1);
  releaseMetadata();releaseSlow();
  await page.locator('.neu-account').nth(1).getByRole('progressbar').first().waitFor();
  await Promise.all([
   page.waitForResponse(r=>r.url().endsWith('/get_account_usage_stats')),
   active.getByRole('button',{name:'Refresh usage stats',exact:true}).click(),
  ]);
  assert.equal(statsRequests,2,'explicit stats refresh bypasses recent data');
  let releaseRefresh, refreshCalls=0;
  const refreshGate=new Promise(resolve=>releaseRefresh=resolve);
  await context.route('**/api/invoke/get_usage',async route=>{
   const id=route.request().postDataJSON().accountId;
   if(id!=='qa-active')return route.fallback();
   refreshCalls++;await refreshGate;
   await route.fulfill({json:{...usage(id),primary_used_percent:47}});
  });
  await active.getByRole('button',{name:'Refresh usage',exact:true}).click();
  await Promise.all([
   page.waitForResponse(r=>r.url().endsWith('/refresh_account_metadata')),
   page.getByRole('button',{name:'Refresh all usage',exact:true}).click(),
  ]);
  assert.equal(refreshCalls,1,'overlapping single/all refresh should share the pending quota query');
  releaseRefresh();
  await active.getByText('53%',{exact:true}).waitFor();
  assert.equal(refreshCalls,1);
  report.push({scenario:'progressive refresh and statistics',passed:true});
  await context.close();

  const cachedContext=await browser.newContext();
  await cachedContext.addInitScript(()=>{
   localStorage.setItem('usage-stats-open:qa-active','0');
   localStorage.setItem('codex-switcher-auto-warmup-all','true');
   localStorage.setItem('codex-switcher-timed-warmup-enabled','true');
   const now=new Date();
   localStorage.setItem('codex-switcher-timed-warmup-times',JSON.stringify([`${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`]));
  });
  await fixtures(cachedContext,{value:'accounts'});
  let warmupCalls=0;
  await cachedContext.route('**/api/invoke/warmup_account',route=>{warmupCalls++;return route.fulfill({json:null});});
  await cachedContext.route('**/api/invoke/get_usage',route=>route.fulfill({json:{...usage(route.request().postDataJSON().accountId),cached:true,primary_resets_at:Math.floor(Date.now()/1000)+18000,fetched_at:new Date().toISOString()}}));
  const cachedPage=await cachedContext.newPage();
  await cachedPage.clock.install();
  await cachedPage.goto(baseURL);await cachedPage.locator('.neu-cache-note').first().waitFor();
  await cachedPage.clock.fastForward(31_000);
  assert.equal(warmupCalls,0,'cached quotas must not trigger automatic or scheduled warm-up');
  report.push({scenario:'cached automatic and timed warm-up',passed:true});
  await cachedContext.close();

  for(const lang of ['zh','en'])for(const size of [{width:1000,height:800},{width:320,height:568},{width:375,height:667},{width:390,height:844}]){
   const context=await browser.newContext({viewport:size,isMobile:size.width<600,deviceScaleFactor:1,locale:lang==='zh'?'zh-CN':'en-US'});
   await context.addInitScript(lang=>{
    localStorage.setItem('codex-switcher-language',lang);
    localStorage.setItem('usage-stats-open:qa-active','0');
   },lang);
   await fixtures(context,{value:'accounts'});
   await context.route('**/api/invoke/get_usage',route=>route.fulfill({json:{...usage(route.request().postDataJSON().accountId),cached:true,fetched_at:new Date(now-10*60_000).toISOString()}}));
   const page=await context.newPage();page.on('pageerror',e=>runtimeErrors.push(String(e)));
   await page.goto(baseURL);await page.locator('.neu-cache-note').first().waitFor();
   const other=page.locator('.neu-account').filter({hasText:'备用测试账号'});
   assert.equal(await other.getAttribute('data-compact'),'true');
   assert.equal(await other.getByRole('button',{name:lang==='zh'?'删除账号':'Remove account',exact:true}).isVisible(),false);
   await page.locator('#other-accounts-sort').selectOption('remaining_desc');
   const quotaMetric=page.locator('.neu-overview-metric').nth(1);
   assert.match(await quotaMetric.innerText(),lang==='zh'?/缓存额度/:/Cached quota/);
   assert.ok(await quotaMetric.locator('small').isVisible());
   for(const dark of [false,true]){
    await page.evaluate(dark=>document.documentElement.classList.toggle('dark',dark),dark);
    const name=`${lang}-${dark?'dark':'light'}-${size.width}`;
    await capture(page,name+'-compact');
    await other.screenshot({path:path.join(output,name+'-card.png'),animations:'disabled'});
    await other.getByRole('button',{name:lang==='zh'?'更多操作':'More actions',exact:true}).click();
    assert.equal(await other.getAttribute('data-compact'),'false');
    assert.ok(await other.getByRole('button',{name:lang==='zh'?'删除账号':'Remove account',exact:true}).isVisible());
    await other.getByRole('button',{name:lang==='zh'?'展开使用统计':'Show usage statistics',exact:true}).click();
    await other.getByText('12.3M',{exact:true}).waitFor();
    const clipped=await other.locator('.neu-stat-value').evaluateAll(nodes=>nodes.filter(node=>node.scrollWidth>node.clientWidth).map(node=>({text:node.textContent,width:node.clientWidth,scroll:node.scrollWidth})));
    assert.deepEqual(clipped,[],`stat values must remain readable: ${lang} ${size.width}`);
    await capture(page,name+'-expanded');
    await other.screenshot({path:path.join(output,name+'-expanded-card.png'),animations:'disabled'});
    await other.getByRole('button',{name:lang==='zh'?'收起使用统计':'Hide usage statistics',exact:true}).click();
    await other.getByRole('button',{name:lang==='zh'?'收起操作':'Fewer actions',exact:true}).click();
   }
   await context.close();
  }
  assert.deepEqual(runtimeErrors,[]);
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({report,runtimeErrors},null,2));
  console.log(JSON.stringify({passed:true,states:report.length,output}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
