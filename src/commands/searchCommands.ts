import * as vscode from 'vscode';
import { ConnectionManager } from '../opcua/connectionManager';
import { OpcuaClient } from '../opcua/opcuaClient';
import { OpcuaTreeDataProvider, OpcuaNode, ConnectionNode, TreeNode } from '../providers/opcuaTreeDataProvider';
import { isNodeIdPattern, normalizeNodeIdInput } from '../utils/nodeIdUtils';
import { SearchResultItem } from '../types';
import {
    SearchPanel,
    SearchPanelConfig,
    SearchHandler,
    SearchHandlerResult,
    SearchRequest,
    SearchProgressUpdate,
    SearchMessage,
    SearchScope
} from '../webview/SearchPanel';

type SearchResult = SearchResultItem;

export async function searchNodeCommand(
    connectionManager: ConnectionManager,
    treeDataProvider: OpcuaTreeDataProvider,
    treeView: vscode.TreeView<any>,
    extensionUri: vscode.Uri
): Promise<void> {
    const connectedConnections = getConnectedConnections(connectionManager);
    if (connectedConnections.length === 0) {
        vscode.window.showWarningMessage('Please connect to at least one OPC UA server first');
        return;
    }

    const revealResult = createRevealCallback(treeView, treeDataProvider, connectionManager);
    const handler = createSearchHandler(connectionManager);
    const panelConfig = buildSearchPanelConfig(connectionManager, connectedConnections, {
        allowAllOption: true,
        defaultScope: 'all'
    });

    SearchPanel.show(
        extensionUri,
        panelConfig,
        handler,
        revealResult
    );
}

export async function searchNodeInConnectionCommand(
    connectionManager: ConnectionManager,
    treeDataProvider: OpcuaTreeDataProvider,
    treeView: vscode.TreeView<any>,
    node: ConnectionNode,
    extensionUri: vscode.Uri
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

    const revealResult = createRevealCallback(treeView, treeDataProvider, connectionManager);
    const handler = createSearchHandler(connectionManager, { forcedConnectionId: node.connectionId });
    const panelConfig = buildSearchPanelConfig(connectionManager, [[node.connectionId, client]], {
        allowAllOption: false,
        defaultScope: 'connection',
        defaultConnectionId: node.connectionId
    });

    SearchPanel.show(extensionUri, panelConfig, handler, revealResult);
}

function createRevealCallback(
    treeView: vscode.TreeView<any>,
    treeDataProvider: OpcuaTreeDataProvider,
    connectionManager: ConnectionManager
): (result: SearchResultItem, options?: { allowErrorMessage?: boolean }) => Promise<void> {
    return async (result, options) =>
        openSearchResult(result, treeView, treeDataProvider, connectionManager, options);
}

function createSearchHandler(
    connectionManager: ConnectionManager,
    options?: { forcedConnectionId?: string }
): SearchHandler {
    return async (
        request: SearchRequest,
        token: vscode.CancellationToken,
        reportProgress: (update: SearchProgressUpdate) => void
    ): Promise<SearchHandlerResult> => {
        const connectedConnections = getConnectedConnections(connectionManager);

        if (connectedConnections.length === 0) {
            return {
                results: [],
                searchedNodes: 0,
                messages: [{ type: 'warning', text: 'No connected OPC UA servers available.' }]
            };
        }

        let connectionsToSearch: Array<[string, OpcuaClient]> = [];

        if (options?.forcedConnectionId) {
            const forced = connectedConnections.find(([id]) => id === options.forcedConnectionId);
            if (!forced) {
                return {
                    results: [],
                    searchedNodes: 0,
                    messages: [{ type: 'warning', text: 'Selected server is not connected.' }]
                };
            }
            connectionsToSearch = [forced];
        } else if (request.scope === 'connection' && request.connectionId) {
            const selected = connectedConnections.find(([id]) => id === request.connectionId);
            if (!selected) {
                return {
                    results: [],
                    searchedNodes: 0,
                    messages: [{ type: 'warning', text: 'Selected server is not connected.' }]
                };
            }
            connectionsToSearch = [selected];
        } else {
            connectionsToSearch = connectedConnections;
        }

        return performSearchRequest(
            request.searchTerm,
            connectionsToSearch,
            connectionManager,
            token,
            reportProgress
        );
    };
}

function getConnectedConnections(connectionManager: ConnectionManager): Array<[string, OpcuaClient]> {
    return Array.from(connectionManager.getAllConnections().entries()).filter(
        ([, client]) => client.isConnected
    );
}

async function performSearchRequest(
    searchTerm: string,
    connectionsToSearch: Array<[string, OpcuaClient]>,
    connectionManager: ConnectionManager,
    token: vscode.CancellationToken,
    reportProgress: (update: SearchProgressUpdate) => void
): Promise<SearchHandlerResult> {
    const trimmed = searchTerm.trim();

    if (!trimmed) {
        return {
            results: [],
            searchedNodes: 0,
            messages: [{ type: 'error', text: 'Search term cannot be empty.' }]
        };
    }

    if (connectionsToSearch.length === 0) {
        return {
            results: [],
            searchedNodes: 0,
            messages: [{ type: 'warning', text: 'No connected OPC UA servers available.' }]
        };
    }

    if (isNodeIdPattern(trimmed)) {
        return performNodeIdSearch(trimmed, connectionsToSearch, connectionManager, token, reportProgress);
    }

    return performNameSearch(trimmed, connectionsToSearch, connectionManager, token, reportProgress);
}

