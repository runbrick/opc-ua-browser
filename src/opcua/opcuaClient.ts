import {
    OPCUAClient,
    ClientSession,
    MessageSecurityMode,
    SecurityPolicy,
    UserTokenType,
    AttributeIds,
    BrowseDirection,
    NodeClass,
    DataValue,
    ReferenceDescription,
    NodeId,
    coerceNodeId,
    ReadValueIdOptions,
    BrowseDescriptionOptions,
    BrowseResult,
    ReferenceTypeIds
} from 'node-opcua';
import {
    OpcuaConnectionConfig,
    OpcuaNodeInfo,
    OpcuaReference,
    ConnectionStatus,
    OpcuaNodePathSegment
} from '../types';
import { normalizeNodeIdInput } from '../utils/nodeIdUtils';

const HIERARCHICAL_REFERENCES_NODE_ID = coerceNodeId(ReferenceTypeIds.HierarchicalReferences);

export interface NodeValueSnapshot {
    nodeId: string;
    displayName?: string;
    value?: any;
    dataType?: string;
    nodeClass?: string;
    statusCode?: string;
    sourceTimestamp?: string;
    serverTimestamp?: string;
    error?: string;
}

async function mapWithConcurrency<T, R>(
    items: readonly T[],
    limit: number,
    mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    if (items.length === 0) {
        return [];
    }

    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
        while (nextIndex < items.length) {
            const currentIndex = nextIndex;
            nextIndex += 1;

            try {
                results[currentIndex] = await mapper(items[currentIndex], currentIndex);
            } catch (error) {
                console.error('Error in concurrent mapper:', error);
                results[currentIndex] = undefined as unknown as R;
            }
        }
    };

    const workers = new Array(Math.min(Math.max(1, limit), items.length)).fill(0).map(() => worker());
    await Promise.all(workers);
    return results;
}


export interface VariableNodeSummary {
    nodeId: string;
    displayName?: string;
    browseName?: string;
}

export interface VariableNodeCollectionResult {
    nodes: VariableNodeSummary[];
    truncated: boolean;
}

export class OpcuaClient {
    private client: OPCUAClient | null = null;
    private session: ClientSession | null = null;
    private config: OpcuaConnectionConfig;
    private _status: ConnectionStatus = ConnectionStatus.Disconnected;

    constructor(config: OpcuaConnectionConfig) {
        this.config = config;
    }

    getConfig(): OpcuaConnectionConfig {
        return this.config;
    }

    updateConfig(config: OpcuaConnectionConfig): void {
        this.config = config;
        this._status = ConnectionStatus.Disconnected;
        this.session = null;
        this.client = null;
    }

    get status(): ConnectionStatus {
        return this._status;
    }

    get isConnected(): boolean {
        return this._status === ConnectionStatus.Connected && this.session !== null;
    }

    async connect(): Promise<void> {
        try {
            this._status = ConnectionStatus.Connecting;

            // Create OPC UA client
            this.client = OPCUAClient.create({
                applicationName: 'VSCode OPC UA Browser',
                connectionStrategy: {
                    initialDelay: 1000,
                    maxRetry: 1
                },
                securityMode: this.parseSecurityMode(this.config.securityMode),
                securityPolicy: this.parseSecurityPolicy(this.config.securityPolicy),
                endpointMustExist: false
            });

            // Connect to server
            await this.client.connect(this.config.endpointUrl);

            // Create session
            if (this.config.authType === 'UserPassword' && this.config.username && this.config.password) {
                this.session = await this.client.createSession({
                    userName: this.config.username,
                    password: this.config.password,
                    type: UserTokenType.UserName
                });
            } else {
                this.session = await this.client.createSession({
                    type: UserTokenType.Anonymous
                });
            }

            this._status = ConnectionStatus.Connected;
        } catch (error) {
            this._status = ConnectionStatus.Error;
            await this.disconnect();
            throw error;
        }
    }

