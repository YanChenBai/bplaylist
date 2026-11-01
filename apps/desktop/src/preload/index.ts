import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bplaylistRuntime', { platform: process.platform });

// Only the current frame may transfer a single renderer-owned RPC channel.
window.addEventListener('message', event => {
  if (event.source !== window || event.data !== 'start-orpc-client' || event.ports.length !== 1) {
    return;
  }

  const [port] = event.ports;

  if (port) {
    ipcRenderer.postMessage('start-orpc-server', null, [port]);
  }
});
