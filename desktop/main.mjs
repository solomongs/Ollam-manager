import {app, BrowserWindow, Menu, dialog, shell, clipboard, session} from 'electron';
import fs from 'node:fs/promises';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {APP_NAME, APP_ID, WEB_PREFERENCES, configureWindow, configureSession, parseSmokeArguments} from './security.mjs';
import {startRuntime, readInitialPassword, getJSON} from './runtime.mjs';

const desktopDir = path.dirname(fileURLToPath(import.meta.url));
const RELEASES_URL = 'https://github.com/solomongs/Ollam-manager/releases/latest';
let smoke;
try { smoke = parseSmokeArguments(process.argv); }
catch (error) { console.error(error.message); app.exit(2); }

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);
app.enableSandbox();
const userDataPath = smoke?.enabled ? smoke.userData : path.join(app.getPath('appData'), APP_NAME);
mkdirSync(userDataPath, {recursive:true, mode:0o700});
app.setPath('userData', userDataPath);

let runtime;
let window;
let quitting = false;
let shutdown;
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

function focusWindow() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
app.on('second-instance', focusWindow);
app.on('activate', focusWindow);
app.on('window-all-closed', () => app.quit());

function stopRuntime() {
  if (!shutdown) shutdown = runtime?.manager.close() || Promise.resolve();
  return shutdown;
}
app.on('before-quit', event => {
  if (quitting || !runtime) return;
  event.preventDefault();
  quitting = true;
  // Let cancelled tool calls and chat/jobs persist before the app exits.
  const deadline = setTimeout(() => app.exit(0), 8000);
  stopRuntime().catch(error => console.error(`Shutdown failed: ${error.message}`)).finally(() => {
    clearTimeout(deadline);
    app.quit();
  });
});

async function passwordDialog() {
  const password = await readInitialPassword(runtime.dataDir);
  const buttons = password ? ['Copy password', 'Close'] : ['Close'];
  const answer = await dialog.showMessageBox(window, {
    type:'info',
    title:'Initial administrator password',
    message:password ? 'Use this password for your first login.' : 'No initial password file is available.',
    detail:password ? `${password}\n\nThis is the generated initial password. If you changed it, use your current password. It is stored in your local data folder as first-login.txt.` : 'Use your current administrator password. You can open the data folder from the Application menu.',
    buttons,
    defaultId:buttons.length - 1,
    cancelId:buttons.length - 1,
    noLink:true,
  });
  if (password && answer.response === 0) clipboard.writeText(password);
}

function menuAction(action) {
  return () => Promise.resolve(action()).catch(error => dialog.showErrorBox(APP_NAME, error.message));
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {label:'Application', submenu:[
      {label:'Settings', accelerator:'CmdOrCtrl+,', click:() => window.loadURL(`${runtime.origin}/#settings`)},
      {label:'Initial administrator password…', click:menuAction(passwordDialog)},
      {type:'separator'},
      {label:'Open data folder', click:menuAction(async () => { const error = await shell.openPath(runtime.dataDir); if (error) throw new Error(error); })},
      {label:'Open GGUF import folder', click:menuAction(async () => { const error = await shell.openPath(runtime.importsDir); if (error) throw new Error(error); })},
      {type:'separator'},
      {role:'quit'},
    ]},
    {label:'Edit', submenu:[{role:'undo'}, {role:'redo'}, {type:'separator'}, {role:'cut'}, {role:'copy'}, {role:'paste'}, {role:'selectAll'}]},
    {label:'View', submenu:[{role:'reload'}, {type:'separator'}, {role:'resetZoom'}, {role:'zoomIn'}, {role:'zoomOut'}, {type:'separator'}, {role:'togglefullscreen'}]},
    {label:'Help', submenu:[
      {label:'Download app update…', click:menuAction(() => shell.openExternal(RELEASES_URL))},
      {label:'About Spark Ollama Manager', click:menuAction(() => dialog.showMessageBox(window, {
        type:'info', title:`About ${APP_NAME}`, message:`${APP_NAME} ${app.getVersion()}`,
        detail:'Developed by Solomon.\n\nOllama runs separately, on this computer or a private server. This desktop app uses a local authenticated backend.\n\nWindows installers are unsigned.', buttons:['Close'],
      }))},
    ]},
  ]));
}

async function openWindow() {
  const desktopSession = session.fromPartition('persist:desktop-workspace');
  configureSession(desktopSession, runtime.origin);
  window = new BrowserWindow({
    title:APP_NAME, width:1440, height:980, minWidth:440, minHeight:640,
    show:false, backgroundColor:'#101211',
    webPreferences:{...WEB_PREFERENCES, session:desktopSession},
  });
  configureWindow(window, runtime.origin, url => shell.openExternal(url));
  window.on('closed', () => { window = null; });
  window.once('ready-to-show', () => { if (!smoke.enabled) window.show(); });
  await window.loadURL(`${runtime.origin}/`);
  return window;
}

async function runSmoke() {
  const health = await getJSON(runtime.origin, '/api/health');
  const auth = await getJSON(runtime.origin, '/api/session');
  if (!health.ok || health.version !== app.getVersion() || auth.authenticated !== false) throw new Error('Packaged backend health/version/authentication smoke check failed.');
  // Main-process inspection only: no privileged bridge or preload is exposed to the renderer.
  const renderer = await window.webContents.executeJavaScript('(() => {const key="spark-desktop-smoke-storage";const prior=localStorage.getItem(key);localStorage.setItem(key,"persisted");return {node:typeof process !== "undefined" || typeof require !== "undefined",title:document.title,root:!!document.getElementById("app"),storageRestored:prior==="persisted"}})()');
  const preferences = window.webContents.getLastWebPreferences();
  if (renderer.node || !renderer.root || !preferences.sandbox || !preferences.contextIsolation || preferences.nodeIntegration || preferences.webSecurity === false) throw new Error('Packaged renderer isolation smoke check failed.');
  await fs.mkdir(path.dirname(smoke.output), {recursive:true});
  session.fromPartition('persist:desktop-workspace').flushStorageData();
  await fs.writeFile(smoke.output, `${JSON.stringify({ok:true, version:health.version, origin:runtime.origin, platform:process.platform, arch:process.arch, packaged:app.isPackaged, rendererIsolated:true, authenticated:false, storageRestored:renderer.storageRestored}, null, 2)}\n`, {mode:0o600});
  await stopRuntime();
  quitting = true;
  app.quit();
}

if (gotLock) app.whenReady().then(async () => {
  const sourceDir = app.isPackaged ? path.join(process.resourcesPath, 'app') : path.resolve(desktopDir, '..');
  runtime = await startRuntime({sourceDir, userData:app.getPath('userData')});
  await openWindow();
  if (smoke.enabled) return runSmoke();
  installMenu();
  const marker = path.join(runtime.dataDir, 'desktop-password-shown');
  const shown = await fs.stat(marker).then(() => true, () => false);
  if (!shown) {
    await passwordDialog();
    await fs.writeFile(marker, '1\n', {mode:0o600});
  }
}).catch(async error => {
  await stopRuntime().catch(() => {});
  if (smoke?.enabled) {
    await fs.mkdir(path.dirname(smoke.output), {recursive:true}).catch(() => {});
    await fs.writeFile(smoke.output, `${JSON.stringify({ok:false, error:error.message})}\n`, {mode:0o600}).catch(() => {});
  } else dialog.showErrorBox(`${APP_NAME} could not start`, error.message);
  quitting = true;
  app.exit(1);
});
