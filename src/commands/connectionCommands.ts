import * as vscode from 'vscode';
import { ConnectionManager } from '../opcua/connectionManager';
import { OpcuaConnectionConfig } from '../types';
import { ConnectionEditorPanel } from '../webview/ConnectionEditorPanel';

export async function addConnectionCommand(
    extensionUri: vscode.Uri,
    connectionManager: ConnectionManager,
    treeDataProvider: any
): Promise<void> {
    try {
        const result = await ConnectionEditorPanel.open(extensionUri, { mode: 'create' });
        if (!result) {
            return;
        }

        const config: OpcuaConnectionConfig = {
            id: '',
            name: result.name,
            endpointUrl: result.endpointUrl,
            securityMode: result.securityMode,
            securityPolicy: result.securityPolicy,
            authType: result.authType,
            username: result.authType === 'UserPassword' ? result.username : undefined,
            password: result.authType === 'UserPassword' ? result.password : undefined
        };

        await connectionManager.addConnection(config);
        treeDataProvider.refresh();

        vscode.window.showInformationMessage(`Connection "${config.name}" added successfully.`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to add connection: ${message}`);
    }
}

export async function connectCommand(
    connectionManager: ConnectionManager,
    treeDataProvider: any,
    node: any
): Promise<void> {
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `Connecting to ${node.config.name}...`,
                cancellable: false
            },
            async () => {
                await connectionManager.connect(node.connectionId);
                treeDataProvider.refresh();
                vscode.window.showInformationMessage(`Connected to ${node.config.name}`);
            }
        );
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to connect: ${error}`);
        treeDataProvider.refresh();
    }
}

export async function disconnectCommand(
    connectionManager: ConnectionManager,
    treeDataProvider: any,
    node: any
): Promise<void> {
    try {
        await connectionManager.disconnect(node.connectionId);
        treeDataProvider.refresh();
        vscode.window.showInformationMessage(`Disconnected from ${node.config.name}`);
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to disconnect: ${error}`);
    }
}

export async function deleteConnectionCommand(
    connectionManager: ConnectionManager,
    treeDataProvider: any,
    node: any
): Promise<void> {
    const confirmation = await vscode.window.showWarningMessage(
        `Are you sure you want to delete the connection "${node.config.name}"?`,
        { modal: true },
        'Delete'
    );

    if (confirmation === 'Delete') {
        try {
            await connectionManager.removeConnection(node.connectionId);
            treeDataProvider.refresh();
            vscode.window.showInformationMessage(`Connection "${node.config.name}" deleted.`);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete connection: ${error}`);
        }
    }
}

export async function editConnectionCommand(
    extensionUri: vscode.Uri,
    connectionManager: ConnectionManager,
    treeDataProvider: any,
    node: any
): Promise<void> {
    if (!node?.connectionId) {
        vscode.window.showErrorMessage('Unable to edit connection: invalid selection.');
        return;
    }

    const existingConfig = connectionManager.getConnectionConfig(node.connectionId);
    if (!existingConfig) {
        vscode.window.showErrorMessage('Unable to edit connection: configuration not found.');
        return;
    }

    try {
        const result = await ConnectionEditorPanel.open(extensionUri, {
            mode: 'edit',
            initialConfig: existingConfig
        });

        if (!result) {
            return;
        }

        let username: string | undefined;
        let password: string | undefined;

        if (result.authType === 'UserPassword') {
            username = result.username ?? existingConfig.username;
            if (result.password) {
                password = result.password;
            } else if (result.clearPassword) {
                password = undefined;
            } else {
                password = existingConfig.password;
            }
        }

        const updatedConfig: OpcuaConnectionConfig = {
            ...existingConfig,
            id: existingConfig.id,
            name: result.name,
            endpointUrl: result.endpointUrl,
            securityMode: result.securityMode,
            securityPolicy: result.securityPolicy,
            authType: result.authType,
            username: result.authType === 'UserPassword' ? username : undefined,
            password: result.authType === 'UserPassword' ? password : undefined
        };

        await connectionManager.updateConnection(node.connectionId, updatedConfig);
        treeDataProvider.refresh();
        vscode.window.showInformationMessage(`Connection "${result.name}" updated successfully.`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to update connection: ${message}`);
    }
}

export function refreshConnectionsCommand(treeDataProvider: any): void {
    treeDataProvider.refresh();
    vscode.window.showInformationMessage('Connections refreshed.');
}
