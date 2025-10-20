import * as vscode from 'vscode';
import { ConnectionManager } from '../opcua/connectionManager';
import { OpcuaConnectionConfig, ConnectionStatus } from '../types';
import { ReferenceDescription, NodeClass } from 'node-opcua';
import { OpcuaClient } from '../opcua/opcuaClient';

export class OpcuaTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<TreeNode | undefined | null | void> = new vscode.EventEmitter<TreeNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined | null | void> = this._onDidChangeTreeData.event;

    // 缓存节点的父子关系，用于 getParent
    private nodeParentMap: Map<string, TreeNode> = new Map();

    // Tracks whether each connection shows non-hierarchical references
    private showNonHierarchicalReferences: Map<string, boolean> = new Map();

    private readonly childPresenceCache: Map<string, { hasChildren: boolean; expiresAt: number }> = new Map();
    private static readonly CHILD_CACHE_TTL_MS = 60_000;

    
    constructor(private connectionManager: ConnectionManager) {}

    refresh(element?: TreeNode): void {
        if (!element) {
            this.clearChildPresenceCache();
        } else if (element instanceof ConnectionNode) {
            this.clearChildPresenceCache(element.connectionId);
        } else if (element instanceof OpcuaNode) {
            this.clearChildPresenceCache(element.connectionId);
        }
        this._onDidChangeTreeData.fire(element);
    }

    refreshConnection(connectionId: string): void {
        // 刷新特定连接节点
        this.clearChildPresenceCache(connectionId);
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    getParent(element: TreeNode): TreeNode | undefined {
        if (element instanceof ConnectionNode) {
            // 连接节点没有父节点
            return undefined;
        }

        if (element instanceof OpcuaNode) {
            // 从缓存中查找父节点
            const key = `${element.connectionId}:${element.nodeId}`;
            return this.nodeParentMap.get(key);
        }

        return undefined;
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (!element) {
            // 返回所有连接
            return this.getConnectionNodes();
        }

        if (element instanceof ConnectionNode) {
            // 返回服务器的根节点
            return this.getRootNodes(element.connectionId);
        }

        if (element instanceof OpcuaNode) {
            // 返回节点的子节点
            return this.getChildNodes(element.connectionId, element.nodeId, element);
        }

        return [];
    }

    private getConnectionNodes(): TreeNode[] {
        const nodes: TreeNode[] = [];
        const connections = this.connectionManager.getAllConnections();

        for (const [id, client] of connections.entries()) {
            const config = this.connectionManager.getConnectionConfig(id);
            if (config) {
                const includeNonHierarchical = this.isShowingNonHierarchical(id);
                nodes.push(new ConnectionNode(config, client.status, includeNonHierarchical));
            }
        }

        return nodes;
    }

    private async getRootNodes(connectionId: string): Promise<TreeNode[]> {
        try {
            console.log(`getRootNodes called for connection: ${connectionId}`);
            const client = this.connectionManager.getConnection(connectionId);
            if (!client) {
                console.log('Client not found');
                return [];
            }

            console.log(`Client status: ${client.status}, isConnected: ${client.isConnected}`);
            if (!client.isConnected) {
                console.log('Client not connected');
                return [];
            }

            console.log('Browsing RootFolder...');
            const references = await client.browseWithOptions('RootFolder', {
                includeNonHierarchical: this.isShowingNonHierarchical(connectionId)
            });
            const uniqueReferences = this.filterUniqueByNodeId(references);
            console.log(`Found ${references.length} root nodes`);
            if (uniqueReferences.length !== references.length) {
                console.log(`Filtered ${references.length - uniqueReferences.length} duplicate root references`);
            }

            // 找到连接节点作为父节点
            const connectionNode = this.getConnectionNodes().find(
                node => node instanceof ConnectionNode && (node as ConnectionNode).connectionId === connectionId
            );

            const childPresence = await this.resolveChildPresence(client, connectionId, uniqueReferences);
            const nodes = uniqueReferences.map(ref => {
                const nodeIdString = ref.nodeId?.toString() ?? '';
                const hasChildren = childPresence.get(nodeIdString) ?? false;
                return new OpcuaNode(
                    connectionId,
                    nodeIdString,
                    ref.displayName.text || ref.browseName.name || '',
                    ref.nodeClass,
                    hasChildren
                );
            });

            // 缓存父子关系和节点
            if (connectionNode) {
                nodes.forEach(node => {
                    const key = `${connectionId}:${(node as OpcuaNode).nodeId}`;
                    this.nodeParentMap.set(key, connectionNode);
                });
            }

            return nodes;
        } catch (error) {
            console.error('Error getting root nodes:', error);
            return [];
        }
    }

    private async getChildNodes(connectionId: string, nodeId: string, parentNode?: OpcuaNode): Promise<TreeNode[]> {
        try {
            const client = this.connectionManager.getConnection(connectionId);
            if (!client || !client.isConnected) {
                return [];
            }

            const references = await client.browseWithOptions(nodeId, {
                includeNonHierarchical: this.isShowingNonHierarchical(connectionId)
            });
            const uniqueReferences = this.filterUniqueByNodeId(references);
            const childPresence = await this.resolveChildPresence(client, connectionId, uniqueReferences);
            const nodes = uniqueReferences.map(ref => {
                const nodeIdString = ref.nodeId?.toString() ?? '';
                const hasChildren = childPresence.get(nodeIdString) ?? false;
                return new OpcuaNode(
                    connectionId,
                    nodeIdString,
                    ref.displayName.text || ref.browseName.name || '',
                    ref.nodeClass,
                    hasChildren
                );
            });

            // 缓存父子关系和节点
            if (parentNode) {
                nodes.forEach(node => {
                    const key = `${connectionId}:${(node as OpcuaNode).nodeId}`;
                    this.nodeParentMap.set(key, parentNode);
                });
            }

            return nodes;
        } catch (error) {
            console.error('Error getting child nodes:', error);
            return [];
        }
    }

    private async resolveChildPresence(
        client: OpcuaClient,
        connectionId: string,
        references: ReferenceDescription[]
    ): Promise<Map<string, boolean>> {
        const result = new Map<string, boolean>();
        if (references.length === 0) {
            return result;
        }

        const includeNonHierarchical = this.isShowingNonHierarchical(connectionId);
        const now = Date.now();
        const refsToQuery: ReferenceDescription[] = [];

        for (const ref of references) {
            const nodeIdString = ref.nodeId?.toString();
            if (!nodeIdString) {
                continue;
            }
            const cacheKey = this.makeCacheKey(connectionId, nodeIdString, includeNonHierarchical);
            const cached = this.childPresenceCache.get(cacheKey);
            if (cached && cached.expiresAt > now) {
                result.set(nodeIdString, cached.hasChildren);
            } else {
                refsToQuery.push(ref);
            }
        }

        if (refsToQuery.length === 0) {
            return result;
        }

        const concurrency = Math.min(4, refsToQuery.length);
        let currentIndex = 0;

        const worker = async (): Promise<void> => {
            while (currentIndex < refsToQuery.length) {
                const index = currentIndex;
                currentIndex += 1;
                const ref = refsToQuery[index];
                const nodeIdString = ref.nodeId?.toString();
                if (!nodeIdString) {
                    continue;
                }

                try {
                    const childRefs = await client.browseWithOptions(nodeIdString, {
                        includeNonHierarchical
                    });
                    const hasChildren = childRefs.length > 0;
                    result.set(nodeIdString, hasChildren);
                    this.childPresenceCache.set(
                        this.makeCacheKey(connectionId, nodeIdString, includeNonHierarchical),
                        {
                            hasChildren,
                            expiresAt: Date.now() + OpcuaTreeDataProvider.CHILD_CACHE_TTL_MS
                        }
                    );
                } catch (error) {
                    console.error(`Failed to determine children for node ${nodeIdString}:`, error);
                    const hasChildren = false;
                    result.set(nodeIdString, hasChildren);
                    this.childPresenceCache.set(
                        this.makeCacheKey(connectionId, nodeIdString, includeNonHierarchical),
                        {
                            hasChildren,
                            expiresAt: Date.now() + OpcuaTreeDataProvider.CHILD_CACHE_TTL_MS
                        }
                    );
                }
            }
        };

        await Promise.all(
            new Array(concurrency)
                .fill(0)
                .map(() => worker())
        );

        return result;
    }

    private makeCacheKey(connectionId: string, nodeId: string, includeNonHierarchical: boolean): string {
        return `${connectionId}::${includeNonHierarchical ? 'all' : 'hier'}::${nodeId}`;
    }

    private clearChildPresenceCache(connectionId?: string): void {
        if (!connectionId) {
            this.childPresenceCache.clear();
            return;
        }

        const prefix = `${connectionId}::`;
        for (const key of Array.from(this.childPresenceCache.keys())) {
            if (key.startsWith(prefix)) {
                this.childPresenceCache.delete(key);
            }
        }
    }

    isShowingNonHierarchical(connectionId: string): boolean {
        return this.showNonHierarchicalReferences.get(connectionId) ?? true;
    }

    toggleNonHierarchicalReferences(connectionId: string): boolean {
        const nextValue = !this.isShowingNonHierarchical(connectionId);
        this.showNonHierarchicalReferences.set(connectionId, nextValue);
        this.nodeParentMap.clear();
        this.clearChildPresenceCache(connectionId);
        this.refresh();
        return nextValue;
    }

    private filterUniqueByNodeId(references: ReferenceDescription[]): ReferenceDescription[] {
        const seen = new Set<string>();
        return references.filter(ref => {
            const key = ref.nodeId.toString();
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }

}

export abstract class TreeNode extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
    }
}

