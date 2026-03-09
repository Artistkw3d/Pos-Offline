/**
 * Module Loader & Registry for POS Offline
 *
 * Modules register themselves and are loaded based on feature flags.
 * Each module provides: key, type (plugin/core), menuItem, init(), render()
 *
 * Usage:
 *   PosModules.register({
 *       key: 'suppliers',
 *       type: 'plugin',
 *       menuItem: { icon: 'truck', label: 'الموردين', order: 12 },
 *       init() { ... },
 *       render() { ... }
 *   });
 *
 *   PosModules.initAll();  // Initialize all enabled modules
 */

window.PosModules = (function() {
    const _modules = {};

    /**
     * Register a module
     */
    function register(moduleConfig) {
        if (!moduleConfig.key) {
            console.error('[Modules] Module must have a key');
            return;
        }
        _modules[moduleConfig.key] = {
            key: moduleConfig.key,
            type: moduleConfig.type || 'core', // 'plugin' or 'core'
            menuItem: moduleConfig.menuItem || null,
            init: moduleConfig.init || function() {},
            render: moduleConfig.render || function() {},
            onTabShow: moduleConfig.onTabShow || null,
            routes: moduleConfig.routes || [],
            initialized: false
        };
    }

    /**
     * Initialize all enabled modules
     */
    function initAll() {
        for (const key in _modules) {
            const mod = _modules[key];
            // Plugin modules check feature flags
            if (mod.type === 'plugin' && !PosFeatures.isEnabled(key)) {
                continue;
            }
            try {
                mod.init();
                mod.initialized = true;
            } catch (e) {
                console.error(`[Modules] Error initializing ${key}:`, e);
            }
        }
    }

    /**
     * Get a registered module by key
     */
    function get(key) {
        return _modules[key] || null;
    }

    /**
     * Get all registered modules
     */
    function getAll() {
        return { ..._modules };
    }

    /**
     * Check if a module is initialized and enabled
     */
    function isActive(key) {
        const mod = _modules[key];
        if (!mod) return false;
        if (mod.type === 'plugin' && !PosFeatures.isEnabled(key)) return false;
        return mod.initialized;
    }

    /**
     * Call a module's onTabShow handler (when user navigates to its tab)
     */
    function showTab(key) {
        const mod = _modules[key];
        if (!mod || !mod.onTabShow) return false;
        if (mod.type === 'plugin' && !PosFeatures.isEnabled(key)) return false;
        try {
            mod.onTabShow();
            return true;
        } catch (e) {
            console.error(`[Modules] Error showing tab ${key}:`, e);
            return false;
        }
    }

    return {
        register,
        initAll,
        get,
        getAll,
        isActive,
        showTab
    };
})();
