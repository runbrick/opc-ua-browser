import * as vscode from 'vscode';
import { SearchResultItem } from '../types';

export interface SearchPanelConnection {
    id: string;
    name: string;
    endpointUrl?: string;
}

export type SearchScope = 'all' | 'connection';

export interface SearchPanelConfig {
    connections: SearchPanelConnection[];
    allowAllOption: boolean;
    defaultScope: SearchScope;
    defaultConnectionId?: string;
    defaultSearchTerm?: string;
}

export interface SearchRequest {
    searchTerm: string;
    scope: SearchScope;
    connectionId?: string;
}

export interface SearchProgressUpdate {
    connectionId: string;
    connectionName: string;
    current: number;
    total: number;
    message?: string;
}

export type SearchMessageType = 'info' | 'error' | 'warning' | 'success';

export interface SearchMessage {
    type: SearchMessageType;
    text: string;
}

export interface SearchHandlerResult {
    results: SearchResultItem[];
    searchedNodes: number;
    messages?: SearchMessage[];
    autoRevealIndex?: number;
}

export type SearchHandler = (
    request: SearchRequest,
    token: vscode.CancellationToken,
    reportProgress: (update: SearchProgressUpdate) => void
) => Promise<SearchHandlerResult>;

export type RevealCallback = (
    result: SearchResultItem,
    options?: { allowErrorMessage?: boolean }
) => Promise<void>;

export class SearchPanel {
    private static currentPanel: SearchPanel | undefined;

    public static show(
        extensionUri: vscode.Uri,
        config: SearchPanelConfig,
        onSearch: SearchHandler,
        onReveal: RevealCallback
    ): void {
        if (SearchPanel.currentPanel) {
            SearchPanel.currentPanel.update(config, onSearch, onReveal);
            SearchPanel.currentPanel.reveal();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'opcuaSearch',
            'OPC UA Search',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        SearchPanel.currentPanel = new SearchPanel(panel, extensionUri, config, onSearch, onReveal);
    }

    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private config: SearchPanelConfig;
    private onSearch: SearchHandler;
    private onReveal: RevealCallback;
    private disposables: vscode.Disposable[] = [];
    private latestResults: SearchResultItem[] = [];
    private searchCancellation?: vscode.CancellationTokenSource;

    private constructor(
        panel: vscode.WebviewPanel,
        extensionUri: vscode.Uri,
        config: SearchPanelConfig,
        onSearch: SearchHandler,
        onReveal: RevealCallback
    ) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.config = config;
        this.onSearch = onSearch;
        this.onReveal = onReveal;

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            (message) => this.handleMessage(message),
            undefined,
            this.disposables
        );

