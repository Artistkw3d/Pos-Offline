const { contextBridge, ipcRenderer } = require('electron');

// توفير واجهة آمنة للتطبيق
contextBridge.exposeInMainWorld('electronAPI', {
    // معلومات النظام
    platform: process.platform,
    isElectron: true,

    // إرسال رسائل للعملية الرئيسية
    send: (channel, data) => {
        const validChannels = ['sync-request', 'app-quit', 'open-external'];
        if (validChannels.includes(channel)) {
            ipcRenderer.send(channel, data);
        }
    },

    // استقبال رسائل من العملية الرئيسية
    receive: (channel, func) => {
        const validChannels = ['sync-result', 'sync-progress', 'server-status', 'sync-action'];
        if (validChannels.includes(channel)) {
            ipcRenderer.on(channel, (event, ...args) => func(...args));
        }
    }
});

// Handle sync-action from main process menu
ipcRenderer.on('sync-action', (event, action) => {
    if (action === 'manual' && typeof window.manualSync === 'function') {
        window.manualSync();
    } else if (action === 'full' && typeof window.fullSync === 'function') {
        window.fullSync();
    }
});
