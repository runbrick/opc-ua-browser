import * as vscode from 'vscode';
import { discoverEndpoints, DiscoveredEndpoint } from '../opcua/endpointDiscovery';
import { OpcuaConnectionConfig } from '../types';

export interface ConnectionEditorResult {
    name: string;
    endpointUrl: string;
    securityMode: string;
    securityPolicy: string;
    authType: 'Anonymous' | 'UserPassword' | 'Certificate';
    username?: string;
    password?: string;
    clearPassword?: boolean;
    clientCertificatePath?: string;
    clientPrivateKeyPath?: string;
}

export interface ConnectionEditorOptions {
    mode: 'create' | 'edit';
    initialConfig?: OpcuaConnectionConfig;
}

type WebviewMessage =
    | { command: 'ready' }
    | { command: 'discoverEndpoints'; endpointUrl?: unknown }
    | { command: 'submit'; values?: unknown }
    | { command: 'cancel' }
    | { command: 'selectCertificate' }
    | { command: 'selectPrivateKey' };

interface InitializePayload {
    mode: 'create' | 'edit';
    title: string;
    values: {
        name: string;
        endpointUrl: string;
        securityMode: string;
        securityPolicy: string;
        authType: 'Anonymous' | 'UserPassword' | 'Certificate';
        username?: string;
        clientCertificatePath?: string;
        clientPrivateKeyPath?: string;
    };
    hasStoredPassword: boolean;
}

export class ConnectionEditorPanel {
    public static async open(
        extensionUri: vscode.Uri,
        options: ConnectionEditorOptions
    ): Promise<ConnectionEditorResult | undefined> {
        return new Promise<ConnectionEditorResult | undefined>((resolve) => {
            new ConnectionEditorPanel(extensionUri, options, resolve);
        });
    }

    private readonly panel: vscode.WebviewPanel;
    private readonly disposables: vscode.Disposable[] = [];
    private readonly options: ConnectionEditorOptions;
    private readonly readyState: InitializePayload;
    private readonly resolve: (result: ConnectionEditorResult | undefined) => void;
    private completed = false;

    private constructor(
        extensionUri: vscode.Uri,
        options: ConnectionEditorOptions,
        resolve: (result: ConnectionEditorResult | undefined) => void
    ) {
        this.options = options;
        this.resolve = resolve;
        this.readyState = this.createInitialState(options);

        const title =
            options.mode === 'edit'
                ? 'Edit OPC UA Connection'
                : 'Add OPC UA Connection';

        this.panel = vscode.window.createWebviewPanel(
            'opcuaConnectionEditor',
            title,
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
            {
                enableScripts: true,
                retainContextWhenHidden: false,
                localResourceRoots: [extensionUri]
            }
        );

        this.panel.onDidDispose(() => this.handleDispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            (message: WebviewMessage) => {
                void this.handleMessage(message);
            },
            undefined,
            this.disposables
        );

        this.panel.webview.html = this.getHtmlContent(this.panel.webview);
    }

    private createInitialState(options: ConnectionEditorOptions): InitializePayload {
        const config = options.initialConfig;
        const defaultEndpoint = 'opc.tcp://';
        const mode = options.mode;

        return {
            mode,
            title: mode === 'edit' ? 'Edit Connection' : 'Create Connection',
            values: {
                name: config?.name ?? '',
                endpointUrl: config?.endpointUrl ?? defaultEndpoint,
                securityMode: config?.securityMode ?? 'None',
                securityPolicy: config?.securityPolicy ?? 'None',
                authType: config?.authType ?? 'Anonymous',
                username: config?.username ?? '',
                clientCertificatePath: config?.clientCertificatePath ?? '',
                clientPrivateKeyPath: config?.clientPrivateKeyPath ?? ''
            },
            hasStoredPassword: Boolean(config?.password)
        };
    }