        this.panel.webview.html = this.getHtml(config);
        this.sendConfig();
    }

    private update(config: SearchPanelConfig, onSearch: SearchHandler, onReveal: RevealCallback): void {
        this.config = config;
        this.onSearch = onSearch;
        this.onReveal = onReveal;
        this.sendConfig();
    }

    private reveal(): void {
        this.panel.reveal(vscode.ViewColumn.Beside, false);
    }

    private handleMessage(message: unknown): void {
        if (!message || typeof message !== 'object') {
            return;
        }

        const payload = message as { command?: string; [key: string]: unknown };

        switch (payload.command) {
            case 'search':
                void this.startSearch(payload);
                break;
            case 'cancelSearch':
                this.cancelSearch();
                break;
            case 'openResult':
                if (typeof payload.index === 'number') {
                    const result = this.latestResults[payload.index];
                    if (result) {
                        this.onReveal(result, { allowErrorMessage: true }).catch((error) => {
                            console.error('Error opening search result:', error);
                            vscode.window.showErrorMessage(
                                error instanceof Error ? error.message : String(error)
                            );
                        });
                    }
                }
                break;
            case 'copyNodeId':
                if (typeof payload.nodeId === 'string') {
                    void vscode.env.clipboard.writeText(payload.nodeId).then(() => {
                        vscode.window.setStatusBarMessage('NodeId copied to clipboard', 2000);
                    });
                }
                break;
        }
    }

    private async startSearch(rawRequest: { [key: string]: unknown }): Promise<void> {
        const searchTerm = typeof rawRequest.searchTerm === 'string' ? rawRequest.searchTerm.trim() : '';
        const scope =
            rawRequest.scope === 'connection'
                ? 'connection'
                : rawRequest.scope === 'all'
                ? 'all'
                : undefined;
        const connectionId =
            typeof rawRequest.connectionId === 'string' && rawRequest.connectionId.length > 0
                ? rawRequest.connectionId
                : undefined;

        if (!searchTerm) {
            this.postMessage('searchError', { error: 'Search term cannot be empty.' });
            return;
        }

        if (!scope) {
            this.postMessage('searchError', { error: 'Invalid search scope.' });
            return;
        }

        if (scope === 'connection' && !connectionId) {
            this.postMessage('searchError', { error: 'Please select a server to search.' });
            return;
        }

        this.cancelSearch();

        const cancellation = new vscode.CancellationTokenSource();
        this.searchCancellation = cancellation;

        const request: SearchRequest = {
            searchTerm,
            scope,
            connectionId
        };

        this.sendSearchStatus('loading', 'Starting search...');

        try {
            const result = await this.onSearch(request, cancellation.token, (update) => this.sendProgress(update));

            if (cancellation.token.isCancellationRequested) {
                this.postMessage('searchCancelled', undefined);
                this.sendSearchStatus('idle', 'Search cancelled.');
                return;
            }

            this.latestResults = result.results;
            this.sendResults(request.searchTerm, result);
            this.sendSearchStatus('idle', result.results.length > 0 ? '' : 'Search completed.');

            if (typeof result.autoRevealIndex === 'number') {
                const autoResult = result.results[result.autoRevealIndex];
                if (autoResult) {
                    try {
                        await this.onReveal(autoResult, { allowErrorMessage: false });
                    } catch (error) {
                        console.error('Error auto-opening search result:', error);
                    }
                }
            }
        } catch (error) {
            if (cancellation.token.isCancellationRequested) {
                this.postMessage('searchCancelled', undefined);
                this.sendSearchStatus('idle', 'Search cancelled.');
                return;
            }

            console.error('Error performing search:', error);
            this.postMessage('searchError', {
                error: error instanceof Error ? error.message : String(error)
            });
            this.sendSearchStatus('idle', 'Search failed.');
        } finally {
            cancellation.dispose();
            if (this.searchCancellation === cancellation) {
                this.searchCancellation = undefined;
            }
        }
    }

    private cancelSearch(): void {
        if (this.searchCancellation) {
            this.searchCancellation.cancel();
        }
    }

    private sendResults(searchTerm: string, result: SearchHandlerResult): void {
        const payload = {
            searchTerm,
            searchedNodes: result.searchedNodes,
            results: result.results.map((item, index) => ({ index, ...item })),
            messages: result.messages ?? []
        };
        this.postMessage('searchResults', payload);
    }

    private sendSearchStatus(status: 'idle' | 'loading', message?: string): void {
        this.postMessage('searchStatus', { status, message });
    }

    private sendProgress(update: SearchProgressUpdate): void {
        this.postMessage('searchProgress', update);
    }

    private sendConfig(): void {
        const payload: SearchPanelConfig = {
            connections: this.config.connections,
            allowAllOption: this.config.allowAllOption,
            defaultScope: this.config.defaultScope,
            defaultConnectionId: this.config.defaultConnectionId,
            defaultSearchTerm: this.config.defaultSearchTerm
        };
        this.postMessage('updateConfig', payload);
    }

    private postMessage(command: string, payload: unknown): void {
        this.panel.webview.postMessage({
            command,
            payload
        });
    }

    private getHtml(config: SearchPanelConfig): string {
        const nonce = this.getNonce();
        const initialConfig = this.serializeForWebview({
            connections: config.connections,
            allowAllOption: config.allowAllOption,
            defaultScope: config.defaultScope,
            defaultConnectionId: config.defaultConnectionId ?? null,
            defaultSearchTerm: config.defaultSearchTerm ?? ''
        });

        const csp = [
            "default-src 'none'",
            `style-src 'nonce-${nonce}'`,
            `script-src 'nonce-${nonce}'`,
            `img-src data:`,
            'font-src data:'
        ].join('; ');

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OPC UA Search</title>
    <style nonce="${nonce}">
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            margin: 0;
            padding: 16px;
            box-sizing: border-box;
        }

        h1 {
            margin: 0 0 16px;
            font-size: 1.3em;
            font-weight: 500;
        }

        form {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            align-items: flex-end;
            margin-bottom: 12px;
        }

        .field {
            display: flex;
            flex-direction: column;
            gap: 4px;
            min-width: 220px;
        }

        label {
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
        }

        input[type="search"],
        select {
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 6px 8px;
            font-size: 0.95em;
        }

        input[type="search"]:focus,
        select:focus {
            outline: 1px solid var(--vscode-focusBorder);
        }

        .buttons {
            display: flex;
            gap: 8px;
        }

        .buttons button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            padding: 6px 14px;
            cursor: pointer;
        }

        .buttons button.secondary {
            background-color: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
            color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
        }

        .buttons button[disabled] {
            opacity: 0.6;
            cursor: default;
        }

        .buttons button:not([disabled]):hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .status,
        .summary {
            margin-bottom: 12px;
            color: var(--vscode-descriptionForeground);
            min-height: 18px;
        }

        .messages {
            display: grid;
            gap: 8px;
            margin-bottom: 12px;
        }

        .message {
            border-radius: 4px;
            padding: 8px 10px;
            font-size: 0.9em;
        }

        .message.error {
            background-color: rgba(255, 45, 85, 0.15);
            color: var(--vscode-errorForeground);
        }

        .message.warning {
            background-color: rgba(255, 204, 0, 0.15);
        }

        .message.info {
            background-color: var(--vscode-editorInlayHint-background);
        }

        .results {
            display: grid;
            gap: 12px;
        }

        .result {
            border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
            border-radius: 6px;
            padding: 12px;
            background-color: var(--vscode-editor-background);
            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
        }

        .result-header {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            gap: 8px;
            margin-bottom: 8px;
        }

        .result-title {
            font-size: 1.05em;
            font-weight: 500;
            word-break: break-word;
        }

        .result-meta {
            color: var(--vscode-descriptionForeground);
            font-size: 0.9em;
            margin-bottom: 8px;
            word-break: break-all;
        }

        .result-actions {
            display: flex;
            gap: 8px;
        }

        .empty {
            text-align: center;
            padding: 32px 16px;
            color: var(--vscode-descriptionForeground);
            border: 1px dashed var(--vscode-descriptionForeground);
            border-radius: 6px;
        }
    </style>