async function performNameSearch(
    searchTerm: string,
    connectionsToSearch: Array<[string, OpcuaClient]>,
    connectionManager: ConnectionManager,
    token: vscode.CancellationToken,
    reportProgress: (update: SearchProgressUpdate) => void
): Promise<SearchHandlerResult> {
    const results: SearchResult[] = [];
    const messages: SearchMessage[] = [];
    let searchedNodes = 0;

    for (const [connectionId, client] of connectionsToSearch) {
        if (token.isCancellationRequested) {
            messages.push({ type: 'info', text: 'Search cancelled.' });
            break;
        }

        const connectionName = getConnectionName(connectionManager, connectionId);
        let previousCount = 0;

        reportProgress({
            connectionId,
            connectionName,
            current: 0,
            total: 0,
            message: `Searching in ${connectionName}...`
        });

        try {
            const searchResults = await client.searchNodes(
                searchTerm,
                (current: number, total: number) => {
                    const increment = Math.max(0, current - previousCount);
                    if (increment > 0) {
                        searchedNodes += increment;
                        previousCount = current;
                    }

                    reportProgress({
                        connectionId,
                        connectionName,
                        current,
                        total
                    });
                },
                token
            );

            results.push(
                ...searchResults.map(
                    (result): SearchResult => ({
                        ...result,
                        connectionId,
                        connectionName
                    })
                )
            );
        } catch (error) {
            console.error(`Error searching in connection ${connectionId}:`, error);
            messages.push({
                type: 'error',
                text: `Error searching in ${connectionName}: ${
                    error instanceof Error ? error.message : 'Unknown error'
                }`
            });
        }
    }

    if (!token.isCancellationRequested && results.length === 0) {
        messages.push({
            type: 'info',
            text: `No nodes found matching "${searchTerm}".`
        });
    }

    return {
        results,
        searchedNodes,
        messages
    };
}

async function performNodeIdSearch(
    nodeIdInput: string,
    connectionsToSearch: Array<[string, OpcuaClient]>,
    connectionManager: ConnectionManager,
    token: vscode.CancellationToken,
    reportProgress: (update: SearchProgressUpdate) => void
): Promise<SearchHandlerResult> {
    const normalizedNodeId = normalizeNodeIdInput(nodeIdInput);
    const results: SearchResult[] = [];
    const messages: SearchMessage[] = [];

    for (const [connectionId, client] of connectionsToSearch) {
        if (token.isCancellationRequested) {
            break;
        }

        const connectionName = getConnectionName(connectionManager, connectionId);

        reportProgress({
            connectionId,
            connectionName,
            current: 0,
            total: 0,
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
            if (error instanceof Error && error.message.includes('BadNodeIdUnknown')) {
                continue;
            }
            console.warn(`Node ${normalizedNodeId} not found in ${connectionName}:`, error);
        }
    }

    if (token.isCancellationRequested) {
        messages.push({ type: 'info', text: 'Node search cancelled.' });
    }

    if (results.length === 0) {
        messages.push({
            type: 'info',
            text: `Node ${normalizedNodeId} was not found in the selected servers.`
        });
    }

    return {
        results,
        searchedNodes: connectionsToSearch.length,
        messages,
        autoRevealIndex: results.length === 1 ? 0 : undefined
    };
}

function buildSearchPanelConfig(
    connectionManager: ConnectionManager,
    connections: Array<[string, OpcuaClient]>,
    options: {
        allowAllOption: boolean;
        defaultScope: SearchScope;
        defaultConnectionId?: string;
        defaultSearchTerm?: string;
    }
): SearchPanelConfig {
    return {
        connections: connections.map(([id]) => {
            const config = connectionManager.getConnectionConfig(id);
            return {
                id,
                name: config?.name || config?.endpointUrl || id,
                endpointUrl: config?.endpointUrl
            };
        }),
        allowAllOption: options.allowAllOption,
        defaultScope: options.defaultScope,
        defaultConnectionId: options.defaultConnectionId,
        defaultSearchTerm: options.defaultSearchTerm
    };
}

function getConnectionName(connectionManager: ConnectionManager, connectionId: string): string {
    const config = connectionManager.getConnectionConfig(connectionId);
    return config?.name || config?.endpointUrl || connectionId;
}

async function openSearchResult(
    result: SearchResult,
    treeView: vscode.TreeView<any>,
    treeDataProvider: OpcuaTreeDataProvider,
    connectionManager: ConnectionManager,
    options?: { allowErrorMessage?: boolean }
): Promise<void> {
    const allowErrorMessage = options?.allowErrorMessage ?? true;
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
