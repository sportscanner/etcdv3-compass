import * as vscode from 'vscode';
import { Etcd3, IOptions } from 'etcd3';
import { EtcdConnection } from '../types';
import type * as RPC from 'etcd3/lib/rpc';

type TreeNode = ConnectionItem | FolderItem | KeyItem | NoKeysItem | ErrorItem;

export class EtcdTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeNode | undefined | null | void>();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private connections: EtcdConnection[] = [];
  private clientsById: Map<string, Etcd3> = new Map();

  constructor() {}

  public setConnections(connections: EtcdConnection[]) {
    this.connections = connections;
    this.onDidChangeTreeDataEmitter.fire();
  }

  public refresh() {
    this.onDidChangeTreeDataEmitter.fire();
  }

  public refreshItem(item?: TreeNode) {
    this.onDidChangeTreeDataEmitter.fire(item);
  }

  public async getClientByConnectionId(connectionId: string): Promise<Etcd3> {
    const conn = this.connections.find((c) => c.id === connectionId);
    if (!conn) {
      throw new Error('Connection not found');
    }
    return this.getClient(conn);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      if (!this.connections.length) {
        return [new NoKeysItem('No connections. Use the + button to add one.')];
      }
      return this.connections.map((c) => new ConnectionItem(c));
    }

    if (element instanceof ConnectionItem) {
      return this.loadFolderChildren(element.connection.id, '');
    }

    if (element instanceof FolderItem) {
      return this.loadFolderChildren(element.connectionId, element.prefix);
    }

    return [];
  }

  private async loadFolderChildren(connectionId: string, prefix: string): Promise<TreeNode[]> {
    try {
      const conn = this.connections.find((c) => c.id === connectionId)!;
      const client = await this.getClient(conn);
      // fetch keys under prefix
      const builder: any = client.getAll();
      let resp: RPC.IRangeResponse;
      if (prefix) {
        resp = await builder.prefix(prefix).exec();
      } else {
        resp = await builder.exec();
      }
      const kvs: RPC.IKeyValue[] = resp.kvs || [];
      if (!kvs.length && !prefix) {
        return [new NoKeysItem('No keys found')];
      }

      // Build sets of immediate children under this prefix
      const folderNames = new Set<string>();
      const leaseIds = new Set<string>();
      const leafKvs: RPC.IKeyValue[] = [];

      for (const kv of kvs) {
        const keyStr = Buffer.from(kv.key).toString();
        const remainder = prefix ? keyStr.slice(prefix.length) : keyStr;
        const slashIdx = remainder.indexOf('/');
        if (slashIdx === -1 || remainder === '') {
          // leaf under this prefix
          leafKvs.push(kv);
        } else {
          const nextFolder = remainder.slice(0, slashIdx + 1); // include trailing '/'
          folderNames.add(nextFolder);
        }
        if (kv.lease && kv.lease !== '0') leaseIds.add(kv.lease);
      }

      // TTL lookup for leases
      const ttlByLease: Record<string, number> = {};
      if (leaseIds.size) {
        const leaseClient: any = (client as any).leaseClient;
        if (leaseClient?.leaseTimeToLive) {
          await Promise.all(
            Array.from(leaseIds).map(async (id) => {
              try {
                const info: RPC.ILeaseTimeToLiveResponse = await leaseClient.leaseTimeToLive({ ID: id, keys: false });
                ttlByLease[id] = Number(info.TTL || 0);
              } catch {
                ttlByLease[id] = 0;
              }
            })
          );
        }
      }

      const folders = Array.from(folderNames)
        .sort((a, b) => a.localeCompare(b))
        .map((name) => new FolderItem(connectionId, prefix + name, name));

      const keys = leafKvs
        .map((kv) => {
          const fullKey = Buffer.from(kv.key).toString();
          const value = Buffer.from(kv.value).toString();
          const leaseId = kv.lease && kv.lease !== '0' ? kv.lease : undefined;
          const ttl = leaseId ? ttlByLease[leaseId] ?? undefined : undefined;
          const expiresAt = typeof ttl === 'number' && ttl > 0 ? new Date(Date.now() + ttl * 1000).toISOString() : undefined;
          return new KeyItem(connectionId, fullKey, value, {
            createRevision: kv.create_revision,
            modRevision: kv.mod_revision,
            version: kv.version,
            leaseId,
            ttlSeconds: ttl,
            expiresAt,
          });
        })
        .sort((a, b) => a.key.localeCompare(b.key));

      return [...folders, ...keys];
    } catch (err: any) {
      const host = this.connections.find((c) => c.id === connectionId)?.endpoints.join(', ');
      const message = (err?.message ? `${err.message}` : 'Failed to load keys') + (host ? ` (${host})` : '');
      return [new ErrorItem(message)];
    }
  }

  dispose() {
    for (const client of this.clientsById.values()) {
      client.close();
    }
    this.clientsById.clear();
  }

  private async getClient(conn: EtcdConnection): Promise<Etcd3> {
    const existing = this.clientsById.get(conn.id);
    if (existing) return existing;

    const options: IOptions = {
      hosts: conn.endpoints,
    } as IOptions;
    if (conn.username && conn.password) {
      (options as any).auth = { username: conn.username, password: conn.password };
    }
    const client = new Etcd3(options);
    this.clientsById.set(conn.id, client);
    return client;
  }
}

