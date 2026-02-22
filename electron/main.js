const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow;
let serverProcess = null;
const SERVER_PORT = 5050;

// تشغيل سيرفر Flask المحلي
function startLocalServer() {
    const serverScript = path.join(__dirname, '..', 'server.py');
    const dbDir = path.join(app.getPath('userData'), 'database');

    // إنشاء مجلد قاعدة البيانات
    const fs = require('fs');
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    // نسخ قاعدة البيانات الأولية إذا لم تكن موجودة
    const dbPath = path.join(dbDir, 'pos.db');
    const srcDb = path.join(__dirname, '..', 'database', 'pos.db');
    if (!fs.existsSync(dbPath) && fs.existsSync(srcDb)) {
        fs.copyFileSync(srcDb, dbPath);
    }

    const env = {
        ...process.env,
        DB_PATH: dbPath,
        PORT: SERVER_PORT.toString()
    };

    serverProcess = spawn('python', [serverScript], {
        env: env,
        cwd: path.join(__dirname, '..'),
        stdio: ['pipe', 'pipe', 'pipe']
    });

    serverProcess.stdout.on('data', (data) => {
        console.log(`[Server] ${data}`);
    });

    serverProcess.stderr.on('data', (data) => {
        console.error(`[Server] ${data}`);
    });

    serverProcess.on('close', (code) => {
        console.log(`[Server] Process exited with code ${code}`);
    });
}

// إنشاء النافذة الرئيسية
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        title: 'POS Offline - نظام نقاط البيع',
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        autoHideMenuBar: true
    });

    // القائمة العربية
    const menuTemplate = [
        {
            label: 'النظام',
            submenu: [
                { label: 'تحديث', accelerator: 'F5', click: () => mainWindow.reload() },
                { label: 'أدوات المطور', accelerator: 'F12', click: () => mainWindow.webContents.toggleDevTools() },
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
                    click: () => mainWindow.webContents.executeJavaScript('manualSync()')
                },
                {
                    label: 'مزامنة كاملة',
                    accelerator: 'Ctrl+Shift+S',
                    click: () => mainWindow.webContents.executeJavaScript('fullSync()')
                }
            ]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate));

    // تحميل الواجهة - مباشرة من الملفات أو من السيرفر المحلي
    const frontendPath = path.join(__dirname, '..', 'frontend', 'index.html');
    mainWindow.loadFile(frontendPath);

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// أحداث التطبيق
app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    // إيقاف السيرفر
    if (serverProcess) {
        serverProcess.kill();
        serverProcess = null;
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    if (serverProcess) {
        serverProcess.kill();
        serverProcess = null;
    }
});