    async disconnect(): Promise<void> {
        try {
            if (this.session) {
                await this.session.close();
                this.session = null;
            }
            if (this.client) {
                await this.client.disconnect();
                this.client = null;
            }
        } catch (error) {
            console.error('Error disconnecting:', error);
        } finally {
            this._status = ConnectionStatus.Disconnected;
        }
    }

    async browse(nodeId: string = 'RootFolder'): Promise<ReferenceDescription[]> {
        return this.browseInternal(nodeId, true);
    }

    async browseWithOptions(
        nodeId: string = 'RootFolder',
        options?: { includeNonHierarchical?: boolean }
    ): Promise<ReferenceDescription[]> {
        const includeNonHierarchical = options?.includeNonHierarchical ?? true;
        return this.browseInternal(nodeId, includeNonHierarchical);
    }

    private async browseInternal(
        nodeId: string = 'RootFolder',
        includeNonHierarchical: boolean
    ): Promise<ReferenceDescription[]> {
        if (!this.session) {
            throw new Error('Not connected to OPC UA server');
        }

        try {
            // Normalize RootFolder identifier quirks
            let actualNodeId = nodeId;
            if (nodeId === 'RootFolder' || nodeId === 'i=84') {
                actualNodeId = 'i=84'; // Standard NodeId for RootFolder
            }

            const browseDescription: BrowseDescriptionOptions = {
                nodeId: coerceNodeId(actualNodeId),
                referenceTypeId: includeNonHierarchical ? undefined : HIERARCHICAL_REFERENCES_NODE_ID,
                browseDirection: BrowseDirection.Forward,
                includeSubtypes: true,
                nodeClassMask: 0,
                resultMask: 63
            };

            const browseResult = await this.session.browse(browseDescription);
            const references: ReferenceDescription[] = [...(browseResult.references || [])];

            let continuationPoint: Buffer | null = browseResult.continuationPoint || null;

            while (continuationPoint && continuationPoint.length > 0) {
                const moreResults: BrowseResult[] = await this.session.browseNext([continuationPoint], false);
                const [nextResult] = moreResults;

                if (!nextResult) {
                    break;
                }

                if (nextResult.references && nextResult.references.length > 0) {
                    references.push(...nextResult.references);
                }

                continuationPoint = nextResult.continuationPoint && nextResult.continuationPoint.length > 0
                    ? nextResult.continuationPoint
                    : null;
            }

            if (continuationPoint && continuationPoint.length > 0) {
                try {
                    await this.session.browseNext([continuationPoint], true);
                } catch (releaseError) {
                    console.warn('Failed to release continuation point:', releaseError);
                }
            }

            if (!includeNonHierarchical && references.length === 0) {
                console.warn(`No hierarchical references returned for ${nodeId}; falling back to full reference list.`);
                return this.browseInternal(nodeId, true);
            }

            console.log(`Browsed node ${nodeId}, found ${references.length} references (including continuation points)`);

            return references;
        } catch (error) {
            console.error('Error browsing node:', error);
            throw error;
        }
    }

    async readNodeAttributes(nodeId: string): Promise<OpcuaNodeInfo> {
        if (!this.session) {
            throw new Error('Not connected to OPC UA server');
        }

        try {
            const nodesToRead: ReadValueIdOptions[] = [
                { nodeId: coerceNodeId(nodeId), attributeId: AttributeIds.NodeClass },
                { nodeId: coerceNodeId(nodeId), attributeId: AttributeIds.BrowseName },
                { nodeId: coerceNodeId(nodeId), attributeId: AttributeIds.DisplayName },
                { nodeId: coerceNodeId(nodeId), attributeId: AttributeIds.Description },
                { nodeId: coerceNodeId(nodeId), attributeId: AttributeIds.Value },
                { nodeId: coerceNodeId(nodeId), attributeId: AttributeIds.DataType },
                { nodeId: coerceNodeId(nodeId), attributeId: AttributeIds.AccessLevel },
                { nodeId: coerceNodeId(nodeId), attributeId: AttributeIds.UserAccessLevel }
            ];

            const dataValues: DataValue[] = await this.session.read(nodesToRead);

            const nodeInfo: OpcuaNodeInfo = {
                nodeId: nodeId,
                browseName: dataValues[1].value?.value?.name || '',
                displayName: dataValues[2].value?.value?.text || '',
                nodeClass: NodeClass[dataValues[0].value?.value as number] || 'Unknown',
                description: dataValues[3].value?.value?.text || '',
                value: dataValues[4].value?.value,
                dataType: dataValues[5].value?.value?.toString(),
                accessLevel: dataValues[6].value?.value,
                userAccessLevel: dataValues[7].value?.value,
                statusCode: dataValues[4].statusCode?.toString(),
                sourceTimestamp: dataValues[4].sourceTimestamp
                    ? dataValues[4].sourceTimestamp.toISOString()
                    : undefined,
                serverTimestamp: dataValues[4].serverTimestamp
                    ? dataValues[4].serverTimestamp.toISOString()
                    : undefined
            };

            return nodeInfo;
        } catch (error) {
            console.error('Error reading node attributes:', error);
            throw error;
        }
    }

