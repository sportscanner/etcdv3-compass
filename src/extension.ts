import * as vscode from 'vscode';
import * as os from 'os';
import { AddConnectionPanel } from './panels/AddConnectionPanel';
import { EtcdTreeDataProvider, ConnectionItem } from './tree/EtcdTreeDataProvider';
import { EtcdDecorationProvider } from './decorations/EtcdDecorationProvider';
import { EtcdConnection } from './types';

const STATE_KEY = 'etcdConnections';

const EXPORT_TYPE = 'etcd-compass-connections';
const EXPORT_VERSION = 1;

interface ExportFile {
  type: string;
  version: number;
  exportedAt: string;
  connections: Omit<EtcdConnection, 'id'>[];
}

export function activate(context: vscode.ExtensionContext) {
  const treeProvider = new EtcdTreeDataProvider();

  // Load and sanitize existing connections (strip schemes, ensure port)
  const savedConnections = sanitizeConnections(
    context.globalState.get<EtcdConnection[]>(STATE_KEY, [])
  );
  if (savedConnections.updated) {
    // Persist sanitized endpoints back to state
    context.globalState.update(STATE_KEY, savedConnections.connections).then(() => {
      treeProvider.setConnections(savedConnections.connections);
    });
  } else {
    treeProvider.setConnections(savedConnections.connections);
  }

  const colorMap = new Map<string, vscode.ThemeColor>();
  const treeView = vscode.window.createTreeView('etcdExplorer.connections', {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // Decoration provider to keep label tinted even when selected
  const decProvider = new EtcdDecorationProvider((uri) => colorMap.get(uri.toString()));
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decProvider));

  context.subscriptions.push(
    vscode.commands.registerCommand('etcdExplorer.addConnection', async (prefill?: Partial<EtcdConnection>) => {
      const panel = new AddConnectionPanel(async (data) => {
        const connections = loadConnections(context);
        const id = prefill?.id || generateId();
        const endpoint = normalizeEndpoint(data.endpoint);
        const newConn: EtcdConnection = {
          id,
          name: data.name,
          endpoints: [endpoint],
          username: data.username,
          password: data.password,
          envTag: (data as any).envTag,
          colorTheme: (data as any).colorTheme,
          connectionTimeoutMs: (data as any).connectionTimeoutMs,
          idleConnectionTimeoutMs: (data as any).idleConnectionTimeoutMs,
          operationTimeoutMs: (data as any).operationTimeoutMs
        };
        let updatedList: EtcdConnection[];
        if (prefill?.id) {
          updatedList = connections.map(c => c.id === prefill.id ? newConn : c);
        } else {
          updatedList = [...connections, newConn];
        }
        await context.globalState.update(STATE_KEY, updatedList);
        treeProvider.setConnections(updatedList);
        if (newConn.colorTheme) {
          const uri = vscode.Uri.parse(`etcd:${newConn.id}`);
          colorMap.set(uri.toString(), new vscode.ThemeColor(newConn.colorTheme));
          decProvider.refresh(uri);
        }
      }, prefill);
      panel.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('etcdExplorer.editConnection', async (item?: any) => {
      const selected = item?.connection as EtcdConnection | undefined;
      if (!selected) return;
      vscode.commands.executeCommand('etcdExplorer.addConnection', selected);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('etcdExplorer.refresh', () => {
      treeProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('etcdExplorer.refreshConnection', (item?: any) => {
      if (item?.connection?.id && item?.connection?.colorTheme) {
        const uri = vscode.Uri.parse(`etcd:${item.connection.id}`);
        colorMap.set(uri.toString(), new vscode.ThemeColor(item.connection.colorTheme));
        decProvider.refresh(uri);
      }
      if (item) treeProvider.refreshItem(item);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('etcdExplorer.deleteConnection', async (item?: any) => {
      const selected = item?.connection as EtcdConnection | undefined;
      if (!selected) return;
      const answer = await vscode.window.showWarningMessage(
        `Delete connection "${selected.name}"?`,
        { modal: true },
        'Delete'
      );
      if (answer === 'Delete') {
        const connections = loadConnections(context).filter((c) => c.id !== selected.id);
        await context.globalState.update(STATE_KEY, connections);
        treeProvider.setConnections(connections);
        const uri = vscode.Uri.parse(`etcd:${selected.id}`);
        colorMap.delete(uri.toString());
        decProvider.refresh(uri);
      }
    })
  );

  // Add key under a connection
  context.subscriptions.push(
    vscode.commands.registerCommand('etcdExplorer.addKey', async (item?: any) => {
      const connectionId: string | undefined = item?.connection?.id;
      if (!connectionId) return;
      const key = await vscode.window.showInputBox({ prompt: 'Key', placeHolder: '/foo/bar' });
      if (!key) return;
      const value = await vscode.window.showInputBox({ prompt: 'Value', placeHolder: 'value', value: '' });
      if (value === undefined) return;
      try {
        const client = await treeProvider.getClientByConnectionId(connectionId);
        await client.put(key).value(value);
        vscode.window.showInformationMessage('Key saved');
        treeProvider.refreshItem(item);
      } catch (err: any) {
        vscode.window.showErrorMessage(err?.message || 'Failed to save key');
      }
    })
  );

  // Edit existing key value (simple input)
  context.subscriptions.push(
    vscode.commands.registerCommand('etcdExplorer.editKey', async (item?: any) => {
      const keyItem = item as { connectionId?: string; key?: string; value?: string };
      if (!keyItem?.connectionId || !keyItem?.key) return;
      const newValue = await vscode.window.showInputBox({ prompt: `New value for ${keyItem.key}`, value: keyItem.value ?? '' });
      if (newValue === undefined) return;
      try {
        const client = await treeProvider.getClientByConnectionId(keyItem.connectionId);
        await client.put(keyItem.key!).value(newValue);
        vscode.window.showInformationMessage('Key updated');
        treeProvider.refresh();
      } catch (err: any) {
        vscode.window.showErrorMessage(err?.message || 'Failed to update key');
      }
    })
  );

  // Delete key
  context.subscriptions.push(
    vscode.commands.registerCommand('etcdExplorer.deleteKey', async (item?: any) => {
      const keyItem = item as { connectionId?: string; key?: string };
      if (!keyItem?.connectionId || !keyItem?.key) return;
      const confirm = await vscode.window.showWarningMessage(
        `Delete key ${keyItem.key}?`,
        { modal: true },
        'Delete'
      );
      if (confirm !== 'Delete') return;
      
      const progressOptions = {
        location: vscode.ProgressLocation.Notification,
        title: "Deleting key...",
        cancellable: false
      };
      
      try {
        await vscode.window.withProgress(progressOptions, async (progress) => {
          progress.report({ message: `Deleting ${keyItem.key}...` });
          
          const client = await treeProvider.getClientByConnectionId(keyItem.connectionId!);
          
          // Add timeout to delete operation
          const deletePromise = client.delete().key(keyItem.key!);
          const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Delete operation timed out after 15 seconds')), 15000)
          );
          
          await Promise.race([deletePromise, timeoutPromise]);
        });
        
        vscode.window.showInformationMessage('Key deleted');
        // Only refresh the specific connection, not all connections
        const connectionItem = new ConnectionItem(treeProvider.getConnections().find(c => c.id === keyItem.connectionId)!, 'unknown');
        treeProvider.refreshConnection(connectionItem);
      } catch (err: any) {
        vscode.window.showErrorMessage(err?.message || 'Failed to delete key');
      }
    })
  );


  // initialize colorMap from saved connections
  for (const c of savedConnections.connections) {
    if (c.colorTheme) {
      colorMap.set(vscode.Uri.parse(`etcd:${c.id}`).toString(), new vscode.ThemeColor(c.colorTheme));
    }
  }
  decProvider.refresh();

  context.subscriptions.push(
    vscode.commands.registerCommand('etcdExplorer.toggleTreeView', async (connectionItem?: ConnectionItem) => {
      if (!connectionItem) {
        vscode.window.showErrorMessage('Please select a connection first');
        return;
      }
      connectionItem.isTreeView = !connectionItem.isTreeView; // Toggle tree view mode
      // Instant refresh without clearing cache for immediate toggle
      treeProvider.refreshConnectionInstant(connectionItem);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('etcdExplorer.toggleFlatten', (connectionItem?: ConnectionItem) => {
      if (!connectionItem) {
        vscode.window.showErrorMessage('Please select a connection first');
        return;
      }
      connectionItem.isFlattened = !connectionItem.isFlattened; // Toggle flatten mode
      // Instant refresh without clearing cache for immediate toggle
      treeProvider.refreshConnectionInstant(connectionItem);
    })
  );

  // Export all connections (including credentials) to a JSON file for sharing
  context.subscriptions.push(
    vscode.commands.registerCommand('etcdExplorer.exportConnections', async () => {
      const connections = loadConnections(context);
      if (!connections.length) {
        vscode.window.showInformationMessage('No connections to export.');
        return;
      }

      const hasCredentials = connections.some((c) => c.username || c.password);
      if (hasCredentials) {
        const proceed = await vscode.window.showWarningMessage(
          'This export includes usernames and passwords in plain text. Only share it with people you trust.',
          { modal: true },
          'Export'
        );
        if (proceed !== 'Export') return;
      }

      const payload: ExportFile = {
        type: EXPORT_TYPE,
        version: EXPORT_VERSION,
        exportedAt: new Date().toISOString(),
        // Strip internal ids so importing never clobbers existing connections
        connections: connections.map(({ id, ...rest }) => rest),
      };

      // Default to the open workspace folder, falling back to the home directory,
      // so the save dialog never lands on a read-only location like the fs root.
      const baseFolder =
        vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
      const target = await vscode.window.showSaveDialog({
        title: 'Export Etcd Connections',
        saveLabel: 'Export',
        defaultUri: vscode.Uri.joinPath(baseFolder, 'etcd-connections.json'),
        filters: { JSON: ['json'] },
      });
      if (!target) return;

      try {
        const data = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
        await vscode.workspace.fs.writeFile(target, data);
        vscode.window.showInformationMessage(
          `Exported ${connections.length} connection${connections.length === 1 ? '' : 's'}.`
        );
      } catch (err: any) {
        vscode.window.showErrorMessage(err?.message || 'Failed to export connections');
      }
    })
  );

  // Import connections from a JSON file produced by Export
  context.subscriptions.push(
    vscode.commands.registerCommand('etcdExplorer.importConnections', async () => {
      const picked = await vscode.window.showOpenDialog({
        title: 'Import Etcd Connections',
        openLabel: 'Import',
        canSelectMany: false,
        filters: { JSON: ['json'] },
      });
      if (!picked || !picked.length) return;

      let imported: EtcdConnection[];
      try {
        const raw = await vscode.workspace.fs.readFile(picked[0]);
        imported = parseImportedConnections(Buffer.from(raw).toString('utf8'));
      } catch (err: any) {
        vscode.window.showErrorMessage(err?.message || 'Failed to read connections file');
        return;
      }

      if (!imported.length) {
        vscode.window.showWarningMessage('No valid connections found in the selected file.');
        return;
      }

      const existing = loadConnections(context);
      const updatedList = [...existing, ...imported];
      await context.globalState.update(STATE_KEY, updatedList);
      treeProvider.setConnections(updatedList);

      // Register colors for newly imported connections
      for (const c of imported) {
        if (c.colorTheme) {
          colorMap.set(vscode.Uri.parse(`etcd:${c.id}`).toString(), new vscode.ThemeColor(c.colorTheme));
        }
      }
      decProvider.refresh();

      vscode.window.showInformationMessage(
        `Imported ${imported.length} connection${imported.length === 1 ? '' : 's'}.`
      );
    })
  );
}

export function deactivate() {}

function loadConnections(context: vscode.ExtensionContext): EtcdConnection[] {
  return context.globalState.get<EtcdConnection[]>(STATE_KEY, []);
}

function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeEndpoint(input: string): string {
  try {
    const hasScheme = /^(http|https):\/\//i.test(input);
    const url = new URL(hasScheme ? input : `http://${input}`);
    const hostnameRaw = url.hostname || 'localhost';
    const hostname = hostnameRaw.toLowerCase() === 'localhost' ? '127.0.0.1' : hostnameRaw;
    const port = url.port || '2379';
    return `${hostname}:${port}`; // bare host:port for grpc resolver
  } catch {
    let stripped = input.replace(/^https?:\/\//i, '').replace(/\/$/, '');
    if (!/:\d+$/.test(stripped)) {
      stripped = `${stripped}:2379`;
    }
    if (/^localhost:?/i.test(stripped)) {
      stripped = stripped.replace(/^localhost/i, '127.0.0.1');
    }
    return stripped;
  }
}

// Parse and validate a connections JSON file, returning ready-to-store
// EtcdConnection records with fresh ids and normalized endpoints.
function parseImportedConnections(text: string): EtcdConnection[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('File is not valid JSON');
  }

  // Accept either the wrapped export format or a bare array of connections
  const rawList = Array.isArray(parsed)
    ? parsed
    : (parsed as ExportFile | undefined)?.connections;

  if (!Array.isArray(rawList)) {
    throw new Error('File does not contain a connections list');
  }

  const result: EtcdConnection[] = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object') continue;
    const c = entry as Record<string, unknown>;

    // Endpoints may arrive as an array, or as a single "endpoint" string
    let endpoints: string[] = [];
    if (Array.isArray(c.endpoints)) {
      endpoints = c.endpoints.filter((e): e is string => typeof e === 'string');
    } else if (typeof (c as any).endpoint === 'string') {
      endpoints = [(c as any).endpoint];
    }
    endpoints = endpoints.map((e) => normalizeEndpoint(e)).filter(Boolean);
    if (!endpoints.length) continue;

    const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : endpoints[0];

    result.push({
      id: generateId(),
      name,
      endpoints,
      username: typeof c.username === 'string' ? c.username : undefined,
      password: typeof c.password === 'string' ? c.password : undefined,
      envTag: c.envTag as EtcdConnection['envTag'],
      colorTheme: c.colorTheme as EtcdConnection['colorTheme'],
      connectionTimeoutMs: typeof c.connectionTimeoutMs === 'number' ? c.connectionTimeoutMs : undefined,
      idleConnectionTimeoutMs: typeof c.idleConnectionTimeoutMs === 'number' ? c.idleConnectionTimeoutMs : undefined,
      operationTimeoutMs: typeof c.operationTimeoutMs === 'number' ? c.operationTimeoutMs : undefined,
    });
  }

  return result;
}

function sanitizeConnections(
  connections: EtcdConnection[]
): { connections: EtcdConnection[]; updated: boolean } {
  let updated = false;
  const sanitized = connections.map((c) => {
    const fixed = {
      ...c,
      endpoints: c.endpoints.map((e) => normalizeEndpoint(e)),
    } as EtcdConnection;
    return fixed;
  });
  return { connections: sanitized, updated };
}


