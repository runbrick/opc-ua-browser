import * as vscode from 'vscode';
import { ConnectionManager } from '../opcua/connectionManager';
import { OpcuaClient } from '../opcua/opcuaClient';
import { OpcuaTreeDataProvider, OpcuaNode, ConnectionNode, TreeNode } from '../providers/opcuaTreeDataProvider';
import { isNodeIdPattern, normalizeNodeIdInput } from '../utils/nodeIdUtils';

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
    const connections = connectionManager.getAllConnections();
    if (connections.size === 0) {
        vscode.window.showWarningMessage('No OPC UA connections available');
        return;
    }

    const connectedConnections = Array.from(connections.entries()).filter(
        ([, client]) => client.isConnected
    );

    if (connectedConnections.length === 0) {
        vscode.window.showWarningMessage('Please connect to at least one OPC UA server first');
        return;
    }

    const searchTerm = await promptSearchTerm();
    if (!searchTerm) {
        return;
    }

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

    let connectionsToSearch: Array<[string, OpcuaClient]> = [];

    if (searchScope.value === 'all') {
        connectionsToSearch = connectedConnections;
    } else {
        const connectionItems = connectedConnections.map(([id]) => {
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

    await executeSearch(
        searchTerm,
        connectionsToSearch,
        connectionManager,
        treeDataProvider,
        treeView
    );
}

export async function searchNodeInConnectionCommand(
    connectionManager: ConnectionManager,
    treeDataProvider: OpcuaTreeDataProvider,
    treeView: vscode.TreeView<any>,
    node: ConnectionNode
): Promise<void> {
    if (!(node instanceof ConnectionNode)) {
        return;
    }

    const client = connectionManager.getConnection(node.connectionId);
    if (!client) {
        vscode.window.showErrorMessage('Connection not found');
        return;
    }

    if (!client.isConnected) {
        vscode.window.showWarningMessage('Please connect to the OPC UA server before searching');
        return;
    }

    const searchTerm = await promptSearchTerm();
    if (!searchTerm) {
        return;
    }

    await executeSearch(
        searchTerm,
        [[node.connectionId, client]],
        connectionManager,
        treeDataProvider,
        treeView
    );
}

async function promptSearchTerm(): Promise<string | undefined> {
    const searchTerm = await vscode.window.showInputBox({
        prompt: 'Enter search term (node name or NodeId)',
        placeHolder: 'e.g., Temperature, Pressure, ns=2;s=MyTag',
        validateInput: (value) => {
            if (!value || value.trim().length === 0) {
                return 'Search term cannot be empty';
            }
            return null;
        }
    });

    if (!searchTerm) {
        return undefined;
    }

    return searchTerm.trim();
}

async function executeSearch(
    searchTerm: string,
    connectionsToSearch: Array<[string, OpcuaClient]>,
    connectionManager: ConnectionManager,
    treeDataProvider: OpcuaTreeDataProvider,
    treeView: vscode.TreeView<any>
): Promise<void> {
    if (connectionsToSearch.length === 0) {
        vscode.window.showWarningMessage('No connected OPC UA servers available for search');
        return;
    }

    const trimmedSearchTerm = searchTerm.trim();
    if (isNodeIdPattern(trimmedSearchTerm)) {
        const handled = await handleDirectNodeIdSearch(
            trimmedSearchTerm,
            connectionsToSearch,
            connectionManager,
            treeDataProvider,
            treeView
        );
        if (handled) {
            return;
        }
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Searching for "${searchTerm}"`,
            cancellable: true
        },
        async (progress, token) => {
            const results: SearchResult[] = [];
            let searchedNodes = 0;

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
                            if (increment > 0) {
                                searchedNodes += increment;
                            }
                            previousCount = current;

                            const totalLabel = total > 0 ? ` (${current}/${total} nodes)` : '';
                            progress.report({
                                message: `Searching in ${connectionName}...${totalLabel}`
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

            if (results.length === 0) {
                vscode.window.showInformationMessage(
                    `No nodes found matching "${searchTerm}" (searched ${searchedNodes} nodes)`
                );
                return;
            }

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

                    await openSearchResult(
                        result,
                        treeView,
                        treeDataProvider,
                        connectionManager,
                        true
                    );

                    quickPick.hide();
                }
            });

            quickPick.onDidHide(() => quickPick.dispose());
            quickPick.show();
        }
    );
}

async function handleDirectNodeIdSearch(
    nodeIdInput: string,
    connectionsToSearch: Array<[string, OpcuaClient]>,
    connectionManager: ConnectionManager,
    treeDataProvider: OpcuaTreeDataProvider,
    treeView: vscode.TreeView<any>
): Promise<boolean> {
    if (connectionsToSearch.length === 0) {
        return true;
    }

    const normalizedNodeId = normalizeNodeIdInput(nodeIdInput);
    const results: SearchResult[] = [];
    let wasCancelled = false;

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Locating node ${normalizedNodeId}`,
            cancellable: true
        },
        async (progress, token) => {
            for (const [connectionId, client] of connectionsToSearch) {
                if (token.isCancellationRequested) {
                    wasCancelled = true;
                    break;
                }

                const config = connectionManager.getConnectionConfig(connectionId);
                const connectionName = config?.name || config?.endpointUrl || connectionId;

                progress.report({
                    message: `Checking ${connectionName}...`
                });

                try {
                    const located = await client.findNodePathByNodeId(normalizedNodeId, {
                        maxDepth: 25,
                        cancellationToken: token
                    });

                    if (located) {
                        results.push({
                            nodeId: normalizedNodeId,
                            displayName: located.displayName || normalizedNodeId,
                            browseName: located.browseName || '',
                            nodeClass: located.nodeClass,
                            path: located.path,
                            nodeIdPath: located.nodeIdPath,
                            connectionId,
                            connectionName
                        });
                        continue;
                    }

                    const nodeInfo = await client.readNodeAttributes(normalizedNodeId);
                    const displayName = nodeInfo.displayName || nodeInfo.browseName || normalizedNodeId;

                    results.push({
                        nodeId: normalizedNodeId,
                        displayName,
                        browseName: nodeInfo.browseName || '',
                        nodeClass: nodeInfo.nodeClass,
                        path: displayName,
                        nodeIdPath: [],
                        connectionId,
                        connectionName
                    });
                } catch (error) {
                    console.warn(`Node ${normalizedNodeId} not found in ${connectionName}:`, error);
                }
            }
        }
    );

    if (wasCancelled) {
        vscode.window.showInformationMessage('Node search cancelled');
        return true;
    }

    if (results.length === 0) {
        vscode.window.showInformationMessage(`Node ${normalizedNodeId} was not found in the selected servers.`);
        return true;
    }

    if (results.length === 1) {
        await openSearchResult(
            results[0],
            treeView,
            treeDataProvider,
            connectionManager,
            false
        );
        return true;
    }

    const selection = await vscode.window.showQuickPick(
        results.map(result => ({
            label: result.connectionName,
            description: result.path,
            detail: result.displayName,
            result
        })),
        {
            placeHolder: `Select server containing ${normalizedNodeId}`
        }
    );

    if (selection && selection.result) {
        await openSearchResult(
            selection.result,
            treeView,
            treeDataProvider,
            connectionManager,
            false
        );
    }

    return true;
}

async function openSearchResult(
    result: SearchResult,
    treeView: vscode.TreeView<any>,
    treeDataProvider: OpcuaTreeDataProvider,
    connectionManager: ConnectionManager,
    allowErrorMessage: boolean
): Promise<void> {
    try {
        if (result.nodeIdPath.length > 0) {
            await revealNodeInTree(
                treeView,
                treeDataProvider,
                connectionManager,
                result.connectionId,
                result.nodeIdPath,
                result.displayName,
                result.nodeClass
            );
            return;
        }
    } catch (error) {
        console.error('Error revealing node in tree:', error);
        if (allowErrorMessage) {
            vscode.window.showErrorMessage(
                `Error revealing node: ${error instanceof Error ? error.message : 'Unknown error'}`
            );
        }
    }

    const fallbackNode = new OpcuaNode(
        result.connectionId,
        result.nodeId,
        result.displayName || result.browseName || result.nodeId,
        getNodeClassNumber(result.nodeClass),
        result.nodeClass === 'Object'
    );

    await vscode.commands.executeCommand('opcua.showNodeDetails', fallbackNode);
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
    const connections = await treeDataProvider.getChildren();
    const connectionNode = connections.find(
        node => node instanceof ConnectionNode && (node as ConnectionNode).connectionId === connectionId
    ) as ConnectionNode;

    if (!connectionNode) {
        throw new Error('Connection node not found');
    }

    await treeView.reveal(connectionNode, { select: false, focus: false, expand: true });

    let currentNode: TreeNode | undefined = connectionNode;

    for (let i = 0; i < nodeIdPath.length; i++) {
        const targetNodeId = nodeIdPath[i];
        const children = await treeDataProvider.getChildren(currentNode);

        const childNode = children.find(
            node => node instanceof OpcuaNode && (node as OpcuaNode).nodeId === targetNodeId
        ) as OpcuaNode | undefined;

        if (!childNode) {
            console.error(`Child node not found: ${targetNodeId}`);
            break;
        }

        if (i === nodeIdPath.length - 1) {
            await treeView.reveal(childNode, { select: true, focus: true, expand: true });
            await vscode.commands.executeCommand('opcua.showNodeDetails', childNode);
        } else {
            await treeView.reveal(childNode, { select: false, focus: false, expand: true });
        }

        currentNode = childNode;
    }
}