    async readNodeSnapshots(nodeIds: string[]): Promise<NodeValueSnapshot[]> {
        if (!this.session) {
            throw new Error('Not connected to OPC UA server');
        }

        if (nodeIds.length === 0) {
            return [];
        }

        const attributeOrder = [
            AttributeIds.DisplayName,
            AttributeIds.Value,
            AttributeIds.DataType,
            AttributeIds.NodeClass
        ];

        const nodesToRead: ReadValueIdOptions[] = [];
        const normalizedIds: string[] = [];

        for (const nodeId of nodeIds) {
            const normalized = normalizeNodeIdInput(nodeId);
            normalizedIds.push(normalized);
            for (const attributeId of attributeOrder) {
                nodesToRead.push({
                    nodeId: coerceNodeId(normalized),
                    attributeId
                });
            }
        }

        try {
            const dataValues: DataValue[] = await this.session.read(nodesToRead);
            const results: NodeValueSnapshot[] = [];

            const attributesPerNode = attributeOrder.length;

            for (let index = 0; index < normalizedIds.length; index++) {
                const baseIndex = index * attributesPerNode;
                const displayNameValue = dataValues[baseIndex]?.value?.value;
                const valueData = dataValues[baseIndex + 1];
                const dataTypeValue = dataValues[baseIndex + 2]?.value?.value;
                const nodeClassValue = dataValues[baseIndex + 3]?.value?.value;

                const statusCodeString = valueData?.statusCode?.toString();
                const statusNotGood =
                    valueData?.statusCode &&
                    typeof (valueData.statusCode as any).isNotGood === 'function'
                        ? (valueData.statusCode as any).isNotGood()
                        : (statusCodeString ? statusCodeString.toLowerCase().includes('bad') : false);

                const snapshot: NodeValueSnapshot = {
                    nodeId: nodeIds[index],
                    displayName: displayNameValue?.text || displayNameValue?.name || undefined,
                    value: valueData?.value?.value,
                    dataType: typeof dataTypeValue === 'object' && dataTypeValue !== null
                        ? dataTypeValue.toString()
                        : dataTypeValue?.toString(),
                    nodeClass: typeof nodeClassValue === 'number'
                        ? NodeClass[nodeClassValue] || 'Unknown'
                        : undefined,
                    statusCode: statusCodeString,
                    sourceTimestamp: valueData?.sourceTimestamp
                        ? valueData.sourceTimestamp.toISOString()
                        : undefined,
                    serverTimestamp: valueData?.serverTimestamp
                        ? valueData.serverTimestamp.toISOString()
                        : undefined
                };

                if (statusNotGood) {
                    snapshot.error = statusCodeString;
                }

                results.push(snapshot);
            }

            return results;
        } catch (error) {
            return nodeIds.map((nodeId) => ({
                nodeId,
                error: error instanceof Error ? error.message : String(error)
            }));
        }
    }

