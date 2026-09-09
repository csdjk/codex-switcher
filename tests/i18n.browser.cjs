// Run against Vite with Playwright available (locally or through NODE_PATH).
// All account/backend responses are isolated fixtures; never access real credentials.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const baseURL = process.env.UI_BASE_URL || 'http://127.0.0.1:3211';
const output = path.resolve('Temp/i18n-qa');
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
 try{
  for(const size of [{width:1280,height:900},{width:320,height:568},{width:375,height:667},{width:390,height:844}]){
   const mobile=size.width<600;
   const context=await browser.newContext({viewport:size,locale:'en-US',deviceScaleFactor:1,isMobile:mobile,hasTouch:mobile});
   const mode={value:'accounts'};await fixtures(context,mode);
   const page=await context.newPage();page.on('pageerror',error=>runtimeErrors.push(String(error)));
   await page.goto(baseURL);await page.getByText('UI Test Account',{exact:true}).waitFor();
   await page.getByText('Token activity',{exact:true}).waitFor();
   await capture(page,`en-main-${size.width}`);
   await chooseLanguage(page,'en','zh');
   await capture(page,`zh-settings-${size.width}`,true);
   await page.getByRole('button',{name:'完成',exact:true}).click();
   await page.reload();await page.getByText('Token 使用趋势',{exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>localStorage.getItem('codex-switcher-language')),'zh');
   await capture(page,`zh-main-${size.width}`);
   await page.getByLabel('Token 活动范围',{exact:true}).selectOption('90');
   await page.getByText('近 3 个月',{exact:true}).waitFor();
   await page.getByLabel('Token 活动范围',{exact:true}).selectOption('30');
   await page.getByText('更多使用详情',{exact:true}).click();
   await capture(page,`zh-stats-details-${size.width}`);
   await page.getByText('更多使用详情',{exact:true}).click();
   await page.locator('button[aria-expanded][aria-controls]').first().click();
   await page.getByText('可用重置次数',{exact:true}).waitFor();
   await capture(page,`zh-reset-credits-${size.width}`);
   await page.keyboard.press('Escape');
   await page.getByRole('button',{name:'账号 ▾',exact:true}).click();
   await page.getByRole('button',{name:'+ 添加账号',exact:true}).click();
   await page.getByPlaceholder('留空则使用邮箱作为名称').fill('未提交的名称');
   await capture(page,`zh-add-${size.width}`,true);
   const other=await context.newPage();await other.goto(baseURL);
   await chooseLanguage(other,'zh','en');
   await page.getByText('Account Name (optional)',{exact:true}).waitFor();
   assert.equal(await page.getByPlaceholder('Leave blank to use email').inputValue(),'未提交的名称');
   await capture(page,`en-add-${size.width}`,true);
   await page.getByRole('button',{name:'Import File',exact:true}).click();
   await page.getByRole('button',{name:'Import',exact:true}).click();
   await page.getByText('Please select an auth.json file',{exact:true}).waitFor();
   await capture(page,`en-import-error-${size.width}`,true);
   await other.locator('#language').selectOption('zh');
   await page.getByText('请选择 auth.json 文件',{exact:true}).waitFor();
   await capture(page,`zh-import-error-${size.width}`,true);
   await page.getByRole('button',{name:'取消',exact:true}).click();
   await other.locator('#language').selectOption('en');
   await capture(other,`en-settings-${size.width}`,true);
   await page.getByRole('button',{name:'Switch',exact:true}).first().click();
   await page.getByText('Force close running Codex processes?',{exact:true}).waitFor();
   await capture(page,`en-force-close-${size.width}`,true);
   await page.getByRole('button',{name:'Cancel',exact:true}).click();
   await other.locator('#language').selectOption('zh');
   await page.getByRole('button',{name:'切换',exact:true}).first().click();
   await page.getByText('强制关闭正在运行的 Codex 进程？',{exact:true}).waitFor();
   await capture(page,`zh-force-close-${size.width}`,true);
   await page.getByRole('button',{name:'取消',exact:true}).click();
   if(!mobile){
    const tray=await context.newPage();await tray.setViewportSize({width:300,height:420});await tray.goto(baseURL+'/tray.html');
    await tray.getByText('UI Test Account',{exact:true}).waitFor();
    await tray.getByText('今日',{exact:true}).waitFor();await capture(tray,'zh-tray');
    await other.locator('#language').selectOption('en');
    await tray.getByRole('button',{name:'Quit',exact:true}).waitFor();await capture(tray,'en-tray');
    await other.getByRole('button',{name:'Done',exact:true}).click();
    await other.getByRole('button',{name:'Menu',exact:true}).click();
    await other.getByRole('button',{name:/Appearance/}).click();
    await capture(other,'en-dark-main');
    await openSettings(other,'en');await capture(other,'en-dark-settings',true);
    await other.locator('#language').selectOption('zh');await capture(other,'zh-dark-settings',true);
   }
   mode.value='empty';await page.reload();
   const lang=await page.locator('html').getAttribute('lang');
   await page.getByText(lang==='zh-CN'?'暂无账号':'No accounts yet',{exact:true}).waitFor();
   await capture(page,`empty-${size.width}`);
   await context.close();
   console.log('PASS',size.width+'x'+size.height);
  }
  assert.deepEqual(runtimeErrors,[]);
 }finally{
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({baseURL,fixture:true,report,runtimeErrors},null,2));
  await browser.close();
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
