// Optional browser verification: Playwright must be available to Node.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createManager } from '../server.mjs';
import { startFixture } from './ui-ollama-fixture.mjs';
import { startMcpFixture } from './ui-mcp-fixture.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(),'spark-browser-'));
const importRoot = path.join(temporary,'imports');
await fs.mkdir(importRoot);
await fs.writeFile(path.join(importRoot,'fixture-mini.gguf'),Buffer.concat([Buffer.from('GGUF'),Buffer.alloc(124)]));
const fixture = await startFixture(0);
const mcpFixture = await startMcpFixture();
const manager = await createManager({host:'127.0.0.1',port:0,dataDir:path.join(temporary,'data'),importRoots:[importRoot],ollamaUrl:`http://127.0.0.1:${fixture.address().port}`,initialPassword:'browser-test-password-only'});
const address = await manager.start();
const url = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {}),...(process.env.PLAYWRIGHT_CHROMIUM_ARGS ? {args:JSON.parse(process.env.PLAYWRIGHT_CHROMIUM_ARGS)} : {})});
const context = await browser.newContext({viewport:{width:1440,height:1050}});
const page = await context.newPage();
const errors = [];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
const screenshotDir = process.env.SCREENSHOT_DIR;
if(screenshotDir) await fs.mkdir(screenshotDir,{recursive:true});
async function navigate(name) {
  await page.locator(`.sidebar [data-page="${name}"]`).click();
  await page.waitForFunction(p=>location.hash==='#'+p,name);
  await page.locator('main h1').waitFor();
}
async function noOverflow(label) {
  const dimensions=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));
  assert.ok(dimensions.scroll<=dimensions.width+1,`${label} overflows by ${dimensions.scroll-dimensions.width}px`);
}
async function waitJob(type,model) {
  await page.waitForFunction(async({type,model})=> {
    const jobs=await (await fetch('/api/jobs')).json();
    return jobs.some(j=>j.type===type&&j.model===model&&j.status==='completed');
  },{type,model},{timeout:12000});
}
async function currentState() {return page.evaluate(async()=>await (await fetch('/api/state')).json());}
try {
  await page.goto(url);
  await page.locator('#password').fill('browser-test-password-only');
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('.sidebar').waitFor();
  await page.getByText('Ollama connected',{exact:true}).waitFor();
  await noOverflow('desktop overview');
  if(screenshotDir) await page.screenshot({path:path.join(screenshotDir,'desktop-overview.png'),fullPage:true,animations:'disabled'});
  for(const name of ['models','discover','downloads','studio','chat','benchmark','mcp','settings']) {
    await navigate(name); await noOverflow('desktop '+name);
  }
  await navigate('models');
  await page.locator('#model-search').fill('no-match');
  assert.equal(await page.locator('.models-table tbody tr').count(),0);
  await page.locator('#model-search').fill('fixture');
  await page.locator('[data-action=show-model]').first().click();
  await page.locator('dialog').getByText('completion, vision',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.locator('[data-action=copy-model]').first().click();
  await page.locator('#copy-destination').fill('fixture-copy:small');
  await page.locator('#copy-form button[type=submit]').click();
  await page.getByText('fixture-copy:small',{exact:true}).waitFor();
  await page.locator('[data-action=pull-dialog]').click();
  await page.locator('#pull-model').fill('fixture-download:small');
  await page.locator('#pull-form button[type=submit]').click();
  await waitJob('pull','fixture-download:small');
  await navigate('studio');
  await page.locator('#create-form [name=model]').fill('fixture-custom:small');
  await page.locator('#create-form [name=from]').selectOption('fixture-model:small');
  await page.locator('#create-form [name=system]').fill('Answer briefly.');
  await page.locator('#create-form button[type=submit]').click();
  await waitJob('create','fixture-custom:small');
  await navigate('studio');
  await page.locator('[data-action=studio-import]').click();
  await page.locator('#import-form [name=path] option[value]').nth(1).waitFor({state:'attached'});
  await page.locator('#import-form [name=path]').selectOption({label:'fixture-mini.gguf · 128 B'}).catch(async()=> {
    const value=await page.locator('#import-form [name=path] option').last().getAttribute('value');
    await page.locator('#import-form [name=path]').selectOption(value);
  });
  await page.locator('#import-form [name=model]').fill('fixture-import:small');
  await page.locator('#import-form button[type=submit]').click();
  await waitJob('import','fixture-import:small');
  await navigate('benchmark');
  await page.locator('#benchmark-form [name=model]').selectOption('fixture-model:small');
  await page.locator('#benchmark-form button[type=submit]').click();
  await waitJob('benchmark','fixture-model:small');
  await page.waitForFunction(()=>document.querySelector('.bench-results')?.textContent.includes('100'),undefined,{timeout:10000});
  await navigate('chat');
  await page.locator('#chat-model').selectOption('fixture-model:small');
  await page.locator('#chat-input').fill('Verify streaming and saved history.');
  await page.locator('#chat-form button[type=submit]').click();
  await page.locator('.message.assistant .message-body').filter({hasText:'the stream works.'}).waitFor();
  await page.waitForFunction(async()=> (await (await fetch('/api/state')).json()).chats.length===1);
  if(screenshotDir) await page.screenshot({path:path.join(screenshotDir,'desktop-chat.png'),fullPage:true,animations:'disabled'});
  await page.reload();
  await page.locator('[data-action=open-chat]').first().click();
  await page.locator('.message.assistant .message-body').filter({hasText:'the stream works.'}).waitFor();
  // Create, test and inspect an MCP connection through the real UI.
  await navigate('mcp');
  await page.locator('[data-action=mcp-add]').first().click();
  await page.locator('#mcp-form [name=name]').fill('Spark note fixture');
  await page.locator('#mcp-transport').selectOption('http');
  await page.locator('#mcp-form [name=url]').fill(mcpFixture.url);
  await page.locator('#mcp-form [name=bearerToken]').fill('browser-fixture-token');
  await page.locator('#mcp-form [name=enabled]').check();
  await page.locator('#mcp-form button[type=submit]').click();
  await page.locator('#dialog').waitFor({state:'hidden'});
  await page.waitForFunction(async()=> (await (await fetch('/api/state')).json()).mcpServers?.length===1);
  const mcpId = (await currentState()).mcpServers[0].id;
  assert.equal(JSON.stringify(await currentState()).includes('browser-fixture-token'),false,'MCP credentials must not be returned');
  await page.locator('[data-action=mcp-test]').click();
  await page.getByText('browser-mcp-fixture',{exact:false}).first().waitFor();
  await page.locator('[data-action=mcp-tools]').click();
  await page.locator('dialog').getByText('read_spark_note',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.locator('[data-action=mcp-edit]').click();
  assert.equal(await page.locator('#mcp-form [name=bearerToken]').inputValue(),'','Saved tokens stay hidden');
  await page.locator('#mcp-form [name=name]').fill('Spark note fixture edited');
  await page.locator('#mcp-form button[type=submit]').click();
  await page.locator('#dialog').waitFor({state:'hidden'});
  await page.waitForFunction(async()=> (await (await fetch('/api/state')).json()).mcpServers?.[0]?.name==='Spark note fixture edited');
  assert.equal((await currentState()).mcpServers[0].hasToken,true,'Editing without a token preserves credentials');
  if(screenshotDir) await page.screenshot({path:path.join(screenshotDir,'desktop-mcp.png'),fullPage:true,animations:'disabled'});
  async function startToolChat() {
    await page.locator('[data-action=new-chat]').first().click();
    await page.locator('#chat-model').selectOption('fixture-model:small');
    await page.locator('[data-action=mcp-select]').click();
    await page.locator(`#mcp-select-form [name=mcpServerIds][value="${mcpId}"]`).check();
    await page.locator('#mcp-select-form button[type=submit]').click();
    await page.locator('#chat-input').fill('Use MCP to read the Spark note.');
    await page.locator('#chat-form button[type=submit]').click();
    await page.locator('[data-action=tool-approve]').waitFor();
  }
  await navigate('chat');
  await startToolChat();
  assert.equal(mcpFixture.calls.length,0,'MCP tool must not execute before approval');
  await noOverflow('desktop pending MCP approval');
  await page.setViewportSize({width:390,height:844});
  await noOverflow('mobile pending MCP approval');
  if(screenshotDir) await page.screenshot({path:path.join(screenshotDir,'mobile-mcp-approval.png'),fullPage:true,animations:'disabled'});
  await page.locator('[data-action=tool-approve]').click();
  await page.locator('.message.assistant .message-body').filter({hasText:'Tool reply received:'}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('[data-action=stop-chat]'));
  assert.equal(mcpFixture.calls.length,1);
  await page.reload();
  await page.locator('[data-action=chat-history]').click();
  await page.locator('dialog [data-action=open-chat]').first().click();
  await page.getByText('read_spark_note',{exact:true}).first().waitFor();
  await page.setViewportSize({width:1440,height:1050});
  await startToolChat();
  await page.locator('[data-action=tool-deny]').click();
  await page.locator('.message.assistant .message-body').filter({hasText:'Tool reply received:'}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('[data-action=stop-chat]'));
  assert.equal(mcpFixture.calls.length,1,'Denied tool must not execute');
  await navigate('mcp');
  await page.locator('[data-action=mcp-toggle]').click();
  await page.waitForFunction(async()=> !(await (await fetch('/api/state')).json()).mcpServers?.[0]?.enabled);
  await page.locator('[data-action=mcp-toggle]').click();
  await page.waitForFunction(async()=> (await (await fetch('/api/state')).json()).mcpServers?.[0]?.enabled);
  await navigate('settings');
  await page.locator('#settings-form [name=title]').fill('Solomon’s Spark');
  await page.locator('#settings-form button[type=submit]').click();
  assert.equal((await currentState()).settings.title,'Solomon’s Spark');
  await navigate('overview');
  await page.locator('main h1').filter({hasText:'Solomon’s Spark'}).waitFor();
  const cacheURLs=await page.evaluate(async()=> {
    const result=[];for(const key of await caches.keys()){const cache=await caches.open(key);for(const request of await cache.keys())result.push(request.url);}return result;
  });
  assert.ok(cacheURLs.every(item=>!new URL(item).pathname.startsWith('/api/')),'API responses must never be cached');
  for(const width of [360,390,430,768]) {
    await page.setViewportSize({width,height:844});
    for(const name of ['overview','models','chat','downloads']) {
      await page.locator(`.mobile-nav [data-page="${name}"]`).click();
      await noOverflow(`mobile ${width} ${name}`);
    }
    await page.locator('.mobile-nav [data-action=more]').click();
    await page.locator('dialog [data-page=settings]').click();
    await page.locator('#settings-form').waitFor(); await noOverflow(`mobile ${width} settings`);
    await page.locator('.mobile-nav [data-action=more]').click();
    await page.locator('dialog [data-page=studio]').click();
    await noOverflow(`mobile ${width} studio`);
    await page.locator('.mobile-nav [data-action=more]').click();
    await page.locator('dialog [data-page=mcp]').click();
    await page.locator('[data-action=mcp-add]').first().click();
    await noOverflow(`mobile ${width} MCP form`);
    await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  }
  await page.setViewportSize({width:390,height:844});
  await page.locator('.mobile-nav [data-page=overview]').click();
  if(screenshotDir) await page.screenshot({path:path.join(screenshotDir,'mobile-overview.png'),fullPage:false,animations:'disabled'});
  assert.deepEqual(errors,[],'Browser console and page errors');
  console.log('Browser verification passed: desktop workflows, MCP CRUD/discovery, hidden credentials, approved/denied tool chat and saved history, branding, PWA API exclusion, 360/390/430/768px navigation and layout.');
} catch (error) {
  console.error('Browser failure:',error.message);
  console.error(await page.evaluate(()=>({hash:location.hash,dialogOpen:document.querySelector('#dialog').open,dialogText:document.querySelector('#dialog').innerText,toast:document.querySelector('#toast').innerText})));
  if(screenshotDir) await page.screenshot({path:path.join(screenshotDir,'browser-failure.png'),fullPage:true,animations:'disabled'});
  throw error;
} finally {
  await browser.close(); await manager.close(); fixture.closeAllConnections();
  await new Promise(resolve=>fixture.close(resolve)); await mcpFixture.close(); await fs.rm(temporary,{recursive:true,force:true});
}
