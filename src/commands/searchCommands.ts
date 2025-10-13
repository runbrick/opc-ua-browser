import * as vscode from 'vscode';
import { ConnectionManager } from '../opcua/connectionManager';
import { OpcuaTreeDataProvider, OpcuaNode, ConnectionNode } from '../providers/opcuaTreeDataProvider';

interface NodeSearchResult {
    nodeId: string;
    displayName: string;
    browseName: string;
    nodeClass: string;
    path: string;
    nodeIdPath: string[];
}

interface SearchResult extends NodeSearchResult {
    connectionId: string;
    connectionName: string;
}

export async function searchNodeCommand(
    connectionManager: ConnectionManager,
    treeDataProvider: OpcuaTreeDataProvider,
    treeView: vscode.TreeView<any>
): Promise<void> {
    // 获取所有连接
    const connections = connectionManager.getAllConnections();
    if (connections.size === 0) {
        vscode.window.showWarningMessage('No OPC UA connections available');
        return;
    }

    // 检查是否有已连接的服务器
    const connectedConnections = Array.from(connections.entries()).filter(
        ([id, client]) => client.isConnected
    );

    if (connectedConnections.length === 0) {
        vscode.window.showWarningMessage('Please connect to at least one OPC UA server first');
        return;
    }

    // 获取搜索关键词
    const searchTerm = await vscode.window.showInputBox({
        prompt: 'Enter search term (node name)',
        placeHolder: 'e.g., Temperature, Pressure, Motor',
        validateInput: (value) => {
            if (!value || value.trim().length === 0) {
                return 'Search term cannot be empty';
            }
            return null;
        }
    });

    if (!searchTerm) {
        return;
    }

    // 选择搜索范围
    const searchScope = await vscode.window.showQuickPick(
        [
            { label: 'All Connected Servers', value: 'all' },
            { label: 'Select Specific Server', value: 'specific' }
        ],
        { placeHolder: 'Select search scope' }
    );

    if (!searchScope) {
        return;
    }

    let connectionsToSearch: Array<[string, any]> = [];

    if (searchScope.value === 'all') {
        connectionsToSearch = connectedConnections;
    } else {
        // 让用户选择特定的连接
        const connectionItems = connectedConnections.map(([id, client]) => {
            const config = connectionManager.getConnectionConfig(id);
            return {
                label: config?.name || config?.endpointUrl || id,
                description: config?.endpointUrl,
                connectionId: id
            };
        });

        const selectedConnection = await vscode.window.showQuickPick(connectionItems, {
            placeHolder: 'Select server to search'
        });

        if (!selectedConnection) {
            return;
        }

        const connection = connectedConnections.find(([id]) => id === selectedConnection.connectionId);
        if (connection) {
            connectionsToSearch = [connection];
        }
    }

    // 显示进度条进行搜索
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Searching for "${searchTerm}"`,
            cancellable: true
        },
        async (progress, token) => {
            const results: SearchResult[] = [];
            let searchedNodes = 0;

            // 执行完整搜索
            for (const [connectionId, client] of connectionsToSearch) {
                if (token.isCancellationRequested) {
                    break;
                }

                const config = connectionManager.getConnectionConfig(connectionId);
                const connectionName = config?.name || config?.endpointUrl || connectionId;
                let previousCount = 0;

                progress.report({
                    message: `Searching in ${connectionName}...`
                });

                try {
                    const searchResults = await client.searchNodes(
                        searchTerm,
                        (current: number, total: number) => {
                            const increment = current - previousCount;
                            previousCount = current;
                            searchedNodes += increment > 0 ? increment : 0;
                            progress.report({
                                message: `Searching in ${connectionName}... (${current}/${total} nodes)`
                            });
                        },
                        token
                    );

                    results.push(...searchResults.map((r: NodeSearchResult): SearchResult => ({
                        ...r,
                        connectionId,
                        connectionName
                    })));
                } catch (error) {
                    console.error(`Error searching in connection ${connectionId}:`, error);
                    vscode.window.showErrorMessage(
                        `Error searching in ${connectionName}: ${error instanceof Error ? error.message : 'Unknown error'}`
                    );
                }
            }

            if (token.isCancellationRequested) {
                vscode.window.showInformationMessage('Search cancelled');
                return;
            }

            // 显示搜索结果
            if (results.length === 0) {
                vscode.window.showInformationMessage(
                    `No nodes found matching "${searchTerm}" (searched ${searchedNodes} nodes)`
                );
                return;
            }

            // 创建 QuickPick 显示结果
            const quickPick = vscode.window.createQuickPick();
            quickPick.title = `Search Results for "${searchTerm}"`;
            quickPick.placeholder = `Found ${results.length} matching nodes (searched ${searchedNodes} nodes)`;
            quickPick.items = results.map(result => ({
                label: result.displayName,
                description: result.nodeClass,
                detail: `${result.connectionName} > ${result.path}`,
                result: result
            }));

            quickPick.onDidAccept(async () => {
                const selected = quickPick.selectedItems[0] as any;
                if (selected && selected.result) {
                    const result = selected.result as SearchResult;

                    // 在树视图中展开并定位到节点
                    try {
                        await revealNodeInTree(
                            treeView,
                            treeDataProvider,
                            connectionManager,
                            result.connectionId,
                            result.nodeIdPath,
                            result.displayName,
                            result.nodeClass
                        );
                    } catch (error) {
                        console.error('Error revealing node in tree:', error);
                        vscode.window.showErrorMessage(`Error revealing node: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    }

                    quickPick.hide();
                }
            });

            quickPick.onDidHide(() => quickPick.dispose());
            quickPick.show();
        }
    );
}

