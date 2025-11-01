import * as vscode from 'vscode';
import { ConnectionManager } from '../opcua/connectionManager';
import { OpcuaConnectionConfig, ConnectionStatus } from '../types';
import { ReferenceDescription, NodeClass } from 'node-opcua';

export class OpcuaTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
    private _onDidChangeTreeData: vscode.EventEmitter<TreeNode | undefined | null | void> = new vscode.EventEmitter<TreeNode | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined | null | void> = this._onDidChangeTreeData.event;

    // Cache node parent-child relationships for getParent
    private nodeParentMap: Map<string, TreeNode> = new Map();

    // Tracks whether each connection shows non-hierarchical references
    private showNonHierarchicalReferences: Map<string, boolean> = new Map();
    
    constructor(private connectionManager: ConnectionManager) {}

    refresh(element?: TreeNode): void {
        if (!element) {
            this.nodeParentMap.clear();
        }
        this._onDidChangeTreeData.fire(element);
    }

    refreshConnection(connectionId: string): void {
        // Refresh specific connection node
        this.nodeParentMap.clear();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        return element;
    }

    getParent(element: TreeNode): TreeNode | undefined {
        if (element instanceof ConnectionNode) {
            // Connection nodes have no parent node
            return undefined;
        }

        if (element instanceof OpcuaNode) {
            // Find parent node from cache
            const key = `${element.connectionId}:${element.nodeId}`;
            return this.nodeParentMap.get(key);
        }

        return undefined;
    }

    async getChildren(element?: TreeNode): Promise<TreeNode[]> {
        if (!element) {
            // Return all connections
            return this.getConnectionNodes();
        }

        if (element instanceof ConnectionNode) {
            // Return server root nodes
            return this.getRootNodes(element.connectionId);
        }

        if (element instanceof OpcuaNode) {
            // Return child nodes of the node
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

            // Find connection node as parent node
            const connectionNode = this.getConnectionNodes().find(
                node => node instanceof ConnectionNode && (node as ConnectionNode).connectionId === connectionId
            );

            const nodes = uniqueReferences.map(ref => {
                const nodeIdString = ref.nodeId?.toString() ?? '';
                return new OpcuaNode(
                    connectionId,
                    nodeIdString,
                    ref.displayName.text || ref.browseName.name || '',
                    ref.nodeClass,
                    this.isProbablyExpandable(ref)
                );
            });

            // Cache parent-child relationships and nodes
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
            const nodes = uniqueReferences.map(ref => {
                const nodeIdString = ref.nodeId?.toString() ?? '';
                return new OpcuaNode(
                    connectionId,
                    nodeIdString,
                    ref.displayName.text || ref.browseName.name || '',
                    ref.nodeClass,
                    this.isProbablyExpandable(ref)
                );
            });

            // Cache parent-child relationships and nodes
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

    isShowingNonHierarchical(connectionId: string): boolean {
        return this.showNonHierarchicalReferences.get(connectionId) ?? true;
    }

    toggleNonHierarchicalReferences(connectionId: string): boolean {
        const nextValue = !this.isShowingNonHierarchical(connectionId);
        this.showNonHierarchicalReferences.set(connectionId, nextValue);
        this.nodeParentMap.clear();
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

    private isProbablyExpandable(ref: ReferenceDescription): boolean {
        if (!ref) {
            return false;
        }

        switch (ref.nodeClass) {
            case NodeClass.Method:
            case NodeClass.ReferenceType:
                return false;
            default:
                return true;
        }
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

        // Set click command
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