    async collectVariableDescendantNodes(
        nodeId: string,
        options?: {
            includeNonHierarchical?: boolean;
            maxDepth?: number;
            maxNodes?: number;
        }
    ): Promise<VariableNodeCollectionResult> {
        if (!this.session) {
            throw new Error('Not connected to OPC UA server');
        }

        const includeNonHierarchical = options?.includeNonHierarchical ?? true;
        const maxDepth = options?.maxDepth ?? 10;
        const maxNodes = options?.maxNodes ?? 500;

        const visited = new Set<string>();
        visited.add(normalizeNodeIdInput(nodeId));

        const queue: Array<{ nodeId: string; depth: number }> = [{ nodeId, depth: 0 }];
        const nodes: VariableNodeSummary[] = [];
        let truncated = false;

        outer: while (queue.length > 0) {
            const current = queue.shift();
            if (!current) {
                break;
            }

            if (current.depth > maxDepth) {
                continue;
            }

            let references: ReferenceDescription[];
            try {
                references = await this.browseWithOptions(current.nodeId, {
                    includeNonHierarchical
                });
            } catch (error) {
                console.error(`Error browsing node ${current.nodeId}:`, error);
                continue;
            }

            for (const ref of references) {
                const childNodeId = ref.nodeId.toString();
                const normalized = normalizeNodeIdInput(childNodeId);
                if (visited.has(normalized)) {
                    continue;
                }
                visited.add(normalized);

                if (ref.nodeClass === NodeClass.Variable) {
                    nodes.push({
                        nodeId: childNodeId,
                        displayName: ref.displayName.text || ref.browseName.name || undefined,
                        browseName: ref.browseName.name || undefined
                    });
                    if (nodes.length >= maxNodes) {
                        truncated = true;
                        break outer;
                    }
                } else if (
                    (ref.nodeClass === NodeClass.Object || ref.nodeClass === NodeClass.View) &&
                    current.depth < maxDepth
                ) {
                    queue.push({
                        nodeId: childNodeId,
                        depth: current.depth + 1
                    });
                }
            }
        }

        return { nodes, truncated };
    }

    async getReferences(nodeId: string): Promise<OpcuaReference[]> {
        if (!this.session) {
            throw new Error('Not connected to OPC UA server');
        }

        try {
            const browseDescription: BrowseDescriptionOptions = {
                nodeId: coerceNodeId(nodeId),
                browseDirection: BrowseDirection.Both,
                includeSubtypes: true,
                nodeClassMask: 0,
                resultMask: 63
            };

            const browseResult = await this.session.browse(browseDescription);
            const references: OpcuaReference[] = [];

            if (browseResult.references) {
                for (const ref of browseResult.references) {
                    references.push({
                        referenceTypeId: ref.referenceTypeId.toString(),
                        isForward: ref.isForward,
                        nodeId: ref.nodeId.toString(),
                        browseName: ref.browseName.name || '',
                        displayName: ref.displayName.text || '',
                        nodeClass: NodeClass[ref.nodeClass] || 'Unknown'
                    });
                }
            }

            return references;
        } catch (error) {
            console.error('Error getting references:', error);
            throw error;
        }
    }

