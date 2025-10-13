import * as vscode from 'vscode';
import { ConnectionManager } from '../opcua/connectionManager';
import { OpcuaConnectionConfig } from '../types';
import { OPCUAClient, EndpointDescription } from 'node-opcua';

export async function addConnectionCommand(
    connectionManager: ConnectionManager,
    treeDataProvider: any
): Promise<void> {
    try {
        // Step 1: 输入服务器地址
        const endpointUrl = await vscode.window.showInputBox({
            prompt: 'Enter OPC UA Server Endpoint URL',
            placeHolder: 'opc.tcp://localhost:4840',
            validateInput: (value) => {
                if (!value || !value.startsWith('opc.tcp://')) {
                    return 'Please enter a valid OPC UA endpoint URL (e.g., opc.tcp://localhost:4840)';
                }
                return null;
            }
        });

        if (!endpointUrl) {
            return;
        }

        // Step 2: 输入连接名称
        const connectionName = await vscode.window.showInputBox({
            prompt: 'Enter a name for this connection',
            placeHolder: 'My OPC UA Server',
            value: endpointUrl
        });

        if (!connectionName) {
            return;
        }

        // Step 3: 获取并选择安全策略
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Discovering server endpoints...',
                cancellable: false
            },
            async () => {
                const endpoints = await getEndpoints(endpointUrl);

                if (endpoints.length === 0) {
                    vscode.window.showWarningMessage('No endpoints found. Using default settings.');
                    await createDefaultConnection(connectionManager, treeDataProvider, connectionName, endpointUrl);
                    return;
                }

                // 显示端点选择列表
                const endpointItems = endpoints.map(ep => ({
                    label: `${ep.securityMode} - ${ep.securityPolicy}`,
                    description: ep.endpointUrl,
                    endpoint: ep
                }));

                const selectedEndpoint = await vscode.window.showQuickPick(endpointItems, {
                    placeHolder: 'Select security mode and policy'
                });

                if (!selectedEndpoint) {
                    return;
                }

                // Step 4: 选择认证方式
                const authType = await vscode.window.showQuickPick(
                    [
                        { label: 'Anonymous', value: 'Anonymous' },
                        { label: 'Username/Password', value: 'UserPassword' }
                    ],
                    { placeHolder: 'Select authentication method' }
                );

                if (!authType) {
                    return;
                }

                let username: string | undefined;
                let password: string | undefined;

                // Step 5: 如果选择了用户名密码认证，输入凭证
                if (authType.value === 'UserPassword') {
                    username = await vscode.window.showInputBox({
                        prompt: 'Enter username',
                        placeHolder: 'username'
                    });

                    if (!username) {
                        return;
                    }

                    password = await vscode.window.showInputBox({
                        prompt: 'Enter password',
                        placeHolder: 'password',
                        password: true
                    });

                    if (!password) {
                        return;
                    }
                }

                // 创建连接配置
                const config: OpcuaConnectionConfig = {
                    id: '',
                    name: connectionName,
                    endpointUrl: endpointUrl,
                    securityMode: selectedEndpoint.endpoint.securityMode,
                    securityPolicy: selectedEndpoint.endpoint.securityPolicy,
                    authType: authType.value as 'Anonymous' | 'UserPassword',
                    username: username,
                    password: password
                };

                // 保存连接
                await connectionManager.addConnection(config);
                treeDataProvider.refresh();

                vscode.window.showInformationMessage(`Connection "${connectionName}" added successfully.`);
            }
        );
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to add connection: ${error}`);
    }
}

async function getEndpoints(endpointUrl: string): Promise<any[]> {
    try {
        const client = OPCUAClient.create({
            endpoint_must_exist: false,
            connectionStrategy: {
                maxRetry: 0,
                initialDelay: 1000
            }
        });

        await client.connect(endpointUrl);
        const endpoints = await client.getEndpoints();
        await client.disconnect();

        return endpoints.map((ep: EndpointDescription) => ({
            endpointUrl: ep.endpointUrl || '',
            securityMode: ep.securityMode.toString(),
            securityPolicy: ep.securityPolicyUri?.split('#')[1] || 'None'
        }));
    } catch (error) {
        console.error('Error getting endpoints:', error);
        return [];
    }
}

async function createDefaultConnection(
    connectionManager: ConnectionManager,
    treeDataProvider: any,
    name: string,
    endpointUrl: string
): Promise<void> {
    const config: OpcuaConnectionConfig = {
        id: '',
        name: name,
        endpointUrl: endpointUrl,
        securityMode: 'None',
        securityPolicy: 'None',
        authType: 'Anonymous'
    };

    await connectionManager.addConnection(config);
    treeDataProvider.refresh();

    vscode.window.showInformationMessage(`Connection "${name}" added with default settings.`);
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

    const endpointUrl = await vscode.window.showInputBox({
        prompt: 'Update OPC UA Server Endpoint URL',
        placeHolder: 'opc.tcp://localhost:4840',
        value: existingConfig.endpointUrl,
        validateInput: (value) => {
            if (!value || !value.startsWith('opc.tcp://')) {
                return 'Please enter a valid OPC UA endpoint URL (e.g., opc.tcp://localhost:4840)';
            }
            return null;
        }
    });

    if (!endpointUrl) {
        return;
    }

    const connectionName = await vscode.window.showInputBox({
        prompt: 'Update the connection name',
        placeHolder: 'My OPC UA Server',
        value: existingConfig.name
    });

    if (!connectionName) {
        return;
    }

    let cancelled = false;
    let updatedConfig: OpcuaConnectionConfig | null = null;

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Updating connection "${existingConfig.name}"...`,
            cancellable: false
        },
        async () => {
            const endpoints = await getEndpoints(endpointUrl);

            let selectedSecurityMode = existingConfig.securityMode;
            let selectedSecurityPolicy = existingConfig.securityPolicy;

            if (endpoints.length > 0) {
                const endpointItems = endpoints.map(ep => ({
                    label: `${ep.securityMode} - ${ep.securityPolicy}`,
                    description: ep.endpointUrl,
                    endpoint: ep
                }));

                if (!endpointItems.some(item =>
                    item.endpoint.securityMode === existingConfig.securityMode &&
                    item.endpoint.securityPolicy === existingConfig.securityPolicy
                )) {
                    endpointItems.unshift({
                        label: `Current: ${existingConfig.securityMode} - ${existingConfig.securityPolicy}`,
                        description: existingConfig.endpointUrl,
                        endpoint: {
                            endpointUrl: existingConfig.endpointUrl,
                            securityMode: existingConfig.securityMode,
                            securityPolicy: existingConfig.securityPolicy
                        }
                    });
                }

                const selectedEndpoint = await vscode.window.showQuickPick(endpointItems, {
                    placeHolder: 'Select security mode and policy'
                });

                if (!selectedEndpoint) {
                    cancelled = true;
                    return;
                }

                selectedSecurityMode = selectedEndpoint.endpoint.securityMode;
                selectedSecurityPolicy = selectedEndpoint.endpoint.securityPolicy;
            } else {
                vscode.window.showWarningMessage('No endpoints found. Keeping existing security settings.');
            }

            const authOptions = [
                { label: 'Anonymous', value: 'Anonymous' as const },
                { label: 'Username/Password', value: 'UserPassword' as const }
            ];

            const orderedAuthOptions = existingConfig.authType === 'UserPassword'
                ? [authOptions[1], authOptions[0]]
                : [authOptions[0], authOptions[1]];

            const authType = await vscode.window.showQuickPick(orderedAuthOptions, {
                placeHolder: 'Select authentication method'
            });

            if (!authType) {
                cancelled = true;
                return;
            }

            let username: string | undefined = authType.value === 'UserPassword' ? existingConfig.username : undefined;
            let password: string | undefined = authType.value === 'UserPassword' ? existingConfig.password : undefined;

            if (authType.value === 'UserPassword') {
                const usernameInput = await vscode.window.showInputBox({
                    prompt: 'Enter username',
                    placeHolder: 'username',
                    value: existingConfig.username
                });

                if (!usernameInput) {
                    cancelled = true;
                    return;
                }

                username = usernameInput;

                const passwordOptions = [
                    ...(existingConfig.password ? [{ label: 'Keep existing password', value: 'keep' as const }] : []),
                    { label: 'Enter new password', value: 'new' as const },
                    { label: 'Clear password', value: 'clear' as const }
                ];

                const passwordAction = await vscode.window.showQuickPick(passwordOptions, {
                    placeHolder: 'Select how to handle the password'
                });

                if (!passwordAction) {
                    cancelled = true;
                    return;
                }

                if (passwordAction.value === 'new') {
                    const newPassword = await vscode.window.showInputBox({
                        prompt: 'Enter new password',
                        placeHolder: 'password',
                        password: true
                    });

                    if (newPassword === undefined) {
                        cancelled = true;
                        return;
                    }

                    password = newPassword;
                } else if (passwordAction.value === 'clear') {
                    password = undefined;
                }
            } else {
                username = undefined;
                password = undefined;
            }

            updatedConfig = {
                ...existingConfig,
                id: existingConfig.id,
                name: connectionName,
                endpointUrl,
                securityMode: selectedSecurityMode,
                securityPolicy: selectedSecurityPolicy,
                authType: authType.value,
                username,
                password
            };
        }
    );

    if (cancelled || !updatedConfig) {
        return;
    }

    try {
        await connectionManager.updateConnection(node.connectionId, updatedConfig);
        treeDataProvider.refresh();
        vscode.window.showInformationMessage(`Connection "${connectionName}" updated successfully.`);
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to update connection: ${error}`);
    }
}

export function refreshConnectionsCommand(treeDataProvider: any): void {
    treeDataProvider.refresh();
    vscode.window.showInformationMessage('Connections refreshed.');
}
