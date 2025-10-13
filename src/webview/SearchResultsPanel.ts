import * as vscode from 'vscode';

export interface SearchResultItem {
    connectionId: string;
    connectionName: string;
    nodeId: string;
    displayName: string;
    browseName: string;
    nodeClass: string;
    path: string;
    nodeIdPath: string[];
}

interface SearchResultsData {
    searchTerm: string;
    searchedNodes: number;
    results: SearchResultItem[];
}

type RevealCallback = (result: SearchResultItem) => Promise<void>;

export class SearchResultsPanel {
    private static currentPanel: SearchResultsPanel | undefined;

    public static show(
        extensionUri: vscode.Uri,
        data: SearchResultsData,
        onReveal: RevealCallback
    ): void {
        if (SearchResultsPanel.currentPanel) {
            SearchResultsPanel.currentPanel.update(data, onReveal);
            SearchResultsPanel.currentPanel.reveal();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'opcuaSearchResults',
            'OPC UA Search Results',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        SearchResultsPanel.currentPanel = new SearchResultsPanel(panel, data, onReveal);
    }

    private readonly panel: vscode.WebviewPanel;
    private data: SearchResultsData;
    private onReveal: RevealCallback;
    private disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, data: SearchResultsData, onReveal: RevealCallback) {
        this.panel = panel;
        this.data = data;
        this.onReveal = onReveal;

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                if (!message || typeof message !== 'object') {
                    return;
                }

                switch (message.command) {
                    case 'openResult':
                        if (typeof message.index === 'number') {
                            const result = this.data.results[message.index];
                            if (result) {
                                try {
                                    await this.onReveal(result);
                                } catch (error) {
                                    console.error('Error opening search result:', error);
                                    vscode.window.showErrorMessage(
                                        error instanceof Error ? error.message : String(error)
                                    );
                                }
                            }
                        }
                        break;
                    case 'copyNodeId':
                        if (typeof message.nodeId === 'string') {
                            await vscode.env.clipboard.writeText(message.nodeId);
                            vscode.window.setStatusBarMessage('NodeId copied to clipboard', 2000);
                        }
                        break;
                }
            },
            null,
            this.disposables
        );

        this.updateWebview();
    }

    private update(data: SearchResultsData, onReveal: RevealCallback): void {
        this.data = data;
        this.onReveal = onReveal;
        this.updateWebview();
    }

    private reveal(): void {
        this.panel.reveal(vscode.ViewColumn.Beside, false);
    }

    private updateWebview(): void {
        this.panel.title = `Search Results (${this.data.results.length})`;
        this.panel.webview.html = this.getHtml(this.data);
    }

    private getHtml(data: SearchResultsData): string {
        const nonce = this.getNonce();
        const serialized = this.serializeForWebview({
            searchTerm: data.searchTerm,
            searchedNodes: data.searchedNodes,
            results: data.results.map((result, index) => ({
                index,
                ...result
            }))
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
    <title>OPC UA Search Results</title>
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
            margin: 0 0 12px;
            font-size: 1.4em;
            font-weight: 500;
        }

        .summary {
            margin-bottom: 16px;
            color: var(--vscode-descriptionForeground);
        }

        .controls {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
            align-items: center;
            margin-bottom: 16px;
        }

        .controls label {
            font-size: 0.9em;
            color: var(--vscode-descriptionForeground);
        }

        .controls input,
        .controls select {
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 4px;
            padding: 6px 8px;
            min-width: 220px;
            font-size: 0.95em;
        }

        .results-container {
            display: grid;
            gap: 12px;
        }

        .result-card {
            border: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border));
            border-radius: 6px;
            padding: 12px;
            background-color: var(--vscode-editor-background);
            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
        }

        .result-card:hover {
            border-color: var(--vscode-focusBorder);
        }

        .result-header {
            display: flex;
            justify-content: space-between;
            align-items: baseline;
            margin-bottom: 8px;
            gap: 8px;
        }

        .result-title {
            font-size: 1.1em;
            font-weight: 500;
            word-break: break-word;
        }

        .node-class {
            font-size: 0.85em;
            color: var(--vscode-descriptionForeground);
            border: 1px solid var(--vscode-descriptionForeground);
            border-radius: 3px;
            padding: 2px 6px;
            white-space: nowrap;
        }

        .result-detail {
            margin-bottom: 8px;
            color: var(--vscode-descriptionForeground);
            word-break: break-word;
        }

        .meta {
            display: grid;
            gap: 6px;
            margin-bottom: 12px;
        }

        .meta-item {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
        }

        .meta-label {
            font-weight: 500;
        }

        .meta-value {
            color: var(--vscode-descriptionForeground);
            word-break: break-all;
        }

        .actions {
            display: flex;
            gap: 8px;
        }

        .action-button {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            border-radius: 4px;
            padding: 6px 12px;
            cursor: pointer;
        }

        .action-button.secondary {
            background-color: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
            color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
        }

        .action-button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        .empty-state {
            text-align: center;
            padding: 40px 16px;
            border: 1px dashed var(--vscode-descriptionForeground);
            border-radius: 6px;
            color: var(--vscode-descriptionForeground);
        }
    </style>
