import * as vscode from 'vscode';

export class AddConnectionPanel {
  public static readonly viewType = 'etcdExplorer.addConnectionPanel';
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly onSave: (data: {
      name: string;
      endpoint: string;
      username?: string;
      password?: string;
      envTag?: string;
      colorTheme?: string;
      connectionTimeoutMs?: number;
      idleConnectionTimeoutMs?: number;
      operationTimeoutMs?: number;
    }) => Promise<void>,
    private readonly prefill?: any
  ) {}

  public show() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      AddConnectionPanel.viewType,
      this.prefill?.id ? 'Edit Etcd Connection' : 'Add Etcd Connection',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    this.panel.webview.html = this.getHtml(this.panel.webview, this.prefill);

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'save-connection') {
        const { name, endpoint, username, password, envTag, colorTheme, connectionTimeoutMs, idleConnectionTimeoutMs, operationTimeoutMs } = message.payload ?? {};
        try {
          await this.onSave({ name, endpoint, username, password, envTag, colorTheme, connectionTimeoutMs, idleConnectionTimeoutMs, operationTimeoutMs });
          vscode.window.showInformationMessage(`Connection "${name}" added`);
          this.panel?.dispose();
        } catch (error: any) {
          vscode.window.showErrorMessage(error?.message ?? 'Failed to add connection');
        }
      } else if (message?.type === 'test-connection') {
        const { endpoint, username, password, connectionTimeoutMs, idleConnectionTimeoutMs, operationTimeoutMs } = message.payload ?? {};
        try {
          // Test connection directly without using the tree provider
          const { Etcd3 } = await import('etcd3');

          const options: any = {
            hosts: [endpoint],
            dialTimeout: connectionTimeoutMs || 5000,
            idleConnectionTimeout: idleConnectionTimeoutMs || 0,
            timeout: operationTimeoutMs || 5000,
            backoffStrategy: {
              initial: 1000,
              max: 30000,
              multiplier: 1.5,
              jitter: 0.2
            }
          };

          if (username && password) {
            (options as any).auth = { username, password };
          }

          const client = new Etcd3(options);

          try {
            // Test with a key that's unlikely to exist to avoid interfering with data
            await client.get('__test_connection_key__').exec();
            this.panel?.webview.postMessage({ type: 'test-result', ok: true, message: `Connected to ${endpoint}` });
          } finally {
            client.close();
          }
        } catch (error: any) {
          console.error('Connection test error:', error);
          this.panel?.webview.postMessage({ type: 'test-result', ok: false, message: error?.message || 'Connection failed' });
        }
      }
    });
  }

  private getHtml(webview: vscode.Webview, prefill?: any): string {
    const cspSource = webview.cspSource;
    const nonce = getNonce();
    const isEdit = !!(prefill && prefill.id);
    const preName = prefill?.name || '';
    const preEndpoint = prefill?.endpoints ? prefill.endpoints[0] : '';
    const preUsername = prefill?.username || '';
    const prePassword = prefill?.password || '';
    const preConnTimeout = prefill?.connectionTimeoutMs || '';
    const preIdleTimeout = prefill?.idleConnectionTimeoutMs || '';
    const preOpTimeout = prefill?.operationTimeoutMs || '';
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Add Etcd Connection</title>
    <style>
      body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        margin: 0;
        padding: 0;
      }
      .container { max-width: 600px; margin: 0 auto; padding: 24px 20px 32px; }
      h2 { margin: 0 0 2px; font-size: 1.45em; font-weight: 600; display: flex; align-items: center; gap: 6px; }
      .subtitle { margin: 0 0 24px; color: var(--vscode-descriptionForeground); font-size: 0.92em; }
      .stack { display: flex; flex-direction: column; gap: 16px; }
      .row2 { display: flex; gap: 12px; align-items: stretch; }
      .row2 > * { flex: 1; min-width: 0; display: flex; flex-direction: column; }
      /* Push the control to the bottom so inputs line up even when one cell
         has a longer (or no) description above it. */
      .row2 > * > input, .row2 > * > select { margin-top: auto; }
      label { display: block; margin-bottom: 2px; font-size: 0.92em; color: var(--vscode-foreground); }
      label.required::after { content: " *"; color: var(--vscode-errorForeground); }
      input, select {
        width: 100%;
        box-sizing: border-box;
        padding: 5px 8px;
        font-family: inherit;
        font-size: inherit;
        color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 2px;
      }
      input:focus, select:focus { outline: none; border-color: var(--vscode-focusBorder); }
      input::placeholder { color: var(--vscode-input-placeholderForeground); }
      select { cursor: pointer; }
      .hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin: 0 0 6px; line-height: 1.4; }
      .actions { margin-top: 28px; display: flex; gap: 8px; align-items: center; }
      .status { font-size: 0.9em; margin-left: 4px; display: inline-flex; align-items: center; gap: 5px; }
      .status.testing { color: var(--vscode-descriptionForeground); }
      .status.ok { color: var(--vscode-charts-green, #89d185); }
      .status.err { color: var(--vscode-errorForeground); }
      button {
        font-family: inherit;
        font-size: inherit;
        padding: 6px 14px;
        border: none;
        border-radius: 2px;
        cursor: pointer;
      }
      button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
      button:disabled { opacity: 0.5; cursor: default; }
      button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
      button.primary:hover { background: var(--vscode-button-hoverBackground); }
      button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
      button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
      details { border-top: 1px solid var(--vscode-widget-border, var(--vscode-input-border)); padding-top: 4px; }
      details > summary { cursor: pointer; padding: 8px 0; color: var(--vscode-foreground); list-style: none; user-select: none; font-size: 0.92em; }
      details > summary::-webkit-details-marker { display: none; }
      details > summary::before { content: "\\203A"; display: inline-block; margin-right: 6px; transition: transform 0.15s ease; color: var(--vscode-descriptionForeground); }
      details[open] > summary::before { transform: rotate(90deg); }
      details .stack { margin-top: 8px; }
      details details { border-top: none; padding-top: 0; }

      @media (max-width: 520px) {
        .row2 { flex-direction: column; gap: 16px; }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h2>${isEdit ? 'Edit connection' : 'New connection'}</h2>
      <p class="subtitle">Connect to an etcd v3 cluster.</p>
      <div class="stack">
        <div>
          <label class="required" for="name">Name</label>
          <input id="name" type="text" placeholder="My Cluster" value="${preName}" required />
        </div>
        <div>
          <label class="required" for="endpoint">Endpoint</label>
          <div class="hint">Use host:port (scheme not required). 'localhost' maps to 127.0.0.1.</div>
          <input id="endpoint" type="text" placeholder="localhost:2379 or 127.0.0.1:2379" value="${preEndpoint}" required />
        </div>
        <div class="row2">
          <div>
            <label for="username">Username</label>
            <input id="username" type="text" placeholder="Optional" value="${preUsername}" />
          </div>
          <div>
            <label for="password">Password</label>
            <input id="password" type="password" placeholder="Optional" value="${prePassword}" />
          </div>
        </div>
        <details>
          <summary>Advanced</summary>
          <div class="stack">
            <div class="row2">
              <div>
                <label for="envTag">Environment Tag</label>
                <select id="envTag">
                  <option value="">None</option>
                  <option value="dev">Development</option>
                  <option value="staging">Staging</option>
                  <option value="qa">QA</option>
                  <option value="prod">Production</option>
                </select>
              </div>
              <div>
                <label for="colorTheme">Color</label>
                <div class="hint">Tints the connection icon and label.</div>
                <select id="colorTheme">
                  <option value="">Auto</option>
                  <option value="charts.green">Green</option>
                  <option value="charts.blue">Blue</option>
                  <option value="charts.orange">Orange</option>
                  <option value="charts.red">Red</option>
                  <option value="charts.purple">Purple</option>
                  <option value="charts.yellow">Yellow</option>
                </select>
              </div>
            </div>
            <details>
              <summary>Connection Settings</summary>
              <div class="stack">
                <div class="row2">
                  <div>
                    <label for="connectionTimeoutMs">Connection Timeout (ms)</label>
                    <div class="hint">Time to wait when establishing a connection before failing.</div>
                    <input id="connectionTimeoutMs" type="text" pattern="\\d*" placeholder="5000" value="${preConnTimeout}" />
                  </div>
                  <div>
                    <label for="idleConnectionTimeoutMs">Idle Timeout (ms)</label>
                    <div class="hint">Close the connection after being idle this long (0 to disable).</div>
                    <input id="idleConnectionTimeoutMs" type="text" pattern="\\d*" placeholder="0" value="${preIdleTimeout}" />
                  </div>
                </div>
                <div class="row2">
                  <div>
                    <label for="operationTimeoutMs">Operation Timeout (ms)</label>
                    <div class="hint">Timeout for individual get / put / delete operations.</div>
                    <input id="operationTimeoutMs" type="text" pattern="\\d*" placeholder="5000" value="${preOpTimeout}" />
                  </div>
                  <div></div>
                </div>
              </div>
            </details>
          </div>
        </details>
        <div class="actions">
          <button class="primary" id="save">${isEdit ? 'Save Changes' : 'Add Connection'}</button>
          <button class="secondary" id="test">Test Connection</button>
          <span id="status" class="status" role="status" aria-live="polite"></span>
        </div>
      </div>
    </div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      
      function getConnectionData() {
        const name = document.getElementById('name').value.trim();
        const endpoint = document.getElementById('endpoint').value.trim();
        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        const envTag = document.getElementById('envTag').value || undefined;
        const colorTheme = document.getElementById('colorTheme').value || undefined;
        const connectionTimeoutMs = parseInt(document.getElementById('connectionTimeoutMs').value) || undefined;
        const idleConnectionTimeoutMs = parseInt(document.getElementById('idleConnectionTimeoutMs').value) || undefined;
        const operationTimeoutMs = parseInt(document.getElementById('operationTimeoutMs').value) || undefined;
        return { name, endpoint, username: username || undefined, password: password || undefined, envTag, colorTheme, connectionTimeoutMs, idleConnectionTimeoutMs, operationTimeoutMs };
      }
      
      document.getElementById('save').addEventListener('click', () => {
        const data = getConnectionData();
        if (!data.name || !data.endpoint) return;
        vscode.postMessage({ type: 'save-connection', payload: data });
      });
      
      const testBtn = document.getElementById('test');
      const statusEl = document.getElementById('status');

      function setStatus(kind, text) {
        statusEl.className = 'status' + (kind ? ' ' + kind : '');
        statusEl.textContent = text;
      }

      testBtn.addEventListener('click', () => {
        const data = getConnectionData();
        if (!data.endpoint) {
          setStatus('err', '✕ Enter an endpoint first');
          return;
        }
        testBtn.disabled = true;
        setStatus('testing', 'Testing…');
        vscode.postMessage({ type: 'test-connection', payload: data });
      });

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (msg && msg.type === 'test-result') {
          testBtn.disabled = false;
          setStatus(msg.ok ? 'ok' : 'err', (msg.ok ? '✓ ' : '✕ ') + msg.message);
        }
      });
    </script>
  </body>
  </html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}


