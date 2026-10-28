// Electron main process: desktop shell for ResearchPal.
// Spawns the backend as a child process and loads its UI in a native window
// -- no separate desktop UI to maintain, the web app *is* the desktop app.
//
// Two ways the backend gets run, chosen by `app.isPackaged`:
//   - Dev (`npm start` from source): the repo's own .venv Python, running
//     `uvicorn server:app` straight from source -- edits take effect on
//     restart with no rebuild.
//   - Packaged (installed .exe, built by `npm run dist`): a standalone
//     PyInstaller-frozen backend.exe bundled as an extraResource (see
//     build_backend.py and package.json's `build.extraResources`) -- no
//     Python installation required on the machine it's installed on.

const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");

const REPO_ROOT = path.resolve(__dirname, "..");
const PYTHON_EXE = process.platform === "win32"
  ? path.join(REPO_ROOT, ".venv", "Scripts", "python.exe")
  : path.join(REPO_ROOT, ".venv", "bin", "python");
const FROZEN_BACKEND_EXE = path.join(
  process.resourcesPath || "", "backend", process.platform === "win32" ? "backend.exe" : "backend"
);
let PORT = Number(process.env.OCE_PORT || 8501);
let BASE_URL = `http://127.0.0.1:${PORT}`;
const INSTANCE = require("crypto").randomUUID();
let managedOllama = null;
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); } });
function preferenceFile() { return path.join(app.getPath('userData'), 'workspace.json'); }
function readPreferences() { try { return JSON.parse(fs.readFileSync(preferenceFile(), 'utf8')); } catch { return {}; } }
async function choosePort() {
  return new Promise((resolve, reject) => {
    const server = require('net').createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

let backendProcess = null;
let mainWindow = null;

// Settings (Ollama host/model, data folder) are read/written straight to the
// backend's own .env via GET/PUT /api/settings -- the same file `dotenv`
// reloads on every process start, whether spawned by Electron or run
// directly. That keeps one source of truth instead of a second desktop-only
// config file that could drift out of sync with it. (core/config.py picks a
// sensible default .env/data location on its own when frozen -- an AppData
// folder, since an installed app can't assume its own install directory is
// writable -- so nothing extra needs passing here for that.)
function startBackend() {
  let command, args, cwd;

  if (app.isPackaged) {
    if (!fs.existsSync(FROZEN_BACKEND_EXE)) {
      dialog.showErrorBox("Backend not found", `Expected the bundled backend at:\n${FROZEN_BACKEND_EXE}\n\nThis build looks corrupted -- try reinstalling.`);
      app.quit();
      return;
    }
    command = FROZEN_BACKEND_EXE;
    args = [];
    cwd = path.dirname(FROZEN_BACKEND_EXE);
  } else {
    if (!fs.existsSync(PYTHON_EXE)) {
      dialog.showErrorBox(
        "Python environment not found",
        `Expected a virtualenv at:\n${PYTHON_EXE}\n\nSet one up first (see the project README's Setup section), then relaunch.`
      );
      app.quit();
      return;
    }
    command = PYTHON_EXE;
    args = ["-m", "uvicorn", "server:app", "--host", "127.0.0.1", "--port", String(PORT)];
    cwd = REPO_ROOT;
  }

  const preferences = readPreferences();
  backendProcess = spawn(command, args, { cwd, windowsHide: true, env: { ...process.env, OCE_PORT: String(PORT), RESEARCHPAL_INSTANCE: INSTANCE, ...(preferences.dataDir ? { OCE_DATA_DIR: preferences.dataDir } : {}) } });

  backendProcess.stdout.on("data", (d) => process.stdout.write(`[backend] ${d}`));
  backendProcess.stderr.on("data", (d) => process.stderr.write(`[backend] ${d}`));
  backendProcess.on("exit", (code) => {
    console.log(`[backend] exited with code ${code}`);
    backendProcess = null;
  });
}

function stopBackend() {
  if (!backendProcess) return;
  const pid = backendProcess.pid;
  backendProcess = null;
  if (process.platform === "win32") {
    // child_process.kill() on Windows just calls TerminateProcess on the
    // immediate process; uvicorn's own process is the one we want gone and
    // there are no further children in this single-process (no --workers,
    // no --reload) setup, but taskkill's /t is a cheap belt-and-suspenders
    // in case that ever changes.
    spawn("taskkill", ["/pid", String(pid), "/t", "/f"]);
  } else {
    try { process.kill(pid); } catch { /* already gone */ }
  }
}

function waitForBackend(retriesLeft = 60) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(`${BASE_URL}/api/status`, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try { const state = JSON.parse(body); if (res.statusCode === 200 && state.instance === INSTANCE) { resolve(); return; } } catch {}
          if (retriesLeft <= 0) reject(new Error('Backend health check failed'));
          else setTimeout(() => waitForBackend(retriesLeft - 1).then(resolve, reject), 500);
        });
      });
      req.setTimeout(3000, () => req.destroy());
      req.on("error", () => {
        if (retriesLeft <= 0) return reject(new Error("Backend did not start in time"));
        setTimeout(() => waitForBackend(retriesLeft - 1).then(resolve, reject), 500);
      });
    };
    attempt();
  });
}

