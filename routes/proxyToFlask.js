/**
 * Proxy utilities for forwarding requests to the Flask server.
 * Uses Node.js built-in http/https modules (no new dependencies).
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Forward an Express request to the Flask server and pipe the response back.
 * Used for pure proxy routes where Electron doesn't need to inspect the data.
 *
 * @param {string} baseUrl - Flask server base URL (e.g. "http://192.168.1.5:5000")
 * @param {string} path - API path (e.g. "/api/super-admin/login")
 * @param {object} req - Express request object
 * @param {object} res - Express response object
 */
function proxyToFlask(baseUrl, path, req, res) {
  return new Promise((resolve) => {
    try {
      const targetUrl = new URL(path, baseUrl);
      // Append query string from original request
      if (req.query && Object.keys(req.query).length > 0) {
        for (const [key, value] of Object.entries(req.query)) {
          targetUrl.searchParams.set(key, value);
        }
      }

      const isHttps = targetUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      };
      // Forward X-Tenant-ID if present
      if (req.headers['x-tenant-id']) {
        headers['X-Tenant-ID'] = req.headers['x-tenant-id'];
      }
      // Forward Authorization header if present
      if (req.headers['authorization']) {
        headers['Authorization'] = req.headers['authorization'];
      }

      let bodyData = null;
      if (req.body && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        bodyData = JSON.stringify(req.body);
        headers['Content-Length'] = Buffer.byteLength(bodyData);
      }

      const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers,
        timeout: 15000
      };

      const proxyReq = transport.request(options, (proxyRes) => {
        res.status(proxyRes.statusCode);
        // Forward content-type header
        if (proxyRes.headers['content-type']) {
          res.set('Content-Type', proxyRes.headers['content-type']);
        }
        proxyRes.pipe(res);
        proxyRes.on('end', resolve);
      });

      proxyReq.on('timeout', () => {
        proxyReq.destroy();
        if (!res.headersSent) {
          res.status(504).json({ success: false, error: 'انتهت مهلة الاتصال بالخادم الرئيسي' });
        }
        resolve();
      });

      proxyReq.on('error', (err) => {
        console.error('[proxyToFlask] Connection error:', err.message);
        if (!res.headersSent) {
          res.status(503).json({ success: false, error: 'تعذر الاتصال بالخادم الرئيسي' });
        }
        resolve();
      });

      if (bodyData) {
        proxyReq.write(bodyData);
      }
      proxyReq.end();
    } catch (err) {
      console.error('[proxyToFlask] Error:', err.message);
      if (!res.headersSent) {
        res.status(503).json({ success: false, error: 'تعذر الاتصال بالخادم الرئيسي' });
      }
      resolve();
    }
  });
}

/**
 * Make a request to the Flask server and return parsed JSON.
 * Used for hybrid routes that need the data before performing local operations.
 *
 * @param {string} baseUrl - Flask server base URL
 * @param {string} path - API path with query string
 * @param {string} [method='GET'] - HTTP method
 * @param {object|null} [body=null] - Request body (will be JSON-serialized)
 * @param {object} [extraHeaders={}] - Additional headers
 * @returns {Promise<{ok: boolean, status: number, data: object|null, error: string|null}>}
 */
function fetchFromFlask(baseUrl, path, method, body, extraHeaders) {
  method = method || 'GET';
  extraHeaders = extraHeaders || {};

  return new Promise((resolve) => {
    try {
      const targetUrl = new URL(path, baseUrl);
      const isHttps = targetUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...extraHeaders
      };

      let bodyData = null;
      if (body && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        bodyData = JSON.stringify(body);
        headers['Content-Length'] = Buffer.byteLength(bodyData);
      }

      const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (isHttps ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method,
        headers,
        timeout: 15000
      };

      const req = transport.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: parsed, error: null });
          } catch (e) {
            resolve({ ok: false, status: res.statusCode, data: null, error: 'استجابة غير صالحة من الخادم' });
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, status: 504, data: null, error: 'انتهت مهلة الاتصال بالخادم الرئيسي' });
      });

      req.on('error', (err) => {
        console.error('[fetchFromFlask] Connection error:', err.message);
        resolve({ ok: false, status: 503, data: null, error: 'تعذر الاتصال بالخادم الرئيسي' });
      });

      if (bodyData) {
        req.write(bodyData);
      }
      req.end();
    } catch (err) {
      console.error('[fetchFromFlask] Error:', err.message);
      resolve({ ok: false, status: 503, data: null, error: 'تعذر الاتصال بالخادم الرئيسي' });
    }
  });
}

module.exports = { proxyToFlask, fetchFromFlask };
