import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { createManager, VERSION } from '../server.mjs';

const PASSWORD='updates-test-password-long';
const RELEASE_API='https://api.github.com/repos/solomongs/Ollam-manager/releases/latest';
async function fixture(t,options={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'spark-updates-test-'));
  const manager=await createManager({host:'127.0.0.1',port:0,dataDir:directory,initialPassword:PASSWORD,...options});
  const address=await manager.start(),base=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{await manager.close();await fs.rm(directory,{recursive:true,force:true});});
  const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({password:PASSWORD})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0],csrf=(await login.json()).csrf;
  async function get(route='/api/updates',authenticated=true) {const response=await fetch(base+route,{headers:authenticated?{Cookie:cookie}:{}});return{status:response.status,data:await response.json()};}
  return{manager,directory,base,cookie,csrf,get};
}

test('update metadata is authenticated, fixed-origin and read-only without an automatic release fetch',async t=>{
  let fetches=0;
  const f=await fixture(t,{releaseFetcher:async()=>{fetches++;return{tag_name:'v1.3.0'};}});
  assert.equal((await f.get('/api/updates',false)).status,401);
  const before=await fs.readFile(path.join(f.directory,'state.json'),'utf8');
  const result=await f.get();assert.equal(result.status,200);assert.equal(fetches,0);
  assert.equal(result.data.installedVersion,'1.2.0');assert.equal(result.data.installedVersion,VERSION);
  assert.equal(result.data.platform,process.platform);assert.equal(result.data.arch,process.arch);assert.equal(result.data.installationMode,'source');assert.equal(result.data.latest.status,'not-checked');
  assert.equal(result.data.repositoryUrl,'https://github.com/solomongs/Ollam-manager');assert.equal(result.data.releaseApiUrl,RELEASE_API);
  assert.equal(result.data.update.gitCommand,'node scripts/update.mjs --check\nnode scripts/update.mjs');assert.equal(result.data.update.command,result.data.update.gitCommand);
  for(const packageInfo of Object.values(result.data.packages))assert.match(packageInfo.url,/^https:\/\/github\.com\/solomongs\/Ollam-manager\//);
  assert.match(result.data.packages.windows.x64Url,/Spark-Ollama-Manager-1\.2\.0-windows-x64-setup\.exe$/);
  assert.match(result.data.packages.windows.arm64Url,/Spark-Ollama-Manager-1\.2\.0-windows-arm64-setup\.exe$/);
  assert.match(result.data.packages.dgx.url,/spark-ollama-manager_1\.2\.0_arm64\.deb$/);
  for(const route of ['/api/updates?url=http://169.254.169.254','/api/updates?check=1&url=https://example.com','/api/updates?check=no','/api/updates?check=1&check=1'])assert.equal((await f.get(route)).status,400);
  assert.equal(fetches,0);
  const response=await fetch(f.base+'/api/updates',{method:'POST',headers:{Origin:f.base,Cookie:f.cookie,'X-CSRF-Token':f.csrf,'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,404);
  assert.equal(await fs.readFile(path.join(f.directory,'state.json'),'utf8'),before);
});

test('release checks use the one fixed GitHub API, compare versions and cache concurrent checks',async t=>{
  let fetches=0;
  const f=await fixture(t,{releaseFetcher:async(url,{signal})=>{assert.equal(url,RELEASE_API);assert.equal(signal.aborted,false);fetches++;await new Promise(resolve=>setTimeout(resolve,30));return{tag_name:'v1.10.0',html_url:'https://malicious.example/ignored',assets:[{browser_download_url:'https://malicious.example/ignored'}]};}});
  const results=await Promise.all([f.get('/api/updates?check=1'),f.get('/api/updates?check=1')]);assert.equal(fetches,1);
  for(const result of results){assert.equal(result.status,200);assert.equal(result.data.latest.status,'available');assert.equal(result.data.latest.version,'1.10.0');assert.ok(result.data.latest.checkedAt);assert.equal(JSON.stringify(result.data).includes('malicious.example'),false);assert.match(result.data.packages.dgx.url,/v1\.10\.0\/spark-ollama-manager_1\.10\.0_arm64\.deb$/);}
  assert.equal((await f.get()).data.latest.version,'1.10.0');await f.get('/api/updates?check=1');assert.equal(fetches,1);
});

test('older/current remote releases cannot recommend a downgrade',async t=>{
  const f=await fixture(t,{releaseFetcher:async()=>({tag_name:'v1.1.0'})});
  const result=await f.get('/api/updates?check=1');assert.equal(result.data.latest.status,'current');assert.equal(result.data.latest.version,'1.1.0');assert.match(result.data.packages.dgx.url,/v1\.2\.0\/spark-ollama-manager_1\.2\.0_arm64\.deb$/);
});

test('unavailable, unsafe or prerelease metadata produces a usable cached update panel',async t=>{
  for(const candidate of [{tag_name:'v2.0.0; touch /tmp/no'},{tag_name:'v2.0.0-beta.1'},{tag_name:'v2.0.0',draft:true},{tag_name:'v2.0.0',prerelease:true},null]){
    const f=await fixture(t,{releaseFetcher:async()=>candidate});const result=await f.get('/api/updates?check=1');assert.equal(result.status,200);assert.equal(result.data.latest.status,'unavailable');assert.ok(result.data.latest.error);assert.match(result.data.packages.dgx.url,/1\.2\.0_arm64\.deb$/);
  }
  let attempts=0;const f=await fixture(t,{releaseFetcher:async()=>{attempts++;throw new Error('Offline release check');}});assert.equal((await f.get('/api/updates?check=1')).data.latest.error,'Offline release check');await f.get('/api/updates?check=1');assert.equal(attempts,1);
});

test('update commands suit desktop, DGX package, service and container modes',async t=>{
  for(const mode of ['desktop','deb','dgx','service','source','container']){
    const f=await fixture(t,{installationMode:mode});const result=await f.get();assert.equal(result.data.installationMode,mode);assert.ok(result.data.update.instructions);
    assert.equal(result.data.update.gitCommand,'node scripts/update.mjs --check\nnode scripts/update.mjs');
    if(mode==='desktop'||mode==='container')assert.equal(result.data.update.command,'');
    if(mode==='deb')assert.equal(result.data.update.command,'sudo apt install ./spark-ollama-manager_1.2.0_arm64.deb');
    if(mode==='source')assert.equal(result.data.update.command,result.data.update.gitCommand);
    if(mode==='dgx'||mode==='service')assert.equal(result.data.update.command,result.data.update.gitCommand+'\nsudo bash install.sh');
  }
});

test('release-check timeout and service shutdown abort pending fetches promptly',async t=>{
  let signal;
  const f=await fixture(t,{releaseCheckTimeoutMs:80,releaseFetcher:async(_url,options)=>{signal=options.signal;return new Promise(()=>{});}});
  const started=performance.now(),result=await f.get('/api/updates?check=1');assert.ok(performance.now()-started<1000);assert.equal(result.data.latest.status,'unavailable');assert.equal(signal.aborted,true);
  let closeSignal;
  const g=await fixture(t,{releaseFetcher:async(_url,options)=>{closeSignal=options.signal;return new Promise(()=>{});}});
  const pending=g.get('/api/updates?check=1');pending.catch(()=>{});
  for(let index=0;index<50&&!closeSignal;index++)await new Promise(resolve=>setTimeout(resolve,10));
  await g.manager.close();assert.equal(closeSignal.aborted,true);assert.equal((await pending).data.latest.status,'unavailable');
});

test('explicit null publicOrigin overrides inherited reverse proxy configuration for desktop',async t=>{
  const inherited=process.env.PUBLIC_ORIGIN;process.env.PUBLIC_ORIGIN='https://inherited.example.ts.net';
  try{const f=await fixture(t,{publicOrigin:null,installationMode:'desktop'});assert.equal((await f.get()).status,200);}finally{if(inherited===undefined)delete process.env.PUBLIC_ORIGIN;else process.env.PUBLIC_ORIGIN=inherited;}
});