const LOADING_HTML = `data:text/html,${encodeURIComponent(`
  <body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0b0d12;color:#e6e8ee;font-family:-apple-system,Segoe UI,Roboto,sans-serif;">
    <div style="text-align:center;">
      <div style="font-size:40px;margin-bottom:12px;">🦉</div>
      <div>Starting ResearchPal…</div>
    </div>
  </body>
`)}`;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "ResearchPal",
    icon: path.join(__dirname, "build", process.platform === "win32" ? "icon.ico" : "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(LOADING_HTML);
  try {
    await waitForBackend();
    mainWindow.loadURL(BASE_URL);
  } catch (err) {
    dialog.showErrorBox("Backend failed to start", String(err));
  }
}

ipcMain.handle("pick-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("restart-backend", async () => {
  stopBackend();
  await new Promise((r) => setTimeout(r, 300));
  startBackend();
  await waitForBackend();
  mainWindow.loadURL(BASE_URL);
  return { ok: true };
});

app.whenReady().then(async () => {
  if (!gotLock) return;
  PORT = await choosePort();
  BASE_URL = `http://127.0.0.1:${PORT}`;
  startBackend();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopBackend();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => { stopBackend(); if (managedOllama) { managedOllama.kill(); managedOllama = null; } });
ipcMain.handle('set-data-directory', async (_event, directory) => {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || !fs.statSync(directory).isDirectory()) throw new Error('Choose an existing absolute folder');
  fs.mkdirSync(path.dirname(preferenceFile()), {recursive:true});
  fs.writeFileSync(preferenceFile(), JSON.stringify({...readPreferences(), dataDir:directory}));
  return {ok:true};
});
ipcMain.handle('start-ollama', async (_event, options) => {
  const host = new URL(options.host);
  if (!['localhost', '127.0.0.1'].includes(host.hostname) || host.protocol !== 'http:') throw new Error('App-managed Ollama requires a loopback http URL');
  if (options.modelsDir && (!path.isAbsolute(options.modelsDir) || !fs.statSync(options.modelsDir).isDirectory())) throw new Error('Choose an existing absolute model folder');
  const running = await new Promise(resolve => {
    const req = http.get(`${host.origin}/api/tags`, res => {res.resume();resolve(true);});
    req.setTimeout(1500,()=>req.destroy());req.on('error',()=>resolve(false));
  });
  if (running) return {ok:false,message:'Ollama is already running. Restart that service with your new OLLAMA_MODELS folder, then Discover. ResearchPal will not replace an external service.'};
  if (managedOllama) return {ok:false,message:'An app-managed Ollama service is already starting.'};
  const ollamaCandidates = [options.executable, path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'), path.join(process.env.ProgramFiles || '', 'Ollama', 'ollama.exe')].filter(Boolean);
  const executable = ollamaCandidates.find(candidate => fs.existsSync(candidate)) || 'ollama';
  managedOllama = spawn(executable, ['serve'], {windowsHide:true,env:{...process.env,OLLAMA_HOST:host.host,...(options.modelsDir?{OLLAMA_MODELS:options.modelsDir}:{})},stdio:'ignore'});
  return await new Promise(resolve => {
    let settled = false;
    managedOllama.once('error', () => { managedOllama=null;if(!settled){settled=true;resolve({ok:false,message:'Ollama executable was not found. Install Ollama and make it available on PATH.'});} });
    managedOllama.once('exit',()=>{managedOllama=null;});
    setTimeout(()=>{if(!settled){settled=true;resolve({ok:!!managedOllama,message:managedOllama?'Ollama started with the selected folder. Give it a moment, then Discover models.':'Ollama stopped during startup. Check its installation and model folder.'});}},1000);
  });
});
