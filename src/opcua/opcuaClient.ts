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
    BrowseDescriptionOptions
} from 'node-opcua';
import { OpcuaConnectionConfig, OpcuaNodeInfo, OpcuaReference, ConnectionStatus } from '../types';

export class OpcuaClient {
    private client: OPCUAClient | null = null;
    private session: ClientSession | null = null;
    private config: OpcuaConnectionConfig;
    private _status: ConnectionStatus = ConnectionStatus.Disconnected;

    constructor(config: OpcuaConnectionConfig) {
        this.config = config;
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
                referenceTypeId: undefined,
                browseDirection: BrowseDirection.Forward,
                includeSubtypes: true,
                nodeClassMask: 0,
                resultMask: 63
            };

            const browseResult = await this.session.browse(browseDescription);

            console.log(`Browsed node ${nodeId}, found ${browseResult.references?.length || 0} references`);

            return browseResult.references || [];
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
                userAccessLevel: dataValues[7].value?.value
            };

            return nodeInfo;
        } catch (error) {
            console.error('Error reading node attributes:', error);
            throw error;
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
}
