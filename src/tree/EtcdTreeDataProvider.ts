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
  private connectionStatus: Map<string, 'connected' | 'disconnected' | 'unknown'> = new Map();
  private lastConnectionTest: Map<string, number> = new Map();
  private cachedChildren = new Map<string, TreeNode[]>();

  constructor() {
    // Start periodic health checks for connections
    this.startHealthChecks();
  }

  public setConnections(connections: EtcdConnection[]) {
    this.connections = connections;
    // Clear cache when connections change
    this.cachedChildren.clear();
    // Initialize connection status for new connections
    connections.forEach(conn => {
      if (!this.connectionStatus.has(conn.id)) {
        this.connectionStatus.set(conn.id, 'unknown');
      }
    });
    this.onDidChangeTreeDataEmitter.fire();
  }

  public refresh() {
    // Clear cache to force reload
    this.cachedChildren.clear();
    this.onDidChangeTreeDataEmitter.fire();
  }

  public refreshItem(item?: TreeNode) {
    this.onDidChangeTreeDataEmitter.fire(item);
  }

  public refreshConnection(connectionItem: ConnectionItem) {
    // Clear cache for this specific connection
    const flatCacheKey = `${connectionItem.connection.id}:flat`;
    const treeCacheKey = `${connectionItem.connection.id}:tree`;
    this.cachedChildren.delete(flatCacheKey);
    this.cachedChildren.delete(treeCacheKey);
    
    // Fire event only for this connection
    this.onDidChangeTreeDataEmitter.fire(connectionItem);
  }

  public refreshConnectionInstant(connectionItem: ConnectionItem) {
    // For instant operations like toggle flatten, ensure we have cached data first
    const cacheKey = `${connectionItem.connection.id}:${connectionItem.isFlattened ? 'flat' : 'tree'}`;
    
    if (!this.cachedChildren.has(cacheKey)) {
      // If no cached data exists, we need to load it first
      // This will show loading initially, but subsequent toggles will be instant
      this.onDidChangeTreeDataEmitter.fire(connectionItem);
    } else {
      // Data is already cached, can toggle instantly
      this.onDidChangeTreeDataEmitter.fire(connectionItem);
    }
  }

  public getConnections(): EtcdConnection[] {
    return this.connections;
  }

  public async getClientByConnectionId(connectionId: string): Promise<Etcd3> {
    const conn = this.connections.find((c) => c.id === connectionId);
    if (!conn) {
      throw new Error('Connection not found');
    }
    return this.getClient(conn);
  }

  public async testConnection(conn: EtcdConnection): Promise<boolean> {
    try {
      const client = await this.getClient(conn);
      // Test the connection with a simple get operation using a non-empty key
      await client.get('__test_connection_key__').exec();
      this.connectionStatus.set(conn.id, 'connected');
      return true;
    } catch (error: any) {
      console.error('Connection test failed:', error?.message || error);
      this.connectionStatus.set(conn.id, 'disconnected');
      return false;
    }
  }

  private startHealthChecks() {
    // Check connection health every 60 seconds (less aggressive)
    setInterval(async () => {
      for (const conn of this.connections) {
        try {
          const existingClient = this.clientsById.get(conn.id);
          if (existingClient) {
            // Only test if we haven't tested recently
            const lastTest = this.lastConnectionTest.get(conn.id) || 0;
            const now = Date.now();
            
            if (now - lastTest > 30000) { // Test every 30 seconds max
              await existingClient.get('__test_connection_key__').exec();
              const currentStatus = this.connectionStatus.get(conn.id);
              if (currentStatus !== 'connected') {
                this.connectionStatus.set(conn.id, 'connected');
                this.onDidChangeTreeDataEmitter.fire();
              }
              this.lastConnectionTest.set(conn.id, now);
            }
          } else {
            // No client exists, mark as unknown
            const currentStatus = this.connectionStatus.get(conn.id);
            if (currentStatus !== 'unknown') {
              this.connectionStatus.set(conn.id, 'unknown');
              this.onDidChangeTreeDataEmitter.fire();
            }
          }
        } catch (error) {
          // Only mark as disconnected if we're sure it's failed
          const currentStatus = this.connectionStatus.get(conn.id);
          if (currentStatus === 'connected') {
            this.connectionStatus.set(conn.id, 'disconnected');
            this.onDidChangeTreeDataEmitter.fire();
          }
          this.lastConnectionTest.set(conn.id, Date.now());
        }
      }
    }, 60000); // 60 seconds
  }

  public getConnectionStatus(connectionId: string): 'connected' | 'disconnected' | 'unknown' {
    return this.connectionStatus.get(connectionId) || 'unknown';
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      if (!this.connections.length) {
        return [new NoKeysItem('No connections. Use the + button to add one.')];
      }
      return this.connections.map((c) => new ConnectionItem(c, this.getConnectionStatus(c.id)));
    }

    if (element instanceof ConnectionItem) {
      const cacheKey = `${element.connection.id}:${element.isFlattened ? 'flat' : 'tree'}`;
      
      // Return cached data if available
      if (this.cachedChildren.has(cacheKey)) {
        return this.cachedChildren.get(cacheKey)!;
      }
      
      // Return loading indicator immediately
      const loadingItem = new NoKeysItem('Loading...');
      
      // Load data in background without blocking
      this.loadChildrenAsync(element, cacheKey);
      
      return [loadingItem];
    }

    if (element instanceof FolderItem) {
      const cacheKey = `${element.connectionId}:${element.prefix}`;
      
      // Return cached data if available
      if (this.cachedChildren.has(cacheKey)) {
        return this.cachedChildren.get(cacheKey)!;
      }
      
      // Return loading indicator immediately
      const loadingItem = new NoKeysItem('Loading...');
      
      // Load data in background without blocking
      this.loadFolderChildrenAsync(element, cacheKey);
      
      return [loadingItem];
    }

    return [];
  }

  private async loadChildrenAsync(element: ConnectionItem, cacheKey: string) {
    try {
      let children: TreeNode[];
      if (element.isFlattened) {
        children = await this.loadFlattenedKeys(element.connection.id);
      } else {
        children = await this.loadFolderChildren(element.connection.id, '');
      }
      this.cachedChildren.set(cacheKey, children);
      
      // Pre-load the other view type for instant toggling
      const otherCacheKey = `${element.connection.id}:${element.isFlattened ? 'tree' : 'flat'}`;
      if (!this.cachedChildren.has(otherCacheKey)) {
        // Load the other view type in background for instant toggling
        this.preloadOtherView(element, otherCacheKey);
      }
      
      this.onDidChangeTreeDataEmitter.fire(element);
    } catch (error) {
      // Cache error result to prevent repeated attempts
      this.cachedChildren.set(cacheKey, [new ErrorItem('Failed to load data')]);
      this.onDidChangeTreeDataEmitter.fire(element);
    }
  }

  private async preloadOtherView(element: ConnectionItem, otherCacheKey: string) {
    try {
      let children: TreeNode[];
      if (element.isFlattened) {
        // If currently flattened, pre-load tree view
        children = await this.loadFolderChildren(element.connection.id, '');
      } else {
        // If currently tree view, pre-load flattened view
        children = await this.loadFlattenedKeys(element.connection.id);
      }
      this.cachedChildren.set(otherCacheKey, children);
    } catch (error) {
      // Cache error result for the other view too
      this.cachedChildren.set(otherCacheKey, [new ErrorItem('Failed to load data')]);
    }
  }

  private async loadFolderChildrenAsync(element: FolderItem, cacheKey: string) {
    try {
      const children = await this.loadFolderChildren(element.connectionId, element.prefix);
      this.cachedChildren.set(cacheKey, children);
      this.onDidChangeTreeDataEmitter.fire(element);
    } catch (error) {
      // Cache error result to prevent repeated attempts
      this.cachedChildren.set(cacheKey, [new ErrorItem('Failed to load data')]);
      this.onDidChangeTreeDataEmitter.fire(element);
    }
  }

  private async loadFolderChildren(connectionId: string, prefix: string): Promise<TreeNode[]> {
    try {
      const conn = this.connections.find((c) => c.id === connectionId)!;
      const client = await this.getClient(conn);
      // fetch keys under prefix with timeout
      const builder: any = client.getAll();
      let resp: RPC.IRangeResponse;
      
      const operationTimeout = conn.operationTimeoutMs || 5000; // 5 seconds default
      const fetchPromise = prefix ? builder.prefix(prefix).exec() : builder.exec();
      const timeoutPromise = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error(`Connection timeout`)), operationTimeout)
      );
      
      resp = await Promise.race([fetchPromise, timeoutPromise]);
      
      // Mark as connected if operation succeeds
      const currentStatus = this.connectionStatus.get(connectionId);
      if (currentStatus !== 'connected') {
        this.connectionStatus.set(connectionId, 'connected');
        this.onDidChangeTreeDataEmitter.fire();
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
          const leaseTimeout = Math.min(operationTimeout, 5000); // Max 5 seconds for lease operations
          await Promise.all(
            Array.from(leaseIds).map(async (id) => {
              try {
                const leasePromise = leaseClient.leaseTimeToLive({ ID: id, keys: false });
                const timeoutPromise = new Promise<never>((_, reject) => 
                  setTimeout(() => reject(new Error('Lease TTL lookup timed out')), leaseTimeout)
                );
                const info: RPC.ILeaseTimeToLiveResponse = await Promise.race([leasePromise, timeoutPromise]);
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
          }, this.getConnectionColor(connectionId)); // Pass connection color
        })
        .sort((a, b) => a.key.localeCompare(b.key));

      return [...folders, ...keys];
    } catch (err: any) {
      let message = 'Failed to load keys';
      
      if (err?.message?.includes('timeout')) {
        message = 'Connection timeout';
      } else if (err?.message?.includes('ECONNREFUSED')) {
        message = 'Connection refused';
      } else if (err?.message?.includes('ENOTFOUND')) {
        message = 'Server not found';
      } else if (err?.message) {
        message = err.message;
      }
      
      return [new ErrorItem(message)];
    }
  }

  private async loadFlattenedKeys(connectionId: string): Promise<TreeNode[]> {
    try {
      const conn = this.connections.find((c) => c.id === connectionId)!;
      const client = await this.getClient(conn);
      
      const operationTimeout = conn.operationTimeoutMs || 5000; // 5 seconds default
      const fetchPromise = client.getAll().exec();
      const timeoutPromise = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error(`Connection timeout`)), operationTimeout)
      );
      
      const resp = await Promise.race([fetchPromise, timeoutPromise]);
      
      // Mark as connected if operation succeeds
      const currentStatus = this.connectionStatus.get(connectionId);
      if (currentStatus !== 'connected') {
        this.connectionStatus.set(connectionId, 'connected');
        this.onDidChangeTreeDataEmitter.fire();
      }
      
      const kvs: RPC.IKeyValue[] = resp.kvs || [];
      if (!kvs.length) {
        return [new NoKeysItem('No keys found')];
      }

      return kvs.map((kv) => {
        const fullKey = Buffer.from(kv.key).toString();
        const value = Buffer.from(kv.value).toString();
        return new KeyItem(connectionId, fullKey, value, undefined, this.getConnectionColor(connectionId)); // Pass connection color
      });
    } catch (err: any) {
      let message = 'Failed to load keys';
      
      if (err?.message?.includes('timeout')) {
        message = 'Connection timeout';
      } else if (err?.message?.includes('ECONNREFUSED')) {
        message = 'Connection refused';
      } else if (err?.message?.includes('ENOTFOUND')) {
        message = 'Server not found';
      } else if (err?.message) {
        message = err.message;
      }
      
      return [new ErrorItem(message)];
    }
  }

  dispose() {
    for (const client of this.clientsById.values()) {
      client.close();
    }
    this.clientsById.clear();
    this.onDidChangeTreeDataEmitter.dispose();
  }

  private async getClient(conn: EtcdConnection): Promise<Etcd3> {
    const existing = this.clientsById.get(conn.id);
    if (existing) {
      // Only test connection health occasionally, not on every request
      const lastTest = this.lastConnectionTest.get(conn.id) || 0;
      const now = Date.now();
      
      if (now - lastTest > 10000) { // Test every 10 seconds max
        try {
          await existing.get('__test_connection_key__').exec();
          // Mark as connected if test succeeds
          this.connectionStatus.set(conn.id, 'connected');
          this.lastConnectionTest.set(conn.id, now);
        } catch (error) {
          // Client is stale, remove it and create a new one
          existing.close();
          this.clientsById.delete(conn.id);
          this.connectionStatus.set(conn.id, 'disconnected');
          this.lastConnectionTest.set(conn.id, now);
        }
      }
      
      // Return existing client if it still exists
      if (this.clientsById.has(conn.id)) {
        return existing;
      }
    }

    // Ensure endpoints are properly formatted for etcd3
    const formattedEndpoints = conn.endpoints.map(endpoint => {
      // If endpoint doesn't have a protocol, assume it's localhost or IP
      if (!endpoint.includes('://')) {
        return endpoint; // etcd3 will handle the protocol
      }
      return endpoint;
    });

    const options: IOptions = {
      hosts: formattedEndpoints,
      // Set reasonable default timeouts if not provided
      dialTimeout: conn.connectionTimeoutMs || 5000, // 5 seconds default
      idleConnectionTimeout: conn.idleConnectionTimeoutMs || 0, // 0 = disable by default
      // Set operation timeout for all operations
      ...(conn.operationTimeoutMs ? { timeout: conn.operationTimeoutMs } : { timeout: 5000 }), // 5 seconds default
      // relax circuit breaker by increasing max failures and reset time
      backoffStrategy: {
        initial: 1000,
        max: 30000,
        multiplier: 1.5,
        jitter: 0.2
      }
    } as IOptions;
    if (conn.username && conn.password) {
      (options as any).auth = { username: conn.username, password: conn.password };
    }
    const client = new Etcd3(options);
    this.clientsById.set(conn.id, client);
    
    // Mark as connected since we successfully created the client
    this.connectionStatus.set(conn.id, 'connected');
    this.lastConnectionTest.set(conn.id, Date.now());
    // Fire event immediately to update UI
    this.onDidChangeTreeDataEmitter.fire();
    
    return client;
  }

  getParent(element: TreeNode): TreeNode | undefined {
    if (element instanceof FolderItem) {
      const parts = element.prefix.split('/').filter(Boolean);
      if (parts.length === 0) {
        const conn = this.connections.find(c => c.id === element.connectionId);
        return conn ? new ConnectionItem(conn, this.getConnectionStatus(conn.id)) : undefined;
      }
      const parentPrefix = parts.slice(0, -1).join('/') + '/';
      return new FolderItem(element.connectionId, parentPrefix, parentPrefix.split('/').filter(Boolean).pop() + '/');
    }
    if (element instanceof KeyItem) {
      const parts = element.key.split('/').filter(Boolean);
      if (parts.length === 0) return undefined;
      const parentPrefix = parts.slice(0, -1).join('/') + '/';
      return new FolderItem(element.connectionId, parentPrefix, parentPrefix.split('/').filter(Boolean).pop() + '/');
    }
    return undefined;
  }

  private getConnectionColor(connectionId: string): vscode.ThemeColor | undefined {
    const conn = this.connections.find((c) => c.id === connectionId);
    if (conn && conn.colorTheme) {
      return new vscode.ThemeColor(conn.colorTheme);
    }
    return undefined;
  }
}

