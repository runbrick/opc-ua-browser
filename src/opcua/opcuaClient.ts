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
import { OpcuaConnectionConfig, OpcuaNodeInfo, OpcuaReference, ConnectionStatus } from '../types';
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
            // 处理特殊的 RootFolder 标识符
            let actualNodeId = nodeId;
            if (nodeId === 'RootFolder' || nodeId === 'i=84') {
                actualNodeId = 'i=84'; // RootFolder 的标准 NodeId
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

    async recursiveBrowse(nodeId: string, maxDepth: number = 10, currentDepth: number = 0): Promise<any> {
        if (currentDepth >= maxDepth) {
            return null;
        }

        try {
            const nodeInfo = await this.readNodeAttributes(nodeId);
            const children = await this.browse(nodeId);

            const result: any = {
                ...nodeInfo,
                children: []
            };

            for (const child of children) {
                const childData = await this.recursiveBrowse(
                    child.nodeId.toString(),
                    maxDepth,
                    currentDepth + 1
                );
                if (childData) {
                    result.children.push(childData);
                }
            }

            return result;
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
    } | undefined> {
        if (!this.session) {
            throw new Error('Not connected to OPC UA server');
        }

        const normalizedTarget = normalizeNodeIdInput(targetNodeId);
        const maxDepth = options?.maxDepth ?? 20;

        interface QueueItem {
            nodeId: string;
            path: string;
            nodeIdPath: string[];
            depth: number;
        }

        const visited = new Set<string>();
        const queue: QueueItem[] = [
            { nodeId: 'RootFolder', path: '', nodeIdPath: [], depth: 0 }
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
                const path = current.path ? `${current.path} > ${displayName}` : displayName;
                const nodeIdPath = [...current.nodeIdPath, childNodeId];

                if (normalizedChildNodeId === normalizedTarget) {
                    return {
                        nodeId: childNodeId,
                        displayName,
                        browseName,
                        nodeClass: NodeClass[ref.nodeClass] || 'Unknown',
                        path,
                        nodeIdPath
                    };
                }

                if (current.depth < maxDepth) {
                    const canHaveChildren = ref.nodeClass === NodeClass.Object || ref.nodeClass === NodeClass.View;
                    if (canHaveChildren && !visited.has(childNodeId)) {
                        visited.add(childNodeId);
                        queue.push({
                            nodeId: childNodeId,
                            path,
                            nodeIdPath,
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

        // 递归搜索函数
        const searchRecursive = async (nodeId: string, path: string = '', nodeIdPath: string[] = [], depth: number = 0): Promise<void> => {
            // 检查取消标志
            if (cancellationToken?.isCancellationRequested) {
                return;
            }

            // 限制搜索深度以避免无限递归
            if (depth > 20) {
                return;
            }

            try {
                // 浏览当前节点的子节点
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

                    // 报告进度
                    if (progressCallback) {
                        progressCallback(searchedNodes, totalNodes);
                    }

                    // 检查是否匹配搜索词
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

                    // 如果是对象类型，继续递归搜索
                    if (ref.nodeClass === NodeClass.Object) {
                        await searchRecursive(ref.nodeId.toString(), currentPath, currentNodeIdPath, depth + 1);
                    }
                }
            } catch (error) {
                // 忽略单个节点的错误，继续搜索
                console.error(`Error searching node ${nodeId}:`, error);
            }
        };

        try {
            // 从根节点开始搜索
            await searchRecursive('RootFolder', '');
        } catch (error) {
            console.error('Error in search:', error);
            throw error;
        }

        return results;
    }
}