</head>
<body>
    <h1>OPC UA Node Search</h1>
    <form id="searchForm">
        <div class="field">
            <label for="searchTerm">Search term</label>
            <input type="search" id="searchTerm" placeholder="Node display name, browse name, or NodeId">
        </div>
        <div class="field">
            <label for="scopeSelect">Server</label>
            <select id="scopeSelect"></select>
        </div>
        <div class="buttons">
            <button type="submit" id="searchButton">Search</button>
            <button type="button" class="secondary" id="cancelButton">Cancel</button>
        </div>
    </form>
    <div class="status" id="statusMessage"></div>
    <div class="messages" id="messages"></div>
    <div class="summary" id="summary"></div>
    <div class="results" id="results"></div>
    <div class="empty" id="emptyState">Enter a search term to begin.</div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const initialConfig = ${initialConfig};

        const defaultState = {
            config: initialConfig,
            searchTerm: initialConfig.defaultSearchTerm || '',
            scope: initialConfig.defaultScope || 'all',
            connectionId:
                initialConfig.defaultConnectionId ||
                (initialConfig.allowAllOption ? 'all' : initialConfig.connections[0]?.id || ''),
            results: [],
            searchedNodes: 0,
            messages: [],
            status: 'idle',
            statusMessage: '',
            lastSearchTerm: ''
        };

        let state = Object.assign({}, defaultState, vscode.getState() || {});

        const searchForm = document.getElementById('searchForm');
        const searchInput = document.getElementById('searchTerm');
        const scopeSelect = document.getElementById('scopeSelect');
        const searchButton = document.getElementById('searchButton');
        const cancelButton = document.getElementById('cancelButton');
        const statusMessage = document.getElementById('statusMessage');
        const messagesContainer = document.getElementById('messages');
        const summaryElement = document.getElementById('summary');
        const resultsContainer = document.getElementById('results');
        const emptyStateElement = document.getElementById('emptyState');

        const persistState = () => {
            const { config, ...rest } = state;
            vscode.setState(rest);
        };

        const buildScopeOptions = () => {
            while (scopeSelect.firstChild) {
                scopeSelect.removeChild(scopeSelect.firstChild);
            }

            if (state.config.allowAllOption) {
                const option = document.createElement('option');
                option.value = 'all';
                option.textContent = 'All connected servers';
                scopeSelect.appendChild(option);
            }

            state.config.connections.forEach((connection) => {
                const option = document.createElement('option');
                option.value = connection.id;
                option.textContent = connection.name || connection.endpointUrl || connection.id;
                scopeSelect.appendChild(option);
            });
        };

        const updateButtons = () => {
            const hasConnections = state.config.allowAllOption || state.config.connections.length > 0;
            searchButton.disabled = state.status === 'loading' || !hasConnections;
            cancelButton.disabled = state.status !== 'loading';
        };

        const syncForm = () => {
            searchInput.value = state.searchTerm;

            if (!state.config.allowAllOption && state.config.connections.length === 1) {
                scopeSelect.value = state.config.connections[0].id;
            } else if (state.config.allowAllOption) {
                if (state.scope === 'all') {
                    scopeSelect.value = 'all';
                } else if (state.connectionId) {
                    scopeSelect.value = state.connectionId;
                } else {
                    scopeSelect.value = 'all';
                }
            } else if (state.connectionId) {
                scopeSelect.value = state.connectionId;
            }

            updateButtons();
        };

        const updateStatus = (message) => {
            statusMessage.textContent = message || '';
        };

        const renderMessages = () => {
            messagesContainer.innerHTML = '';
            (state.messages || []).forEach((msg) => {
                const div = document.createElement('div');
                div.className = \`message \${msg.type || 'info'}\`;
                div.textContent = msg.text;
                messagesContainer.appendChild(div);
            });
        };

        const renderSummary = () => {
            if (state.results.length === 0) {
                summaryElement.textContent = state.lastSearchTerm
                    ? \`No results for "\${state.lastSearchTerm}" (searched \${state.searchedNodes} nodes).\`
                    : '';
            } else {
                summaryElement.textContent = \`Results for "\${state.lastSearchTerm}" - \${state.results.length} matches (searched \${state.searchedNodes} nodes).\`;
            }
        };

        const renderResults = () => {
            resultsContainer.innerHTML = '';

            if (state.results.length === 0) {
                emptyStateElement.style.display = 'block';
                return;
            }

            emptyStateElement.style.display = 'none';

            state.results.forEach((result) => {
                const card = document.createElement('div');
                card.className = 'result';

                const header = document.createElement('div');
                header.className = 'result-header';

                const title = document.createElement('div');
                title.className = 'result-title';
                title.textContent = result.displayName || result.browseName || result.nodeId;

                const nodeClass = document.createElement('span');
                nodeClass.className = 'result-meta';
                nodeClass.textContent = result.nodeClass;

                header.appendChild(title);
                header.appendChild(nodeClass);
                card.appendChild(header);

                const connectionInfo = document.createElement('div');
                connectionInfo.className = 'result-meta';
                connectionInfo.textContent = \`Connection: \${result.connectionName}\`;
                card.appendChild(connectionInfo);

                if (result.path) {
                    const pathInfo = document.createElement('div');
                    pathInfo.className = 'result-meta';
                    pathInfo.textContent = result.path;
                    card.appendChild(pathInfo);
                }

                const nodeIdInfo = document.createElement('div');
                nodeIdInfo.className = 'result-meta';
                nodeIdInfo.textContent = \`NodeId: \${result.nodeId}\`;
                card.appendChild(nodeIdInfo);

                const actions = document.createElement('div');
                actions.className = 'result-actions';

                const openButton = document.createElement('button');
                openButton.textContent = 'Open';
                openButton.addEventListener('click', () => {
                    const index = typeof result.index === 'number' ? result.index : state.results.indexOf(result);
                    vscode.postMessage({ command: 'openResult', index });
                });

                const copyButton = document.createElement('button');
                copyButton.textContent = 'Copy NodeId';
                copyButton.className = 'secondary';
                copyButton.addEventListener('click', () => {
                    vscode.postMessage({ command: 'copyNodeId', nodeId: result.nodeId });
                });

                actions.appendChild(openButton);
                actions.appendChild(copyButton);
                card.appendChild(actions);

                resultsContainer.appendChild(card);
            });
        };

        const refresh = () => {
            buildScopeOptions();
            syncForm();
            renderMessages();
            renderSummary();
            renderResults();
            updateStatus(state.statusMessage);
        };

        searchForm.addEventListener('submit', (event) => {
            event.preventDefault();

            const term = searchInput.value.trim();
            if (!term) {
                state.messages = [{ type: 'error', text: 'Search term cannot be empty.' }];
                renderMessages();
                return;
            }

            let scope = 'all';
            let connectionId;

            if (!state.config.allowAllOption && state.config.connections.length === 1) {
                scope = 'connection';
                connectionId = state.config.connections[0].id;
            } else {
                const selected = scopeSelect.value;
                if (selected === 'all') {
                    scope = 'all';
                } else {
                    scope = 'connection';
                    connectionId = selected;
                }
            }

            state.searchTerm = term;
            state.scope = scope;
            state.connectionId = connectionId || '';
            state.status = 'loading';
            state.statusMessage = 'Searching...';
            state.messages = [];

            updateButtons();
            updateStatus(state.statusMessage);
            renderMessages();
            persistState();

            vscode.postMessage({
                command: 'search',
                searchTerm: term,
                scope,
                connectionId
            });
        });

        cancelButton.addEventListener('click', () => {
            vscode.postMessage({ command: 'cancelSearch' });
        });

        window.addEventListener('message', (event) => {
            const { command, payload } = event.data || {};
            switch (command) {
                case 'updateConfig':
                    if (payload) {
                        state.config = Object.assign({}, state.config, payload);
                        if (!state.config.allowAllOption && state.config.connections.length === 1) {
                            state.scope = 'connection';
                            state.connectionId = state.config.connections[0].id;
                        }
                        refresh();
                        persistState();
                    }
                    break;
                case 'searchStatus':
                    if (payload) {
                        state.status = payload.status || 'idle';
                        state.statusMessage = payload.message || '';
                        updateButtons();
                        updateStatus(state.statusMessage);
                        persistState();
                    }
                    break;
                case 'searchProgress':
                    if (payload) {
                        const totalLabel = payload.total > 0 ? \` (\${payload.current}/\${payload.total})\` : '';
                        const message = payload.message || \`Searching in \${payload.connectionName || ''}\${totalLabel}\`.trim();
                        state.statusMessage = message;
                        updateStatus(state.statusMessage);
                    }
                    break;
                case 'searchResults':
                    if (payload) {
                        state.results = Array.isArray(payload.results) ? payload.results : [];
                        state.searchedNodes = payload.searchedNodes || 0;
                        state.messages = payload.messages || [];
                        state.lastSearchTerm = payload.searchTerm || state.searchTerm;
                        state.status = 'idle';
                        state.statusMessage = '';
                        updateButtons();
                        updateStatus(state.statusMessage);
                        renderMessages();
                        renderSummary();
                        renderResults();
                        persistState();
                    }
                    break;
                case 'searchError':
                    if (payload) {
                        state.status = 'idle';
                        state.statusMessage = '';
                        state.messages = [{ type: 'error', text: payload.error || 'Search failed.' }];
                        updateButtons();
                        updateStatus(state.statusMessage);
                        renderMessages();
                        persistState();
                    }
                    break;
                case 'searchCancelled':
                    state.status = 'idle';
                    state.statusMessage = 'Search cancelled.';
                    updateButtons();
                    updateStatus(state.statusMessage);
                    persistState();
                    break;
            }
        });

        refresh();
    </script>
</body>
</html>`;
    }

    private serializeForWebview(data: unknown): string {
        return JSON.stringify(data)
            .replace(/</g, '\u003c')
            .replace(/\u2028/g, '\u2028')
            .replace(/\u2029/g, '\u2029');
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    public dispose(): void {
        SearchPanel.currentPanel = undefined;

        this.cancelSearch();
        this.panel.dispose();

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
