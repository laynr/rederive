/**
 * Run a repo's transform module in a sandboxed iframe: sandbox="allow-scripts"
 * without allow-same-origin → opaque origin, and sandbox.html carries its own
 * CSP (default-src 'none') denying network access. Inside the iframe the
 * transform runs in a disposable module Worker that is hard-terminated on
 * timeout (no DOM/navigation APIs, terminable mid-loop). The parent — never
 * the sandbox — hashes the outputs. Defense in depth, not a formally proven
 * boundary; see README limitations.
 *
 * sandbox.html is a separate document (not srcdoc) because srcdoc inherits
 * the parent page's CSP, which forbids inline scripts.
 */

/**
 * Execute the transform. moduleSources: Map<path, text>; inputs: {name: Uint8Array}.
 * Resolves to Map<outputPath, Uint8Array>.
 */
export function runTransform({ moduleSources, entryModule, entryName, inputs, outputPaths, timeoutMs = 30_000 }) {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.style.display = 'none';
    iframe.src = './sandbox.html';
    const nonce = crypto.getRandomValues(new Uint32Array(4)).join('-');

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      iframe.remove();
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`transform timed out after ${timeoutMs} ms`));
    }, timeoutMs + 5_000);

    const onMessage = (event) => {
      if (event.source !== iframe.contentWindow) return;
      const msg = event.data;
      if (msg?.type === 'sandbox-ready') {
        const inputBuffers = {};
        const transfers = [];
        for (const [name, bytes] of Object.entries(inputs)) {
          const buf = bytes.slice().buffer;
          inputBuffers[name] = buf;
          transfers.push(buf);
        }
        iframe.contentWindow.postMessage({
          type: 'run',
          nonce,
          moduleSources: Object.fromEntries(moduleSources),
          entryModule,
          entryName,
          inputs: inputBuffers,
          outputPaths,
          timeoutMs,
        }, '*', transfers);
        return;
      }
      if (msg?.nonce !== nonce) return;
      if (msg.type === 'result') {
        cleanup();
        resolve(new Map(Object.entries(msg.outputs).map(([p, buf]) => [p, new Uint8Array(buf)])));
      } else if (msg.type === 'error') {
        cleanup();
        reject(new Error(msg.message));
      }
    };

    window.addEventListener('message', onMessage);
    document.body.append(iframe);
  });
}