function getNodeClassNumber(nodeClassName: string): number {
    const nodeClassMap: { [key: string]: number } = {
        'Object': 1,
        'Variable': 2,
        'Method': 4,
        'ObjectType': 8,
        'VariableType': 16,
        'ReferenceType': 32,
        'DataType': 64,
        'View': 128
    };
    return nodeClassMap[nodeClassName] || 0;
}


async function revealNodeInTree(
    treeView: vscode.TreeView<any>,
    treeDataProvider: OpcuaTreeDataProvider,
    connectionManager: ConnectionManager,
    connectionId: string,
    nodeIdPath: string[],
    displayName: string,
    nodeClass: string
): Promise<void> {
    // 1. 找到连接节点
    const connections = await treeDataProvider.getChildren();
    const connectionNode = connections.find(
        node => node instanceof ConnectionNode && (node as ConnectionNode).connectionId === connectionId
    ) as ConnectionNode;

    if (!connectionNode) {
        throw new Error('Connection node not found');
    }

    // 2. 展开连接节点
    await treeView.reveal(connectionNode, { select: false, focus: false, expand: true });

    // 3. 逐层展开到目标节点
    let currentNode: any = connectionNode;
    let currentNodeId = 'RootFolder';

    for (let i = 0; i < nodeIdPath.length; i++) {
        const targetNodeId = nodeIdPath[i];

        // 获取当前节点的子节点
        const children = await treeDataProvider.getChildren(currentNode);

        // 查找匹配的子节点
        const childNode = children.find(
            node => node instanceof OpcuaNode && (node as OpcuaNode).nodeId === targetNodeId
        );

        if (!childNode) {
            console.error(`Child node not found: ${targetNodeId}`);
            break;
        }

        // 如果是最后一个节点，选中并展开，同时显示详情
        if (i === nodeIdPath.length - 1) {
            await treeView.reveal(childNode, { select: true, focus: true, expand: true });

            // 显示节点详情
            await vscode.commands.executeCommand('opcua.showNodeDetails', childNode);
        } else {
            // 否则只展开
            await treeView.reveal(childNode, { select: false, focus: false, expand: true });
        }

        currentNode = childNode;
        currentNodeId = targetNodeId;
    }
}