</head>
<body>
    <h1>Search Results</h1>
    <div class="summary" id="summary"></div>
    <div class="controls">
        <label>
            Filter:
            <input type="search" id="filterInput" placeholder="Filter by name, path, nodeId or connection">
        </label>
        <label>
            Connection:
            <select id="connectionFilter"></select>
        </label>
        <span id="resultCount"></span>
    </div>
    <div class="results-container" id="results"></div>
    <div class="empty-state" id="emptyState" style="display: none;">No results match the current filters.</div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const state = ${serialized};

        const summaryElement = document.getElementById('summary');
        const resultsContainer = document.getElementById('results');
        const emptyStateElement = document.getElementById('emptyState');
        const filterInput = document.getElementById('filterInput');
        const connectionFilter = document.getElementById('connectionFilter');
        const resultCount = document.getElementById('resultCount');

        const uniqueConnections = Array.from(new Set(state.results.map(r => r.connectionName))).sort();
        connectionFilter.appendChild(new Option('All connections', ''));
        uniqueConnections.forEach(name => {
            connectionFilter.appendChild(new Option(name, name));
        });

        summaryElement.textContent = \`Search term "\${state.searchTerm}" — \${state.results.length} results (searched \${state.searchedNodes} nodes)\`;

        function openResult(index) {
            vscode.postMessage({ command: 'openResult', index });
        }

        function copyNodeId(nodeId) {
            vscode.postMessage({ command: 'copyNodeId', nodeId });
        }

        function render(results) {
            resultsContainer.innerHTML = '';

            if (!results.length) {
                emptyStateElement.style.display = 'block';
                return;
            }

            emptyStateElement.style.display = 'none';

            for (const result of results) {
                const card = document.createElement('div');
                card.className = 'result-card';
                card.dataset.index = String(result.index);

                card.addEventListener('dblclick', () => openResult(result.index));

                const header = document.createElement('div');
                header.className = 'result-header';

                const title = document.createElement('div');
                title.className = 'result-title';
                title.textContent = result.displayName || result.browseName || result.nodeId;

                const nodeClass = document.createElement('span');
                nodeClass.className = 'node-class';
                nodeClass.textContent = result.nodeClass || 'Unknown';

                header.appendChild(title);
                header.appendChild(nodeClass);

                const detail = document.createElement('div');
                detail.className = 'result-detail';
                detail.textContent = result.path || '(no path available)';

                const meta = document.createElement('div');
                meta.className = 'meta';

                meta.appendChild(createMetaItem('Connection', result.connectionName));
                meta.appendChild(createMetaItem('NodeId', result.nodeId));
                if (result.browseName && result.browseName !== result.displayName) {
                    meta.appendChild(createMetaItem('Browse Name', result.browseName));
                }

                const actions = document.createElement('div');
                actions.className = 'actions';

                const openButton = document.createElement('button');
                openButton.className = 'action-button';
                openButton.type = 'button';
                openButton.textContent = 'Reveal in Tree';
                openButton.addEventListener('click', () => openResult(result.index));

                const copyButton = document.createElement('button');
                copyButton.className = 'action-button secondary';
                copyButton.type = 'button';
                copyButton.textContent = 'Copy NodeId';
                copyButton.addEventListener('click', () => copyNodeId(result.nodeId));

                actions.appendChild(openButton);
                actions.appendChild(copyButton);

                card.appendChild(header);
                card.appendChild(detail);
                card.appendChild(meta);
                card.appendChild(actions);

                resultsContainer.appendChild(card);
            }
        }

        function createMetaItem(label, value) {
            const wrapper = document.createElement('div');
            wrapper.className = 'meta-item';

            const labelElement = document.createElement('span');
            labelElement.className = 'meta-label';
            labelElement.textContent = label + ':';

            const valueElement = document.createElement('span');
            valueElement.className = 'meta-value';
            valueElement.textContent = value;

            wrapper.appendChild(labelElement);
            wrapper.appendChild(valueElement);

            return wrapper;
        }

        function applyFilters() {
            const text = filterInput.value.trim().toLowerCase();
            const connection = connectionFilter.value;

            const filtered = state.results.filter(result => {
                if (connection && result.connectionName !== connection) {
                    return false;
                }

                if (!text) {
                    return true;
                }

                const haystack = [
                    result.displayName,
                    result.browseName,
                    result.nodeId,
                    result.connectionName,
                    result.path
                ]
                    .filter(Boolean)
                    .join(' ')
                    .toLowerCase();

                return haystack.includes(text);
            });

            resultCount.textContent = \`\${filtered.length} of \${state.results.length} results\`;
            render(filtered);
        }

        filterInput.addEventListener('input', applyFilters);
        connectionFilter.addEventListener('change', applyFilters);

        resultCount.textContent = \`\${state.results.length} results\`;
        render(state.results);
    </script>
</body>
</html>`;
    }

    private serializeForWebview(data: unknown): string {
        return JSON.stringify(data)
            .replace(/</g, '\\u003c')
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029');
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
        SearchResultsPanel.currentPanel = undefined;

        this.panel.dispose();

        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }
}
