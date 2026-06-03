/**
 * ZERO — preload.js
 * --------------------------------------------------
 * Runs in a privileged context BEFORE the renderer page loads.
 * Exposes a safe, narrow API to the renderer via contextBridge.
 *
 * WHY THIS EXISTS:
 *   The old code used  nodeIntegration: true  which lets ANY script
 *   in the renderer access Node.js directly — a serious security hole.
 *   contextBridge fixes this: only the channels listed here can ever
 *   be called from the renderer, nothing else.
 */

const { contextBridge, ipcRenderer } = require('electron');

// ── Channels the renderer is ALLOWED to send to main ─────────────────────────
const ALLOWED_SEND = new Set([
  'open-link', 'open-corpus', 'minimize', 'hide-tray', 'quit', 'reload-corpus'
]);

// ── Channels the renderer is ALLOWED to invoke (request/response) ─────────────
const ALLOWED_INVOKE = new Set([
  'web-scan', 'ai-rewrite', 'get-heatmap', 'get-dna', 'get-timeline',
  'get-citations', 'get-paraphrase', 'scan-file', 'batch-scan',
  'get-history', 'get-stats', 'clear-history', 'export-report',
  'open-file-dialog', 'open-folder-dialog',
  'get-api-keys', 'save-api-keys', 'clear-api-keys'
]);

// ── Channels the renderer is ALLOWED to receive from main ─────────────────────
const ALLOWED_RECEIVE = new Set([
  'app-ready', 'clipboard-update', 'corpus-updated',
  'history-cleared', 'keys-updated'
]);

// ── Expose as window.__ZERO_BRIDGE__ ─────────────────────────────────────────
contextBridge.exposeInMainWorld('__ZERO_BRIDGE__', {
  ipcRenderer: {
    /**
     * Fire-and-forget send to main process.
     * Only whitelisted channels are allowed.
     */
    send(channel, ...args) {
      if (!ALLOWED_SEND.has(channel)) {
        console.warn(`[ZERO preload] Blocked send to unlisted channel: "${channel}"`);
        return;
      }
      ipcRenderer.send(channel, ...args);
    },

    /**
     * Request/response invoke.
     * Returns a Promise that resolves with main's reply.
     */
    invoke(channel, ...args) {
      if (!ALLOWED_INVOKE.has(channel)) {
        console.warn(`[ZERO preload] Blocked invoke to unlisted channel: "${channel}"`);
        return Promise.reject(new Error(`Channel "${channel}" is not allowed`));
      }
      return ipcRenderer.invoke(channel, ...args);
    },

    /**
     * Subscribe to events pushed from main.
     * The listener receives (...args) — the event object is stripped
     * so renderer code never touches internal Electron objects.
     */
    on(channel, listener) {
      if (!ALLOWED_RECEIVE.has(channel)) {
        console.warn(`[ZERO preload] Blocked listener for unlisted channel: "${channel}"`);
        return;
      }
      // Wrap to strip the ipcRenderer Event object from the callback signature
      const wrapped = (_event, ...args) => listener(...args);
      ipcRenderer.on(channel, wrapped);
      // Return a cleanup function so callers can unsubscribe if needed
      return () => ipcRenderer.removeListener(channel, wrapped);
    }
  }
});
