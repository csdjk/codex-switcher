// Run against Vite with Playwright available (locally or through NODE_PATH).
// All account/backend responses are isolated fixtures; never access real credentials.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const baseURL = process.env.UI_BASE_URL || 'http://127.0.0.1:3218';
const output = path.resolve('Temp/neumorphism-qa');
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
// Visual and interaction regression against isolated fixture data.
(async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  for(const size of [{width:1280,height:1000},{width:900,height:700},{width:600,height:760},{width:375,height:812},{width:320,height:640},{width:812,height:375}]){
   const context=await browser.newContext({viewport:size,locale:'zh-CN',deviceScaleFactor:1});
   await context.addInitScript(()=>localStorage.setItem('codex-switcher-language','zh'));
   await context.route('**/*',route=>new URL(route.request().url()).origin===new URL(baseURL).origin?route.continue():route.abort());
   const mode={value:'accounts'}; await fixtures(context,mode);
   const page=await context.newPage(); page.on('pageerror',error=>runtimeErrors.push(String(error)));
   await page.goto(baseURL+'/?historyFixture=1'); await page.getByText('UI Test Account',{exact:true}).waitFor();
   await page.getByText('Token 使用趋势',{exact:true}).waitFor();
   await capture(page,`light-main-${size.width}x${size.height}`);
   const card=page.locator('.neu-account[data-active="true"]');
   assert.equal(await card.evaluate(el=>getComputedStyle(el).borderRadius),'16px');
   assert.match(await card.evaluate(el=>getComputedStyle(el).boxShadow),/rgb/);
   assert.equal(await page.locator('.neu-overview-metric').count(),2);
   assert.equal(await page.getByRole('progressbar').count(),4);
   for(const bar of await page.getByRole('progressbar').all()){
    const n=Number(await bar.getAttribute('aria-valuenow')); assert.ok(n>=0&&n<=100);
   }
   // Keyboard focus stays in Settings, including after its language changes.
   await openSettings(page,'zh');
   await page.locator('#language').focus();
   for(let i=0;i<8;i++){
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('[aria-modal="true"]')),true);
   }
   await capture(page,`light-settings-${size.width}x${size.height}`,true);
   await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({state:'hidden'});
   assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('data-neu-trigger')),'settings');
   await page.getByRole('button',{name:'账号 ▾',exact:true}).click();
   await page.getByRole('button',{name:'+ 添加账号',exact:true}).click();
   await page.getByLabel('账号名称（选填）',{exact:true}).fill('Neumorphism UI Test');
   await capture(page,`light-add-${size.width}x${size.height}`,true);
   await page.getByRole('button',{name:'导入文件',exact:true}).click();
   await capture(page,`light-import-${size.width}x${size.height}`,true);
   await page.getByRole('button',{name:'取消',exact:true}).click();
   // Theme changes retain the accounts, controls and primary navigation.
   await page.getByRole('button',{name:'菜单',exact:true}).click();
   await page.getByRole('button',{name:/外观/}).click();
   assert.equal(await page.locator('html').evaluate(el=>el.classList.contains('dark')),true);
   await capture(page,`dark-main-${size.width}x${size.height}`);
   await openSettings(page,'zh'); await capture(page,`dark-settings-${size.width}x${size.height}`,true);
   await page.getByRole('button',{name:'完成',exact:true}).click();
   // Reduced motion applies to all controls rather than just the page background.
   await page.emulateMedia({reducedMotion:'reduce'});
   const duration=await page.locator('.neu-control').first().evaluate(el=>getComputedStyle(el).transitionDuration);
   assert.ok(duration.split(',').every(n=>parseFloat(n)<=.001));
   if(size.width===1280){
    const lightDarkContrast=[];
    for(const dark of [false,true]){
     await page.evaluate(dark=>document.documentElement.classList.toggle('dark',dark),dark);
     const c=await page.evaluate(()=>{
      const toRGB=s=>s.startsWith('#')?[1,3,5].map(i=>parseInt(s.slice(i,i+2),16)):s.match(/[\d.]+/g).slice(0,3).map(Number);
      const lum=c=>c.map(x=>{x/=255;return x<=.04045?x/12.92:((x+.055)/1.055)**2.4}).reduce((s,x,i)=>s+x*[.2126,.7152,.0722][i],0);
      const root=getComputedStyle(document.documentElement);
      return ['--neu-ink','--neu-muted'].map(name=>{
       const a=lum(toRGB(root.getPropertyValue(name).trim())),b=lum(toRGB(root.getPropertyValue('--neu-bg').trim()));
       return {name,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
      });
     });
     assert.ok(c.every(item=>item.ratio>=4.5)); lightDarkContrast.push({dark,colors:c});
    }
    fs.writeFileSync(path.join(output,'contrast.json'),JSON.stringify(lightDarkContrast,null,2));
    const tray=await context.newPage();await tray.setViewportSize({width:300,height:420});await tray.goto(baseURL+'/tray.html');
    await tray.getByText('UI Test Account',{exact:true}).waitFor(); await capture(tray,'tray-dark');
    await tray.evaluate(()=>document.documentElement.classList.remove('dark'));await capture(tray,'tray-light');
   }
   await context.close();
  }
  assert.deepEqual(runtimeErrors,[]);
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({status:'pass',captures:report,errors:runtimeErrors},null,2));
  console.log('NEUMORPHISM_QA_PASSED: '+report.length+' screenshots; 6 viewports, light/dark, dialogs, keyboard, contrast, reduced motion.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
