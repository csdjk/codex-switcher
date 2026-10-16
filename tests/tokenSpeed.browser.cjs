// Isolated UI fixtures only: never queries a real account or sends a model request.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const baseURL = process.env.UI_BASE_URL || 'http://127.0.0.1:3227';
const output = path.resolve('Temp/token-speed-qa');
fs.mkdirSync(output,{recursive:true});
const now = Date.now();
const account = {id:'speed-qa',name:'本地测速测试账号',email:'speed-test@example.invalid',auth_mode:'chat_g_p_t',plan_type:'plus',subscription_expires_at:null,is_active:true,created_at:new Date(now).toISOString(),last_used_at:null};
function session(id,model,rate) {
 return {id,project:id==='session-a'?'Demo Project':'Other Project',model,updated_at:now,state:'observed',latest:{tokens_per_second:rate,output_tokens:rate*2,reasoning_output_tokens:20,model_time_ms:2000,completed_at:now,turn_id:'turn-1'},latest_in_current_turn:true,recent_average_tps:rate+1,sample_count:5,unavailable_reason:null};
}
const errors=[];
const captures=[];
(async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  for(const size of [{width:1000,height:800},{width:900,height:700},{width:600,height:760},{width:375,height:812},{width:320,height:640}]) {
   const context=await browser.newContext({viewport:size,locale:'zh-CN',deviceScaleFactor:1});
   await context.addInitScript(()=>localStorage.setItem('codex-switcher-language','zh'));
   await context.route('**/*',route=>new URL(route.request().url()).origin===new URL(baseURL).origin?route.continue():route.abort());
   const state={sessions:[session('session-a','gpt-test-a',42),session('session-b','gpt-test-b',85)],failed:false,calls:0};
   await context.route('**/api/invoke/*',async route=>{
    const command=route.request().url().split('/').pop();
    const args=route.request().postDataJSON() || {};
    let data=null;
    switch(command) {
     case 'get_token_speed_snapshot':
      state.calls++;
      if(state.failed){await route.fulfill({status:503,contentType:'application/json',body:'{"error":"fixture disconnected"}'});return;}
      data={sessions:state.sessions,checked_at:Date.now(),partial:false};break;
     case 'list_accounts': data=[account];break;
     case 'get_usage': data={account_id:args.accountId,plan_type:'plus',primary_used_percent:25,primary_window_minutes:300,primary_resets_at:Math.floor(now/1000)+3600,secondary_used_percent:40,secondary_window_minutes:10080,secondary_resets_at:Math.floor(now/1000)+200000,error:null,cached:false,fetched_at:new Date(now).toISOString()};break;
     case 'get_account_usage_stats': data={account_id:args.accountId,available:false,source:'fixture',generated_at:new Date(now).toISOString(),stats_as_of:null,summary:{lifetime_tokens:null,peak_daily_tokens:null,longest_task_seconds:null,current_streak_days:null,longest_streak_days:null},activity:{fast_mode_percent:null,reasoning_effort:null,reasoning_effort_percent:null,skills_explored:null,total_skills_used:null,total_threads:null},daily:[],top_invocations:[],reset_credits:null,error:null};break;
     case 'get_masked_account_ids': data=[];break;
     case 'check_codex_processes': data={count:0,background_count:0,can_switch:true,pids:[]};break;
     case 'get_display_settings': data={tray_display_mode:'icon_and_session',dock_display_mode:null};break;
     case 'refresh_account_metadata': data=account;break;
     case 'get_dock_display_mode': case 'report_usage': case 'cancel_login': break;
     default: throw Error('Unexpected backend command: '+command);
    }
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
   });
   const page=await context.newPage();
   page.on('pageerror',e=>errors.push(String(e)));
   await page.goto(baseURL+'/?historyFixture=1');
   await page.getByText('本地测速测试账号',{exact:true}).waitFor();
   await page.getByTestId('token-speed-value').filter({hasText:'42.0'}).waitFor();
   const panel=page.getByTestId('token-speed-panel');
   for(const theme of ['light','dark']) {
    await page.evaluate(dark=>document.documentElement.classList.toggle('dark',dark),theme==='dark');
    const geometry=await page.evaluate(()=>({page:document.documentElement.scrollWidth,viewport:window.innerWidth,panel:document.querySelector('.neu-speed-panel').getBoundingClientRect().width}));
    assert.ok(geometry.page<=geometry.viewport,`${theme}-${size.width}: horizontal overflow`);
    assert.equal(await panel.getByRole('combobox').getAttribute('aria-label'),'测速会话');
    const name=`speed-${theme}-${size.width}`;
    await page.screenshot({path:path.join(output,name+'.png'),fullPage:true,animations:'disabled'});
    captures.push({name,...geometry});
   }
   if(size.width===1000) {
    const select=panel.getByRole('combobox');
    await select.selectOption('session-b');
    await page.getByTestId('token-speed-value').filter({hasText:'85.0'}).waitFor();
    state.sessions.reverse();
    await page.waitForTimeout(2300);
    assert.equal(await select.inputValue(),'session-b');
    assert.match(await page.getByTestId('token-speed-value').innerText(),/85\.0/);
    // Model change must clear the previous model's sample, including the average.
    state.sessions[0]={...session('session-b','gpt-test-new',10),latest:null,recent_average_tps:null,sample_count:0,state:'waiting'};
    await panel.getByText('gpt-test-new',{exact:true}).waitFor();
    assert.match(await page.getByTestId('token-speed-value').innerText(),/--/);
    assert.match(await page.getByTestId('token-speed-average').innerText(),/--/);
    // A pinned session disappearing must not silently show an unrelated session.
    state.sessions=[session('session-a','gpt-test-a',42)];
    await page.getByText('该会话已不在最近列表中，请重新选择',{exact:true}).waitFor();
    assert.match(await page.getByTestId('token-speed-value').innerText(),/--/);
    await select.selectOption('auto');
    await page.getByTestId('token-speed-value').filter({hasText:'42.0'}).waitFor();
    state.sessions[0].unavailable_reason='timing_unavailable';
    await page.getByTestId('token-speed-notice').filter({hasText:'保留上次有效样本'}).waitFor();
    assert.match(await page.getByTestId('token-speed-value').innerText(),/42\.0/);
    state.sessions[0].unavailable_reason=null;
    state.sessions[0].state='stale';
    state.sessions[0].latest_in_current_turn=false;
    await panel.getByText('历史记录',{exact:true}).waitFor();
    assert.match(await page.getByTestId('token-speed-notice').innerText(),/上一轮记录/);
    state.failed=true;
    await panel.getByText('读取暂不可用',{exact:true}).waitFor();
    assert.match(await page.getByTestId('token-speed-value').innerText(),/--/);
    state.failed=false;state.sessions=[];
    await page.getByText('尚未发现本机 Codex 会话，运行一次任务后即可采集',{exact:true}).waitFor();
    // Hidden windows should not keep polling, then resume immediately on visibility.
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
    await page.waitForTimeout(200);
    const before=state.calls;
    await page.waitForTimeout(2300);
    assert.equal(state.calls,before);
    state.sessions=[session('session-a','gpt-test-a',42)];
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'));});
    await page.getByTestId('token-speed-value').filter({hasText:'42.0'}).waitFor();
   }
   await panel.getByText('统计说明',{exact:true}).click();
   assert.ok((await panel.innerText()).includes('并非逐 token 实时测速'));
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
   // English localization must keep the new surface usable.
   await page.evaluate(()=>{localStorage.setItem('codex-switcher-language','en');window.dispatchEvent(new StorageEvent('storage',{key:'codex-switcher-language',newValue:'en'}));});
   await panel.getByText('Token output speed',{exact:true}).waitFor();
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
   await context.close();
  }
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'browser-report.json'),JSON.stringify({status:'pass',captures,errors},null,2));
  console.log('TOKEN_SPEED_UI_PASSED: 5 viewports, 10 light/dark screenshots, pinning, model changes, missing data, stale readings, reconnect, hidden-window polling and English.');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