    private async handleMessage(message: WebviewMessage): Promise<void> {
        switch (message.command) {
            case 'ready':
                this.postMessage('initialize', this.readyState);
                break;
            case 'discoverEndpoints':
                await this.handleDiscoverEndpoints(message.endpointUrl);
                break;
            case 'selectCertificate':
                await this.handleSelectCertificate();
                break;
            case 'selectPrivateKey':
                await this.handleSelectPrivateKey();
                break;
            case 'submit':
                this.handleSubmit(message.values);
                break;
            case 'cancel':
                this.complete(undefined);
                this.panel.dispose();
                break;
        }
    }

    private async handleDiscoverEndpoints(rawUrl: unknown): Promise<void> {
        const endpointUrl = typeof rawUrl === 'string' ? rawUrl.trim() : '';
        if (!endpointUrl) {
            this.postMessage('discoverError', {
                error: 'Endpoint URL is required to discover endpoints.'
            });
            return;
        }

        try {
            this.postMessage('discovering');
            const endpoints: DiscoveredEndpoint[] = await discoverEndpoints(endpointUrl);
            this.postMessage('endpointsDiscovered', {
                endpoints
            });
        } catch (error) {
            const message =
                error instanceof Error ? error.message : 'Failed to discover endpoints.';
            this.postMessage('discoverError', { error: message });
        }
    }