    async recursiveBrowse(
        nodeId: string,
        maxDepthOrOptions: number | {
            maxDepth?: number;
            progress?: (info: { processed: number; depth: number; nodeId: string }) => void;
            cancellationToken?: { isCancellationRequested: boolean };
            concurrency?: number;
        } = 10,
        currentDepth: number = 0
    ): Promise<any> {
        const options = typeof maxDepthOrOptions === 'number'
            ? { maxDepth: maxDepthOrOptions }
            : (maxDepthOrOptions ?? {});

        const state = {
            maxDepth: options.maxDepth ?? (typeof maxDepthOrOptions === 'number' ? maxDepthOrOptions : 10),
            concurrency: Math.max(1, options.concurrency ?? 6),
            progress: options.progress,
            cancellationToken: options.cancellationToken,
            processed: 0
        };

        const walk = async (targetNodeId: string, depth: number): Promise<any> => {
            if (depth >= state.maxDepth) {
                return null;
            }

            if (state.cancellationToken?.isCancellationRequested) {
                throw new Error('Operation cancelled');
            }

            let nodeInfo: OpcuaNodeInfo;
            try {
                nodeInfo = await this.readNodeAttributes(targetNodeId);
            } catch (error) {
                console.error('Error reading node attributes during recursive browse:', error);
                return null;
            }

            state.processed += 1;
            try {
                state.progress?.({
                    processed: state.processed,
                    depth,
                    nodeId: targetNodeId
                });
            } catch (progressError) {
                console.warn('Progress callback failed during recursive browse:', progressError);
            }

            const result: any = {
                ...nodeInfo,
                children: []
            };

            if (depth + 1 >= state.maxDepth) {
                return result;
            }

            let children: ReferenceDescription[];
            try {
                children = await this.browse(targetNodeId);
            } catch (error) {
                console.error('Error browsing node during recursive browse:', error);
                return result;
            }

            const childResults = await mapWithConcurrency(
                children,
                state.concurrency,
                async (child) => {
                    if (!child.nodeId) {
                        return null;
                    }
                    if (state.cancellationToken?.isCancellationRequested) {
                        return null;
                    }
                    try {
                        return await walk(child.nodeId.toString(), depth + 1);
                    } catch (error) {
                        console.error('Error walking child node during recursive browse:', error);
                        return null;
                    }
                }
            );

            for (const child of childResults) {
                if (child) {
                    result.children.push(child);
                }
            }

            return result;
        };

        try {
            return await walk(nodeId, currentDepth);
        } catch (error) {
            console.error('Error in recursive browse:', error);
            return null;
        }
    }

    private parseSecurityMode(mode: string): MessageSecurityMode {
        switch (mode.toUpperCase()) {
            case 'NONE':
                return MessageSecurityMode.None;
            case 'SIGN':
                return MessageSecurityMode.Sign;
            case 'SIGNANDENCRYPT':
                return MessageSecurityMode.SignAndEncrypt;
            default:
                return MessageSecurityMode.None;
        }
    }

    private parseSecurityPolicy(policy: string): SecurityPolicy {
        switch (policy.toUpperCase()) {
            case 'NONE':
                return SecurityPolicy.None;
            case 'BASIC128':
                return SecurityPolicy.Basic128;
            case 'BASIC256':
                return SecurityPolicy.Basic256;
            case 'BASIC256SHA256':
                return SecurityPolicy.Basic256Sha256;
            default:
                return SecurityPolicy.None;
        }
    }

    async findNodePathByNodeId(
        targetNodeId: string,
        options?: {
            maxDepth?: number;
            cancellationToken?: { isCancellationRequested: boolean };
        }
    ): Promise<{
        nodeId: string;
        displayName: string;
        browseName: string;
        nodeClass: string;
        path: string;
        nodeIdPath: string[];
        pathSegments: OpcuaNodePathSegment[];
    } | undefined> {
        if (!this.session) {
            throw new Error('Not connected to OPC UA server');
        }

        const normalizedTarget = normalizeNodeIdInput(targetNodeId);
        const maxDepth = options?.maxDepth ?? 20;

        interface QueueItem {
            nodeId: string;
            pathSegments: OpcuaNodePathSegment[];
            depth: number;
        }

        const visited = new Set<string>();
        const queue: QueueItem[] = [
            { nodeId: 'RootFolder', pathSegments: [], depth: 0 }
        ];

        visited.add('RootFolder');

        while (queue.length > 0) {
            if (options?.cancellationToken?.isCancellationRequested) {
                return undefined;
            }

            const current = queue.shift();
            if (!current) {
                break;
            }

            if (current.depth > maxDepth) {
                continue;
            }

            let references: ReferenceDescription[];

            try {
                references = await this.browse(current.nodeId);
            } catch (error) {
                console.error(`Error browsing node ${current.nodeId} during path lookup:`, error);
                continue;
            }

            for (const ref of references) {
                if (options?.cancellationToken?.isCancellationRequested) {
                    return undefined;
                }

                const childNodeId = ref.nodeId.toString();
                const normalizedChildNodeId = normalizeNodeIdInput(childNodeId);

                const displayName = ref.displayName.text || ref.browseName.name || childNodeId;
                const browseName = ref.browseName.name || '';
                const nodeClassText = NodeClass[ref.nodeClass] || 'Unknown';

                const segment: OpcuaNodePathSegment = {
                    nodeId: childNodeId,
                    displayName,
                    browseName,
                    nodeClass: nodeClassText
                };
                const pathSegments = [...current.pathSegments, segment];
                const path = pathSegments.map((item) => item.displayName).join(' > ');
                const nodeIdPath = pathSegments.map((item) => item.nodeId);

                if (normalizedChildNodeId === normalizedTarget) {
                    return {
                        nodeId: childNodeId,
                        displayName,
                        browseName,
                        nodeClass: nodeClassText,
                        path,
                        nodeIdPath,
                        pathSegments
                    };
                }

                if (current.depth < maxDepth) {
                    const canHaveChildren = ref.nodeClass === NodeClass.Object || ref.nodeClass === NodeClass.View;
                    if (canHaveChildren && !visited.has(childNodeId)) {
                        visited.add(childNodeId);
                        queue.push({
                            nodeId: childNodeId,
                            pathSegments,
                            depth: current.depth + 1
                        });
                    }
                }
            }
        }

        return undefined;
    }