export class ConnectionItem extends vscode.TreeItem {
  public isFlattened = false; // Track flatten mode
  public isTreeView = true; // Track tree view mode

  constructor(public readonly connection: EtcdConnection, private readonly connectionStatus?: 'connected' | 'disconnected' | 'unknown') {
    super(connection.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'etcd-connection';
    const tag = connection.envTag ? connection.envTag.toUpperCase() : undefined;
    // Add status indicator to the description at the end
    const statusIcon = this.connectionStatus === 'connected' ? '✓' : this.connectionStatus === 'disconnected' ? '✗' : '?';
    const descriptionParts = [connection.endpoints.join(', '), tag ? `[${tag}]` : undefined, statusIcon].filter(Boolean);
    this.tooltip = `${connection.endpoints.join(', ')}\nStatus: ${this.connectionStatus || 'unknown'}`;
    this.description = descriptionParts.join(' ');
    
    // Keep server icon but use connection color
    const color = connection.colorTheme ? new vscode.ThemeColor(connection.colorTheme) : undefined;
    this.iconPath = new vscode.ThemeIcon('server', color);
    this.command = undefined; // Remove confusing toggle behavior
  }

  public getActions(): vscode.Command[] {
    return [
      {
        title: 'Toggle Tree View',
        command: 'etcdExplorer.toggleTreeView',
        arguments: [this]
      },
      {
        title: 'Toggle Flatten',
        command: 'etcdExplorer.toggleFlatten',
        arguments: [this]
      }
    ];
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
    public readonly meta?: KeyMetadata,
    connectionColor?: vscode.ThemeColor // Pass connection color
  ) {
    super(key, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'etcd-key';
    this.tooltip = this.buildTooltip();
    this.description = value; // VS Code renders description in a dimmer color
    this.iconPath = new vscode.ThemeIcon('key', connectionColor); // Apply connection color to key icon
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