export class ConnectionNode extends TreeNode {
    constructor(
        public readonly config: OpcuaConnectionConfig,
        public readonly status: ConnectionStatus,
        public readonly includeNonHierarchical: boolean
    ) {
        super(
            config.name || config.endpointUrl,
            status === ConnectionStatus.Connected
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        );

        this.tooltip = config.endpointUrl;
        const statusText = this.getStatusText(status);
        if (status === ConnectionStatus.Connected) {
            this.description = includeNonHierarchical
                ? `${statusText} - All refs`
                : `${statusText} - Hierarchical only`;
        } else {
            this.description = statusText;
        }
        this.iconPath = this.getStatusIcon(status);
        this.contextValue = status === ConnectionStatus.Connected
            ? 'opcua-server-connected'
            : 'opcua-server-disconnected';
    }

    get connectionId(): string {
        return this.config.id;
    }

    private getStatusText(status: ConnectionStatus): string {
        switch (status) {
            case ConnectionStatus.Connected:
                return 'Connected';
            case ConnectionStatus.Connecting:
                return 'Connecting...';
            case ConnectionStatus.Error:
                return 'Error';
            default:
                return 'Disconnected';
        }
    }

    private getStatusIcon(status: ConnectionStatus): vscode.ThemeIcon {
        switch (status) {
            case ConnectionStatus.Connected:
                return new vscode.ThemeIcon('vm-connect', new vscode.ThemeColor('charts.green'));
            case ConnectionStatus.Connecting:
                return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow'));
            case ConnectionStatus.Error:
                return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
            default:
                return new vscode.ThemeIcon('vm-outline');
        }
    }
}

