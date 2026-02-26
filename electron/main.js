const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let server = null;
const SERVER_PORT = 5050;

// تشغيل سيرفر Node.js المحلي
function startLocalServer() {
    const dbDir = path.join(app.getPath('userData'), 'database');
    const frontendDir = path.join(__dirname, '..', 'frontend');
    const backupsDir = path.join(dbDir, 'backups');

    // إنشاء مجلد قاعدة البيانات
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    // نسخ قاعدة البيانات الأولية إذا لم تكن موجودة
    const dbPath = path.join(dbDir, 'pos.db');
    const srcDb = path.join(__dirname, '..', 'database', 'pos.db');
    if (!fs.existsSync(dbPath) && fs.existsSync(srcDb)) {
        fs.copyFileSync(srcDb, dbPath);
    }

    // تشغيل السيرفر المدمج (Node.js بدلاً من Python)
    try {
        const { startServer } = require('./server');
        server = startServer({
            port: SERVER_PORT,
            dbDir: dbDir,
            frontendDir: frontendDir,
            backupsDir: backupsDir
        });
        console.log(`[Server] Node.js server started on port ${SERVER_PORT}`);
    } catch (err) {
        console.error('[Server] Failed to start:', err);
        dialog.showErrorBox('خطأ في تشغيل السيرفر', err.message);
    }
}

// إنشاء النافذة الرئيسية
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

    // القائمة العربية
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

    // تحميل الواجهة - مباشرة من الملفات أو من السيرفر المحلي
    const frontendPath = path.join(__dirname, '..', 'frontend', 'index.html');
    mainWindow.loadFile(frontendPath);

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// أحداث التطبيق
app.whenReady().then(() => {
    startLocalServer();
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    // إيقاف السيرفر
    if (server) {
        server.close();
        server = null;
    }
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    if (server) {
        server.close();
        server = null;
    }
});
