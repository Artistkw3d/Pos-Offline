const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let mainWindow;
let flaskProcess = null;
let expressServer = null;
const FLASK_PORT = 5000;
const EXPRESS_PORT = 5050;
let activePort = null;

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

    try {
        const { startServer } = require('./server');
        expressServer = startServer({
            port: EXPRESS_PORT,
            dbDir: dbDir,
            frontendDir: frontendDir,
            backupsDir: backupsDir
        });
        activePort = EXPRESS_PORT;
        console.log(`[Express] Fallback server started on port ${EXPRESS_PORT}`);
        return true;
    } catch (err) {
        console.error('[Express] Failed to start:', err.message);
        return false;
    }
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
                ...(app.isPackaged ? [] : [{ label: 'أدوات المطور', accelerator: 'F12', click: () => mainWindow.webContents.toggleDevTools() }]),
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

// === Expose active server port to renderer ===
ipcMain.handle('get-server-port', async () => {
    return activePort;
});

// === App lifecycle ===
app.whenReady().then(async () => {
    const port = await startServer();
    createWindow();

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
