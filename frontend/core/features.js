/**
 * Feature Flags System - Frontend
 * Loads enabled features from API and controls UI visibility per tenant.
 *
 * Usage:
 *   await PosFeatures.load();
 *   if (PosFeatures.isEnabled('suppliers')) { ... }
 */

window.PosFeatures = (function() {
    let _features = {};
    let _loaded = false;

    /**
     * Load feature flags from server for current tenant
     */
    async function load() {
        try {
            const resp = await fetch(API_URL + '/api/features');
            if (resp.ok) {
                const data = await resp.json();
                if (data.success && data.features) {
                    _features = data.features;
                    _loaded = true;
                    _applyToUI();
                    return true;
                }
            }
        } catch (e) {
            console.warn('[Features] Failed to load feature flags:', e);
        }
        // Fallback: all features enabled
        _loaded = true;
        return false;
    }

    /**
     * Check if a feature is enabled
     */
    function isEnabled(featureKey) {
        if (!_loaded) return true; // Not loaded yet, allow everything
        const f = _features[featureKey];
        if (!f) return true; // Unknown features are always enabled (core)
        return f.enabled;
    }

    /**
     * Get all features with their state
     */
    function getAll() {
        return { ..._features };
    }

    /**
     * Apply feature flags to sidebar menu items.
     * Elements with data-feature="feature_key" will be hidden if disabled.
     */
    function _applyToUI() {
        const elements = document.querySelectorAll('[data-feature]');
        elements.forEach(el => {
            const key = el.getAttribute('data-feature');
            if (!isEnabled(key)) {
                el.style.display = 'none';
                el.classList.add('feature-disabled');
            } else {
                el.style.display = '';
                el.classList.remove('feature-disabled');
            }
        });

        // Also hide tab content for disabled features
        const tabs = document.querySelectorAll('[data-feature-tab]');
        tabs.forEach(tab => {
            const key = tab.getAttribute('data-feature-tab');
            if (!isEnabled(key)) {
                tab.style.display = 'none';
            }
        });
    }

    /**
     * Reload feature flags (e.g., after Super Admin changes)
     */
    async function reload() {
        _loaded = false;
        return await load();
    }

    return {
        load,
        reload,
        isEnabled,
        getAll
    };
})();