export class OpcuaNode extends TreeNode {
    constructor(
        public readonly connectionId: string,
        public readonly nodeId: string,
        public readonly displayName: string,
        public readonly nodeClass: number,
        private readonly hasChildNodes: boolean
    ) {
        super(
            displayName,
            hasChildNodes
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        );

        this.tooltip = `NodeId: ${nodeId}`;
        this.description = this.getNodeClassText(nodeClass);
        this.iconPath = this.getNodeIcon(nodeClass);
        this.contextValue = 'opcua-node';

        // 设置点击命令
        this.command = {
            command: 'opcua.showNodeDetails',
            title: 'Show Node Details',
            arguments: [this]
        };
    }

    private getNodeClassText(nodeClass: number): string {
        const nodeClassNames: { [key: number]: string } = {
            1: 'Object',
            2: 'Variable',
            4: 'Method',
            8: 'ObjectType',
            16: 'VariableType',
            32: 'ReferenceType',
            64: 'DataType',
            128: 'View'
        };
        return nodeClassNames[nodeClass] || 'Unknown';
    }

    private getNodeIcon(nodeClass: number): vscode.ThemeIcon {
        switch (nodeClass) {
            case 1: // Object
                return new vscode.ThemeIcon('folder');
            case 2: // Variable
                return new vscode.ThemeIcon('symbol-variable');
            case 4: // Method
                return new vscode.ThemeIcon('symbol-method');
            case 8: // ObjectType
                return new vscode.ThemeIcon('symbol-class');
            case 16: // VariableType
                return new vscode.ThemeIcon('symbol-interface');
            case 32: // ReferenceType
                return new vscode.ThemeIcon('references');
            case 64: // DataType
                return new vscode.ThemeIcon('symbol-enum');
            case 128: // View
                return new vscode.ThemeIcon('eye');
            default:
                return new vscode.ThemeIcon('circle-outline');
        }
    }
}
