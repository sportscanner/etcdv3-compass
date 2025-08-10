import * as vscode from 'vscode';
import { AddConnectionPanel } from './panels/AddConnectionPanel';
import { EtcdTreeDataProvider } from './tree/EtcdTreeDataProvider';
import { EtcdDecorationProvider } from './decorations/EtcdDecorationProvider';
import { EtcdConnection } from './types';

const STATE_KEY = 'etcdConnections';

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
    vscode.commands.registerCommand('etcdExplorer.addConnection', async () => {
      const panel = new AddConnectionPanel(async (data) => {
        const connections = loadConnections(context);
        const id = generateId();
        const endpoint = normalizeEndpoint(data.endpoint);
        const newConn: EtcdConnection = {
          id,
          name: data.name,
          endpoints: [endpoint],
          username: data.username,
          password: data.password,
          envTag: (data as any).envTag,
          colorTheme: (data as any).colorTheme,
        };
        await context.globalState.update(STATE_KEY, [...connections, newConn]);
        treeProvider.setConnections([...connections, newConn]);
        if (newConn.colorTheme) {
          const uri = vscode.Uri.parse(`etcd:${newConn.id}`);
          colorMap.set(uri.toString(), new vscode.ThemeColor(newConn.colorTheme));
          decProvider.refresh(uri);
        }
      });
      panel.show();
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
      try {
        const client = await treeProvider.getClientByConnectionId(keyItem.connectionId);
        await client.delete().key(keyItem.key!);
        vscode.window.showInformationMessage('Key deleted');
        treeProvider.refresh();
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