class ConnectionItem extends vscode.TreeItem {
  constructor(public readonly connection: EtcdConnection) {
    super(connection.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'etcd-connection';
    const tag = connection.envTag ? connection.envTag.toUpperCase() : undefined;
    const descriptionParts = [connection.endpoints.join(', '), tag ? `[${tag}]` : undefined].filter(Boolean);
    this.tooltip = `${connection.endpoints.join(', ')}`;
    this.description = descriptionParts.join(' ');
    const color = connection.colorTheme ? new vscode.ThemeColor(connection.colorTheme) : undefined;
    this.iconPath = new vscode.ThemeIcon('server', color);
  }
}

class FolderItem extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly prefix: string,
    public readonly labelName: string
  ) {
    super(labelName, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'etcd-folder';
    this.iconPath = new vscode.ThemeIcon('folder');
    this.tooltip = prefix;
  }
}

export interface KeyMetadata {
  createRevision?: string;
  modRevision?: string;
  version?: string;
  leaseId?: string;
  ttlSeconds?: number;
  expiresAt?: string;
}

class KeyItem extends vscode.TreeItem {
  constructor(
    public readonly connectionId: string,
    public readonly key: string,
    public readonly value: string,
    public readonly meta?: KeyMetadata
  ) {
    super(key, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'etcd-key';
    this.tooltip = this.buildTooltip();
    this.description = value; // VS Code renders description in a dimmer color
    this.iconPath = new vscode.ThemeIcon('key');
  }

  private buildTooltip(): string {
    const lines: string[] = [];
    lines.push(`Key: ${this.key}`);
    lines.push(`Value: ${this.value}`);
    if (this.meta?.createRevision) lines.push(`Create rev: ${this.meta.createRevision}`);
    if (this.meta?.modRevision) lines.push(`Mod rev: ${this.meta.modRevision}`);
    if (this.meta?.version) lines.push(`Version: ${this.meta.version}`);
    if (this.meta?.leaseId) lines.push(`Lease: ${this.meta.leaseId}`);
    if (typeof this.meta?.ttlSeconds === 'number') lines.push(`TTL: ${this.meta.ttlSeconds}s`);
    if (this.meta?.expiresAt) lines.push(`Expires: ${this.meta.expiresAt}`);
    return lines.join('\n');
  }
}

class NoKeysItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'etcd-empty';
    this.iconPath = new vscode.ThemeIcon('info');
  }
}

class ErrorItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'etcd-error';
    this.iconPath = new vscode.ThemeIcon('error');
  }
}


