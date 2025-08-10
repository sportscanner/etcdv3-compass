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
    }) => Promise<void>
  ) {}

  public show() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      AddConnectionPanel.viewType,
      'Add Etcd Connection',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'save-connection') {
        const { name, endpoint, username, password, envTag, colorTheme } = message.payload ?? {};
        try {
          await this.onSave({ name, endpoint, username, password, envTag, colorTheme });
          vscode.window.showInformationMessage(`Connection "${name}" added`);
          this.panel?.dispose();
        } catch (error: any) {
          vscode.window.showErrorMessage(error?.message ?? 'Failed to add connection');
        }
      }
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const cspSource = webview.cspSource;
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} https:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Add Etcd Connection</title>
    <style>
      :root {
        --muted: var(--vscode-descriptionForeground);
        --bg: var(--vscode-editor-background);
        --fg: var(--vscode-foreground);
        --card: color-mix(in srgb, var(--bg) 88%, #000 12%);
        --ring: var(--vscode-focusBorder);
        --accent: var(--vscode-button-background);
        --border: var(--vscode-input-border);
      }
      html, body { height: 100%; }
      body { font-family: var(--vscode-font-family); color: var(--fg); background: var(--bg); }
      .container { max-width: 980px; margin: 0 auto; padding: 18px; }
      .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 16px; box-shadow: 0 3px 10px rgba(0,0,0,0.18); }
      h2 { margin: 0 0 12px; letter-spacing: 0.3px; }
      .stack { display: grid; grid-auto-rows: min-content; row-gap: 12px; }
      .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      label { font-size: 12px; color: var(--muted); margin-bottom: 6px; display: block; }
      input, select { width: 100%; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--border); background: var(--vscode-input-background); color: var(--vscode-input-foreground); box-sizing: border-box; }
      input:focus, select:focus { outline: 2px solid var(--ring); outline-offset: 1px; }
      .hint { color: var(--muted); font-size: 12px; margin-top: 6px; }
      .actions { margin-top: 8px; display: flex; gap: 12px; }
      button.primary { padding: 10px 16px; border-radius: 10px; background: var(--accent); color: var(--vscode-button-foreground); border: none; cursor: pointer; }
      button.primary:hover { background: var(--vscode-button-hoverBackground); }
      details { margin-top: 6px; border-top: 1px dashed var(--border); padding-top: 10px; }
      details > summary { cursor: pointer; padding: 8px 0; color: var(--muted); }

      /* Responsive adjustments */
      @media (max-width: 768px) {
        .container { padding: 12px; }
        .card { padding: 14px; }
        .row2 { grid-template-columns: 1fr; gap: 10px; }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="card">
        <h2>Add Etcd Connection</h2>
        <div class="stack">
          <div>
            <label for="name">Name</label>
            <input id="name" type="text" placeholder="My Cluster" required />
          </div>
          <div>
            <label for="endpoint">Endpoint</label>
            <input id="endpoint" type="text" placeholder="localhost:2379 or 127.0.0.1:2379" required />
            <div class="hint">Use host:port (scheme not required). 'localhost' maps to 127.0.0.1; port defaults to 2379.</div>
          </div>
          <div class="row2">
            <div>
              <label for="username">Username (optional)</label>
              <input id="username" type="text" placeholder="Optional" />
            </div>
            <div>
              <label for="password">Password (optional)</label>
              <input id="password" type="password" placeholder="Optional" />
            </div>
          </div>
          <details>
            <summary>Advanced</summary>
            <div class="row2" style="margin-top:10px;">
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
                <select id="colorTheme">
                  <option value="">Auto</option>
                  <option value="charts.green">Green</option>
                  <option value="charts.blue">Blue</option>
                  <option value="charts.orange">Orange</option>
                  <option value="charts.red">Red</option>
                  <option value="charts.purple">Purple</option>
                  <option value="charts.yellow">Yellow</option>
                </select>
                <div class="hint">Used to tint the connection icon and label.</div>
              </div>
            </div>
          </details>
          <div class="actions">
            <button class="primary" id="save">Save Connection</button>
          </div>
        </div>
      </div>
    </div>

    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      document.getElementById('save').addEventListener('click', () => {
        const name = document.getElementById('name').value.trim();
        const endpoint = document.getElementById('endpoint').value.trim();
        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;
        const envTag = document.getElementById('envTag').value || undefined;
        const colorTheme = document.getElementById('colorTheme').value || undefined;
        if (!name || !endpoint) return;
        vscode.postMessage({ type: 'save-connection', payload: { name, endpoint, username: username || undefined, password: password || undefined, envTag, colorTheme } });
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