    private async handleSelectCertificate(): Promise<void> {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'Certificate Files': ['pem', 'crt', 'cer', 'der'],
                'All Files': ['*']
            },
            title: 'Select Client Certificate'
        });

        if (result && result[0]) {
            this.postMessage('certificateSelected', {
                path: result[0].fsPath
            });
        }
    }

    private async handleSelectPrivateKey(): Promise<void> {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            filters: {
                'Private Key Files': ['pem', 'key'],
                'All Files': ['*']
            },
            title: 'Select Client Private Key'
        });

        if (result && result[0]) {
            this.postMessage('privateKeySelected', {
                path: result[0].fsPath
            });
        }
    }

    private handleSubmit(values: unknown): void {
        if (!values || typeof values !== 'object') {
            this.postMessage('submitError', { error: 'Invalid form data received.' });
            return;
        }

        const payload = values as Record<string, unknown>;

        const name = typeof payload.name === 'string' ? payload.name.trim() : '';
        const endpointUrl =
            typeof payload.endpointUrl === 'string' ? payload.endpointUrl.trim() : '';
        const securityMode =
            typeof payload.securityMode === 'string' ? payload.securityMode : '';
        const securityPolicy =
            typeof payload.securityPolicy === 'string' ? payload.securityPolicy : '';
        const authType = payload.authType === 'Certificate' ? 'Certificate'
            : payload.authType === 'UserPassword' ? 'UserPassword'
            : 'Anonymous';
        const username =
            typeof payload.username === 'string' && payload.username.trim().length > 0
                ? payload.username.trim()
                : undefined;
        const password =
            typeof payload.password === 'string' && payload.password.length > 0
                ? payload.password
                : undefined;
        const clearPassword = payload.clearPassword === true;
        const clientCertificatePath =
            typeof payload.clientCertificatePath === 'string' && payload.clientCertificatePath.trim().length > 0
                ? payload.clientCertificatePath.trim()
                : undefined;
        const clientPrivateKeyPath =
            typeof payload.clientPrivateKeyPath === 'string' && payload.clientPrivateKeyPath.trim().length > 0
                ? payload.clientPrivateKeyPath.trim()
                : undefined;

        if (!name) {
            this.postMessage('submitError', { error: 'Connection name is required.' });
            return;
        }

        if (!endpointUrl || !endpointUrl.startsWith('opc.tcp://')) {
            this.postMessage('submitError', {
                error: 'Endpoint URL must start with opc.tcp://'
            });
            return;
        }

        if (!securityMode || !securityPolicy) {
            this.postMessage('submitError', {
                error: 'Please select a security mode and policy.'
            });
            return;
        }

        if (authType === 'UserPassword' && !username) {
            this.postMessage('submitError', {
                error: 'Username is required for Username/Password authentication.'
            });
            return;
        }

        if (this.options.mode === 'create' && authType === 'UserPassword' && !password) {
            this.postMessage('submitError', {
                error: 'Password is required when creating a Username/Password connection.'
            });
            return;
        }

        if (authType === 'Certificate' && (!clientCertificatePath || !clientPrivateKeyPath)) {
            this.postMessage('submitError', {
                error: 'Both certificate and private key files are required for Certificate authentication.'
            });
            return;
        }

        const result: ConnectionEditorResult = {
            name,
            endpointUrl,
            securityMode,
            securityPolicy,
            authType,
            username,
            password,
            clearPassword: authType === 'UserPassword' ? clearPassword : undefined,
            clientCertificatePath,
            clientPrivateKeyPath
        };

        this.complete(result);
        this.panel.dispose();
    }

    private handleDispose(): void {
        this.complete(undefined);
    }

    private complete(result: ConnectionEditorResult | undefined): void {
        if (this.completed) {
            return;
        }

        this.completed = true;
        this.resolve(result);

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }

    private postMessage(command: string, data?: unknown): void {
        void this.panel.webview.postMessage({ command, data });
    }

    private getHtmlContent(webview: vscode.Webview): string {
        const nonce = this.getNonce();
        const cspSource = webview.cspSource;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; img-src ${cspSource} https:; script-src 'nonce-${nonce}'; style-src ${cspSource} 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OPC UA Connection</title>
    <style nonce="${nonce}">
        :root {
            color-scheme: light dark;
        }

        body {
            margin: 0;
            padding: 0;
            font-family: var(--vscode-font-family, sans-serif);
            font-size: var(--vscode-font-size, 13px);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
        }

        .container {
            max-width: 640px;
            margin: 0 auto;
            padding: 24px;
        }

        h1 {
            font-size: 1.4rem;
            margin-bottom: 1.2rem;
        }

        form {
            display: grid;
            grid-template-columns: 1fr;
            gap: 16px;
        }

        label {
            font-weight: 600;
            display: block;
            margin-bottom: 6px;
        }

        input[type="text"],
        input[type="password"],
        select {
            width: 100%;
            font-size: inherit;
            padding: 6px 8px;
            border-radius: 4px;
            border: 1px solid var(--vscode-input-border, transparent);
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
        }

        input[type="text"]:focus,
        input[type="password"]:focus,
        select:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }

        .endpoint-row {
            display: flex;
            gap: 8px;
        }

        .endpoint-row input {
            flex: 1 1 auto;
        }

        button {
            font-size: inherit;
            padding: 6px 14px;
            border-radius: 4px;
            border: none;
            cursor: pointer;
        }

        button.primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }

        button.primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        button.secondary {
            background-color: transparent;
            border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
            color: var(--vscode-button-foreground, inherit);
        }

        button:disabled {
            opacity: 0.6;
            cursor: default;
        }

        .actions {
            display: flex;
            gap: 12px;
            justify-content: flex-end;
            margin-top: 12px;
        }

        .hint {
            color: var(--vscode-descriptionForeground);
            font-size: 0.92rem;
            margin-top: 4px;
        }

        .message {
            padding: 8px 12px;
            border-radius: 4px;
            border: 1px solid transparent;
            display: none;
        }

        .message.error {
            display: block;
            border-color: var(--vscode-inputValidation-errorBorder, #ff4d4f);
            background: var(--vscode-inputValidation-errorBackground, rgba(255, 77, 79, 0.15));
            color: var(--vscode-inputValidation-errorForeground, #ff4d4f);
        }

        .message.info {
            display: block;
            border-color: var(--vscode-inputValidation-infoBorder, #3794ff);
            background: var(--vscode-inputValidation-infoBackground, rgba(55, 148, 255, 0.15));
        }

        .message.success {
            display: block;
            border-color: var(--vscode-inputValidation-successBorder, #37b24d);
            background: var(--vscode-inputValidation-successBackground, rgba(55, 178, 77, 0.15));
        }

        .credentials {
            padding: 12px;
            border-radius: 4px;
            border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
            background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
        }

        .checkbox {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-top: 8px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1 id="page-title">Configure Connection</h1>
        <form id="connectionForm">
            <div>
                <label for="connectionName">Connection Name</label>
                <input id="connectionName" type="text" maxlength="200" autocomplete="off" required />
                <div class="hint">Pick a friendly name to display in the server list.</div>
            </div>

            <div>
                <label for="endpointUrl">Endpoint URL</label>
                <div class="endpoint-row">
                    <input id="endpointUrl" type="text" maxlength="512" placeholder="opc.tcp://localhost:4840" required />
                    <button type="button" id="discoverButton" class="secondary">Discover</button>
                </div>
                <div class="hint">Example: opc.tcp://hostname:port</div>
            </div>

            <div>
                <label for="securitySelect">Security Mode & Policy</label>
                <select id="securitySelect"></select>
                <div class="hint">Use Discover to load server supported options.</div>
            </div>

            <div>
                <label for="authType">Authentication</label>
                <select id="authType">
                    <option value="Anonymous">Anonymous (no credentials)</option>
                    <option value="UserPassword">Username / Password</option>
                    <option value="Certificate">X.509 Certificate</option>
                </select>
            </div>

            <div id="credentialsSection" class="credentials" style="display:none;">
                <div>
                    <label for="username">Username</label>
                    <input id="username" type="text" maxlength="200" autocomplete="off" />
                </div>
                <div>
                    <label for="password">Password</label>
                    <input id="password" type="password" maxlength="200" autocomplete="new-password" />
                    <div id="passwordHint" class="hint"></div>
                </div>
                <label id="clearPasswordRow" class="checkbox" style="display:none;">
                    <input id="clearPassword" type="checkbox" />
                    <span>Clear stored password</span>
                </label>
            </div>

            <div id="certificateSection" class="credentials" style="display:none;">
                <div>
                    <label for="clientCertificatePath">Client Certificate</label>
                    <div class="endpoint-row">
                        <input id="clientCertificatePath" type="text" maxlength="512" placeholder="Path to client certificate (.pem, .crt, .cer)" readonly />
                        <button type="button" id="selectCertificateButton" class="secondary">Browse</button>
                    </div>
                    <div class="hint">Select the client certificate file (.pem, .crt, .cer, .der)</div>
                </div>
                <div>
                    <label for="clientPrivateKeyPath">Client Private Key</label>
                    <div class="endpoint-row">
                        <input id="clientPrivateKeyPath" type="text" maxlength="512" placeholder="Path to private key (.pem, .key)" readonly />
                        <button type="button" id="selectPrivateKeyButton" class="secondary">Browse</button>
                    </div>
                    <div class="hint">Select the private key file (.pem, .key)</div>
                </div>
            </div>

            <div id="message" class="message"></div>

            <div class="actions">
                <button type="submit" id="saveButton" class="primary">Save Connection</button>
                <button type="button" id="cancelButton" class="secondary">Cancel</button>
            </div>
        </form>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();

        const elements = {
            form: document.getElementById('connectionForm'),
            title: document.getElementById('page-title'),
            name: document.getElementById('connectionName'),
            endpoint: document.getElementById('endpointUrl'),
            discover: document.getElementById('discoverButton'),
            security: document.getElementById('securitySelect'),
            authType: document.getElementById('authType'),
            credentialsSection: document.getElementById('credentialsSection'),
            username: document.getElementById('username'),
            password: document.getElementById('password'),
            passwordHint: document.getElementById('passwordHint'),
            clearPasswordRow: document.getElementById('clearPasswordRow'),
            clearPassword: document.getElementById('clearPassword'),
            certificateSection: document.getElementById('certificateSection'),
            clientCertificatePath: document.getElementById('clientCertificatePath'),
            clientPrivateKeyPath: document.getElementById('clientPrivateKeyPath'),
            selectCertificateButton: document.getElementById('selectCertificateButton'),
            selectPrivateKeyButton: document.getElementById('selectPrivateKeyButton'),
            message: document.getElementById('message'),
            saveButton: document.getElementById('saveButton'),
            cancelButton: document.getElementById('cancelButton')
        };

        let state = {
            mode: 'create',
            hasStoredPassword: false
        };

        function sendMessage(command, values) {
            vscode.postMessage({ command, ...values });
        }

        function setMessage(type, text) {
            if (!text) {
                elements.message.style.display = 'none';
                elements.message.textContent = '';
                elements.message.className = 'message';
                return;
            }

            elements.message.textContent = text;
            elements.message.className = 'message ' + type;
            elements.message.style.display = 'block';
        }

        function setSecurityOptions(options, selected) {
            const unique = new Map();
            options.forEach(opt => {
                if (opt && opt.securityMode && opt.securityPolicy) {
                    const key = opt.securityMode + '|' + opt.securityPolicy;
                    if (!unique.has(key)) {
                        unique.set(key, opt);
                    }
                }
            });

            if (unique.size === 0) {
                unique.set('None|None', { securityMode: 'None', securityPolicy: 'None' });
            }

            elements.security.innerHTML = '';

            for (const [key, opt] of unique.entries()) {
                const option = document.createElement('option');
                option.value = key;
                option.textContent = opt.securityMode + '   •   ' + opt.securityPolicy;
                elements.security.appendChild(option);
            }

            const availableKeys = Array.from(unique.keys());
            const preferred = selected && unique.has(selected) ? selected : availableKeys[0];
            elements.security.value = preferred;
        }

        function toggleCredentialsSection(authType) {
            const showUserPassword = authType === 'UserPassword';
            const showCertificate = authType === 'Certificate';

            elements.credentialsSection.style.display = showUserPassword ? 'grid' : 'none';
            elements.certificateSection.style.display = showCertificate ? 'grid' : 'none';

            if (showUserPassword) {
                if (state.mode === 'create') {
                    elements.passwordHint.textContent = 'Provide credentials required by the server.';
                    elements.clearPasswordRow.style.display = 'none';
                } else {
                    elements.passwordHint.textContent =
                        state.hasStoredPassword
                            ? 'Leave blank to keep the stored password.'
                            : 'Provide credentials required by the server.';
                    elements.clearPasswordRow.style.display = state.hasStoredPassword ? 'flex' : 'none';
                }
            } else {
                elements.username.value = '';
                elements.password.value = '';
                elements.clearPassword.checked = false;
            }

            if (!showCertificate) {
                elements.clientCertificatePath.value = '';
                elements.clientPrivateKeyPath.value = '';
            }
        }

        function setLoading(isLoading) {
            elements.discover.disabled = isLoading;
            elements.saveButton.disabled = isLoading;
            elements.cancelButton.disabled = isLoading;
            elements.form.style.opacity = isLoading ? '0.7' : '1';
        }

        elements.endpoint.addEventListener('blur', () => {
            if (!elements.name.value) {
                elements.name.value = elements.endpoint.value;
            }
        });

        elements.authType.addEventListener('change', (event) => {
            const auth = event.target.value === 'Certificate' ? 'Certificate'
                : event.target.value === 'UserPassword' ? 'UserPassword'
                : 'Anonymous';
            toggleCredentialsSection(auth);
        });

        elements.selectCertificateButton.addEventListener('click', () => {
            sendMessage('selectCertificate');
        });

        elements.selectPrivateKeyButton.addEventListener('click', () => {
            sendMessage('selectPrivateKey');
        });

        elements.discover.addEventListener('click', () => {
            const endpointUrl = elements.endpoint.value.trim();
            if (!endpointUrl) {
                setMessage('error', 'Enter an endpoint URL before discovering.');
                return;
            }
            setMessage('info', 'Discovering endpoints...');
            setLoading(true);
            sendMessage('discoverEndpoints', { endpointUrl });
        });

        elements.cancelButton.addEventListener('click', () => {
            sendMessage('cancel');
        });

        elements.form.addEventListener('submit', (event) => {
            event.preventDefault();
            setMessage('', '');

            const [securityMode, securityPolicy] = elements.security.value.split('|');

            const payload = {
                name: elements.name.value.trim(),
                endpointUrl: elements.endpoint.value.trim(),
                securityMode: securityMode || 'None',
                securityPolicy: securityPolicy || 'None',
                authType: elements.authType.value === 'Certificate' ? 'Certificate'
                    : elements.authType.value === 'UserPassword' ? 'UserPassword'
                    : 'Anonymous',
                username: elements.username.value.trim(),
                password: elements.password.value,
                clearPassword: elements.clearPassword.checked,
                clientCertificatePath: elements.clientCertificatePath.value.trim(),
                clientPrivateKeyPath: elements.clientPrivateKeyPath.value.trim()
            };

            setLoading(true);
            sendMessage('submit', { values: payload });
        });

        window.addEventListener('message', (event) => {
            const { command, data } = event.data || {};
            switch (command) {
                case 'initialize': {
                    state.mode = data.mode;
                    state.hasStoredPassword = Boolean(data.hasStoredPassword);
                    elements.title.textContent =
                        data.mode === 'edit' ? 'Edit OPC UA Connection' : 'Create OPC UA Connection';
                    elements.name.value = data.values.name || '';
                    elements.endpoint.value = data.values.endpointUrl || 'opc.tcp://';
                    elements.authType.value = data.values.authType || 'Anonymous';
                    elements.username.value = data.values.username || '';
                    elements.password.value = '';
                    elements.clearPassword.checked = false;
                    elements.clientCertificatePath.value = data.values.clientCertificatePath || '';
                    elements.clientPrivateKeyPath.value = data.values.clientPrivateKeyPath || '';

                    setSecurityOptions(
                        [{ securityMode: data.values.securityMode, securityPolicy: data.values.securityPolicy }],
                        data.values.securityMode + '|' + data.values.securityPolicy
                    );

                    toggleCredentialsSection(elements.authType.value);
                    setMessage('', '');
                    setLoading(false);
                    break;
                }
                case 'discovering':
                    setMessage('info', 'Discovering endpoints...');
                    break;
                case 'endpointsDiscovered':
                    setLoading(false);
                    const endpoints = Array.isArray(data?.endpoints) ? data.endpoints : [];
                    if (endpoints.length === 0) {
                        setMessage('info', 'No endpoints returned by the server. Defaulting to None / None.');
                        setSecurityOptions(
                            [{ securityMode: 'None', securityPolicy: 'None' }],
                            'None|None'
                        );
                    } else {
                        setMessage('success', 'Endpoints discovered. Select preferred security options.');
                        setSecurityOptions(endpoints, elements.security.value);
                    }
                    break;
                case 'discoverError':
                    setLoading(false);
                    setMessage('error', data?.error || 'Failed to discover endpoints.');
                    break;
                case 'submitError':
                    setLoading(false);
                    setMessage('error', data?.error || 'Validation failed.');
                    break;
                case 'certificateSelected':
                    elements.clientCertificatePath.value = data?.path || '';
                    break;
                case 'privateKeySelected':
                    elements.clientPrivateKeyPath.value = data?.path || '';
                    break;
            }
        });

        sendMessage('ready');
    </script>
</body>
</html>`;
    }

    private getNonce(): string {
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let nonce = '';
        for (let i = 0; i < 32; i++) {
            nonce += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return nonce;
    }
}