    async searchNodes(
        searchTerm: string,
        progressCallback?: (current: number, total: number) => void,
        cancellationToken?: { isCancellationRequested: boolean }
    ): Promise<Array<{
        nodeId: string;
        displayName: string;
        browseName: string;
        nodeClass: string;
        path: string;
        nodeIdPath: string[];
    }>> {
        if (!this.session) {
            throw new Error('Not connected to OPC UA server');
        }

        const results: Array<{
            nodeId: string;
            displayName: string;
            browseName: string;
            nodeClass: string;
            path: string;
            nodeIdPath: string[];
        }> = [];

        const searchTermLower = searchTerm.toLowerCase();
        let searchedNodes = 0;
        let totalNodes = 0;

        // Recursive search helper
        const searchRecursive = async (nodeId: string, path: string = '', nodeIdPath: string[] = [], depth: number = 0): Promise<void> => {
            // Respect cancellation request
            if (cancellationToken?.isCancellationRequested) {
                return;
            }

            // Prevent runaway recursion depth
            if (depth > 20) {
                return;
            }

            try {
                // Browse child references for current node
                const references = await this.browse(nodeId);
                totalNodes += references.length;

                for (const ref of references) {
                    if (cancellationToken?.isCancellationRequested) {
                        return;
                    }

                    searchedNodes++;
                    const displayName = ref.displayName.text || ref.browseName.name || '';
                    const browseName = ref.browseName.name || '';
                    const currentPath = path ? `${path} > ${displayName}` : displayName;
                    const currentNodeIdPath = [...nodeIdPath, ref.nodeId.toString()];

                    // Report progress
                    if (progressCallback) {
                        progressCallback(searchedNodes, totalNodes);
                    }

                    // Match against search term
                    if (
                        displayName.toLowerCase().includes(searchTermLower) ||
                        browseName.toLowerCase().includes(searchTermLower)
                    ) {
                        results.push({
                            nodeId: ref.nodeId.toString(),
                            displayName,
                            browseName,
                            nodeClass: NodeClass[ref.nodeClass] || 'Unknown',
                            path: currentPath,
                            nodeIdPath: currentNodeIdPath
                        });
                    }

                    // Continue recursion for object nodes
                    if (ref.nodeClass === NodeClass.Object) {
                        await searchRecursive(ref.nodeId.toString(), currentPath, currentNodeIdPath, depth + 1);
                    }
                }
            } catch (error) {
                // Ignore individual node errors and continue
                console.error(`Error searching node ${nodeId}:`, error);
            }
        };

        try {
            // Start search from root node
            await searchRecursive('RootFolder', '');
        } catch (error) {
            console.error('Error in search:', error);
            throw error;
        }

        return results;
    }
}
