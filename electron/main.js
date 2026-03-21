const { app, BrowserWindow, Menu, ipcMain, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let mainWindow;
let flaskProcess = null;
let expressServer = null;
const FLASK_PORT = 5000;
const EXPRESS_PORT = 5055;
let activePort = null;

// === Storage reset helpers ===
const resetFlagPath = () => path.join(app.getPath('userData'), '.reset-storage');

function shouldResetStorage() {
    return fs.existsSync(resetFlagPath());
}

async function clearAllStorage() {
    console.log('[Reset] Clearing all Chromium storage data...');
    try {
        await session.defaultSession.clearStorageData({
            storages: ['localstorage', 'indexdb', 'cookies', 'cachestorage', 'serviceworkers']
        });
        console.log('[Reset] clearStorageData done');
    } catch (err) {
        console.error('[Reset] clearStorageData failed:', err.message);
    }
    // Also delete Local Storage leveldb files directly (file:// protocol workaround)
    try {
        const lsDir = path.join(app.getPath('userData'), 'Local Storage');
        if (fs.existsSync(lsDir)) {
            fs.rmSync(lsDir, { recursive: true, force: true });
            console.log('[Reset] Deleted Local Storage directory');
        }
    } catch (err) {
        console.error('[Reset] Failed to delete Local Storage dir:', err.message);
    }
    // Remove the flag file
    try { fs.unlinkSync(resetFlagPath()); } catch (e) {}
}

// === Flask sidecar (preferred backend) ===
function startFlaskServer() {
    return new Promise((resolve) => {
        const dbDir = path.join(app.getPath('userData'), 'database');
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        // Copy seed database if needed
        const dbPath = path.join(dbDir, 'pos.db');
        const srcDb = path.join(__dirname, '..', 'database', 'pos.db');
        if (!fs.existsSync(dbPath) && fs.existsSync(srcDb)) {
            fs.copyFileSync(srcDb, dbPath);
        }

        // Try to find Python
        const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
        const serverPy = path.join(__dirname, '..', 'server.py');

        if (!fs.existsSync(serverPy)) {
            console.warn('[Flask] server.py not found, skipping Flask');
            resolve(false);
            return;
        }

        const env = {
            ...process.env,
            POS_DB_DIR: dbDir,
            POS_PORT: String(FLASK_PORT),
            FLASK_ENV: 'production'
        };

        try {
            flaskProcess = spawn(pythonCmd, [serverPy], {
                cwd: path.join(__dirname, '..'),
                env: env,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let started = false;
            const timeout = setTimeout(() => {
                if (!started) {
                    console.warn('[Flask] Startup timeout, falling back to Express');
                    resolve(false);
                }
            }, 8000);

            flaskProcess.stdout.on('data', (data) => {
                const output = data.toString();
                console.log('[Flask]', output.trim());
                if (!started && (output.includes('Running on') || output.includes('Serving Flask'))) {
                    started = true;
                    clearTimeout(timeout);
                    activePort = FLASK_PORT;
                    console.log(`[Flask] Server started on port ${FLASK_PORT}`);
                    resolve(true);
                }
            });

            flaskProcess.stderr.on('data', (data) => {
                const output = data.toString();
                // Flask logs to stderr by default
                if (!started && (output.includes('Running on') || output.includes('Serving Flask'))) {
                    started = true;
                    clearTimeout(timeout);
                    activePort = FLASK_PORT;
                    console.log(`[Flask] Server started on port ${FLASK_PORT}`);
                    resolve(true);
                }
                if (output.includes('Error') || output.includes('error')) {
                    console.error('[Flask]', output.trim());
                }
            });

            flaskProcess.on('error', (err) => {
                console.warn('[Flask] Failed to start:', err.message);
                clearTimeout(timeout);
                flaskProcess = null;
                resolve(false);
            });

            flaskProcess.on('exit', (code) => {
                console.log(`[Flask] Process exited with code ${code}`);
                if (!started) {
                    clearTimeout(timeout);
                    flaskProcess = null;
                    resolve(false);
                }
            });

        } catch (err) {
            console.warn('[Flask] Spawn failed:', err.message);
            resolve(false);
        }
    });
}

// === Express fallback (deprecated - will be removed in future) ===
function startExpressServer() {
    const dbDir = path.join(app.getPath('userData'), 'database');
    const frontendDir = path.join(__dirname, '..', 'frontend');
    const backupsDir = path.join(dbDir, 'backups');

    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    const dbPath = path.join(dbDir, 'pos.db');
    const srcDb = path.join(__dirname, '..', 'database', 'pos.db');
    if (!fs.existsSync(dbPath) && fs.existsSync(srcDb)) {
        fs.copyFileSync(srcDb, dbPath);
    }

    const portsToTry = [EXPRESS_PORT, EXPRESS_PORT + 1, EXPRESS_PORT + 2, EXPRESS_PORT + 3];
    for (const port of portsToTry) {
        try {
            const { startServer } = require('./server');
            expressServer = startServer({
                port: port,
                dbDir: dbDir,
                frontendDir: frontendDir,
                backupsDir: backupsDir
            });
            activePort = port;
            console.log(`[Express] Fallback server started on port ${port}`);
            return true;
        } catch (err) {
            console.error(`[Express] Port ${port} failed: ${err.message}`);
        }
    }
    return false;
}

// === Start server (Flask first, Express fallback) ===
async function startServer() {
    console.log('[Server] Attempting Flask sidecar...');
    const flaskOk = await startFlaskServer();

    if (!flaskOk) {
        console.log('[Server] Flask unavailable, falling back to Express...');
        const expressOk = startExpressServer();
        if (!expressOk) {
            dialog.showErrorBox(
                'Server Error',
                'Could not start either Flask or Express server.\n' +
                'Make sure Python 3 with Flask is installed, or Node.js dependencies are available.'
            );
        }
    }

    return activePort;
}

// === Window ===
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        title: 'POS Offline - نظام نقاط البيع',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        autoHideMenuBar: true
    });

    const menuTemplate = [
        {
            label: 'النظام',
            submenu: [
                { label: 'تحديث', accelerator: 'F5', click: () => mainWindow.reload() },
                { label: 'أدوات المطور', accelerator: 'F12', click: () => mainWindow.webContents.toggleDevTools() },
                { type: 'separator' },
                {
                    label: 'إعادة تعيين البيانات',
                    click: async () => {
                        const choice = dialog.showMessageBoxSync(mainWindow, {
                            type: 'warning',
                            buttons: ['إلغاء', 'إعادة تعيين'],
                            defaultId: 0,
                            title: 'إعادة تعيين',
                            message: 'سيتم مسح جميع البيانات المحلية وإعادة تشغيل التطبيق. هل أنت متأكد؟'
                        });
                        if (choice === 1) {
                            // Clear localStorage via JS (only reliable way for file://)
                            await mainWindow.webContents.executeJavaScript('localStorage.clear(); sessionStorage.clear();');
                            await clearAllStorage();
                            mainWindow.loadFile(path.join(__dirname, '..', 'frontend', 'index.html'));
                        }
                    }
                },
                { type: 'separator' },
                { label: 'خروج', accelerator: 'Ctrl+Q', click: () => app.quit() }
            ]
        },
        {
            label: 'المزامنة',
            submenu: [
                {
                    label: 'مزامنة يدوية',
                    accelerator: 'Ctrl+S',
                    click: () => mainWindow.webContents.send('sync-action', 'manual')
                },
                {
                    label: 'مزامنة كاملة',
                    accelerator: 'Ctrl+Shift+S',
                    click: () => mainWindow.webContents.send('sync-action', 'full')
                }
            ]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

    mainWindow.webContents.session.on('will-download', (event, item) => {
        item.on('done', (e, state) => {
            if (state === 'completed') {
                console.log('[Download] Saved:', item.getSavePath());
            }
        });
    });

    const frontendPath = path.join(__dirname, '..', 'frontend', 'index.html');
    mainWindow.loadFile(frontendPath);

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// === License file persistence ===
const licensePath = () => path.join(app.getPath('userData'), 'license.json');

ipcMain.on('license-save', (event, data) => {
    try { fs.writeFileSync(licensePath(), data, 'utf8'); }
    catch (e) { console.error('[License] Save failed:', e.message); }
});

ipcMain.on('license-clear', () => {
    try { if (fs.existsSync(licensePath())) fs.unlinkSync(licensePath()); }
    catch (e) { console.error('[License] Clear failed:', e.message); }
});

ipcMain.handle('license-load', async () => {
    try {
        const lp = licensePath();
        if (fs.existsSync(lp)) return fs.readFileSync(lp, 'utf8');
    } catch (e) { console.error('[License] Load failed:', e.message); }
    return null;
});

// === Clear storage and restart ===
ipcMain.handle('clear-storage', async () => {
    await clearAllStorage();
    // Reload the window to get a fresh start
    if (mainWindow) {
        mainWindow.loadFile(path.join(__dirname, '..', 'frontend', 'index.html'));
    }
    return true;
});

// === Expose active server port to renderer ===
ipcMain.handle('get-server-port', async () => {
    return activePort;
});

// Sync version for preload (needed before app.js loads)
ipcMain.on('get-server-port-sync', (event) => {
    event.returnValue = activePort;
});

// Track if we need a storage reset via executeJavaScript
let needsJsReset = false;

// === Pre-ready storage reset (before Chromium locks the files) ===
if (shouldResetStorage()) {
    needsJsReset = true;
    const userDataPath = app.getPath('userData');
    const dirsToDelete = [
        'Local Storage', 'Session Storage', 'IndexedDB', 'Cache', 'GPUCache',
        'Service Worker', 'Code Cache', 'WebStorage', 'SharedStorage',
        'blob_storage', 'databases', 'Shared Dictionary', 'DawnCache', 'Network'
    ];
    for (const dir of dirsToDelete) {
        const fullPath = path.join(userDataPath, dir);
        try {
            if (fs.existsSync(fullPath)) {
                fs.rmSync(fullPath, { recursive: true, force: true });
                console.log('[Reset] Deleted:', dir);
            }
        } catch (e) {
            console.warn('[Reset] Could not delete', dir, ':', e.message);
        }
    }
    // Remove the flag file
    try { fs.unlinkSync(resetFlagPath()); } catch (e) {}
    console.log('[Reset] Pre-ready storage reset complete');
}

// === App lifecycle ===
app.whenReady().then(async () => {

    const port = await startServer();

    // If reset was requested, load a reset page first, then redirect to real app
    if (needsJsReset) {
        needsJsReset = false;
        const resetHtml = path.join(__dirname, '..', 'frontend', 'reset.html');
        // Create a temporary reset page
        fs.writeFileSync(resetHtml, `<!DOCTYPE html><html><body><script>
            const count = localStorage.length;
            for (let i = count - 1; i >= 0; i--) localStorage.removeItem(localStorage.key(i));
            sessionStorage.clear();
            document.title = 'Cleared ' + count + ' keys, remaining: ' + localStorage.length;
        </script><p>Resetting...</p></body></html>`);
        createWindow();
        // Load reset page first (same file:// origin)
        mainWindow.loadFile(resetHtml);
        await new Promise(resolve => {
            mainWindow.webContents.once('did-finish-load', async () => {
                const title = await mainWindow.webContents.executeJavaScript('document.title');
                console.log('[Reset]', title);
                // Now load the real app
                const frontendPath = path.join(__dirname, '..', 'frontend', 'index.html');
                mainWindow.loadFile(frontendPath);
                // Clean up
                try { fs.unlinkSync(resetHtml); } catch (_) {}
                resolve();
            });
        });
    } else {
        createWindow();
    }

    // Send the active port to the frontend once loaded
    if (mainWindow && port) {
        mainWindow.webContents.on('did-finish-load', () => {
            mainWindow.webContents.executeJavaScript(
                `window.__POS_SERVER_PORT = ${port}; console.log('[Electron] Server port: ${port}');`
            );
        });
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (flaskProcess) {
        flaskProcess.kill();
        flaskProcess = null;
    }
    if (expressServer) {
        expressServer.close();
        expressServer = null;
    }
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    if (flaskProcess) {
        flaskProcess.kill();
        flaskProcess = null;
    }
    if (expressServer) {
        expressServer.close();
        expressServer = null;
    }
});
