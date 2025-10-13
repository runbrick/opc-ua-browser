import * as vscode from 'vscode';
import { ConnectionManager } from '../opcua/connectionManager';
import { DataViewEntry, DataViewManager } from '../providers/dataViewManager';
import { OpcuaNode } from '../providers/opcuaTreeDataProvider';

export async function addNodeToDataViewCommand(
    connectionManager: ConnectionManager,
    dataViewManager: DataViewManager,
    node?: OpcuaNode
): Promise<DataViewEntry | undefined> {
    if (!(node instanceof OpcuaNode)) {
        vscode.window.showWarningMessage('Please select a node to add to Data View.');
        return undefined;
    }

    try {
        const alreadyTracked = dataViewManager.hasNode(node.connectionId, node.nodeId);
        const entry = await dataViewManager.addNode(node.connectionId, node.nodeId);

        if (!alreadyTracked) {
            const name = entry.displayName || entry.nodeId;
            vscode.window.showInformationMessage(`Added "${name}" to Data View.`);
        } else {
            vscode.window.showInformationMessage('Node is already monitored in Data View.');
        }

        return entry;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to add node to Data View: ${message}`);
        return undefined;
    }
}

export async function removeNodeFromDataViewCommand(
    dataViewManager: DataViewManager,
    entryId: string
): Promise<void> {
    await dataViewManager.removeNode(entryId);
}

export async function clearDataViewCommand(
    dataViewManager: DataViewManager
): Promise<void> {
    await dataViewManager.clear();
}
