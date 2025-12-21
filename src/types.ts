import { NodeId } from 'node-opcua';

export interface OpcuaConnectionConfig {
    id: string;
    name: string;
    endpointUrl: string;
    securityMode: string;
    securityPolicy: string;
    authType: 'Anonymous' | 'UserPassword' | 'Certificate';
    username?: string;
    password?: string;
    // Certificate authentication fields
    clientCertificatePath?: string;
    clientPrivateKeyPath?: string;
}

export interface OpcuaNodeInfo {
    nodeId: string;
    browseName: string;
    displayName: string;
    nodeClass: string;
    value?: any;
    dataType?: string;
    accessLevel?: number;
    userAccessLevel?: number;
    description?: string;
    statusCode?: string;
    sourceTimestamp?: string;
    serverTimestamp?: string;
}

export interface OpcuaReference {
    referenceTypeId: string;
   isForward: boolean;
    nodeId: string;
    browseName: string;
    displayName: string;
    nodeClass: string;
}

export interface OpcuaNodePathSegment {
    nodeId: string;
    displayName: string;
    browseName?: string;
    nodeClass?: string;
}

export interface SearchResultItem {
    connectionId: string;
    connectionName: string;
    nodeId: string;
    displayName: string;
    browseName: string;
    nodeClass: string;
    path: string;
    nodeIdPath: string[];
    pathSegments?: OpcuaNodePathSegment[];
}

export enum ConnectionStatus {
    Disconnected = 'disconnected',
    Connecting = 'connecting',
    Connected = 'connected',
    Error = 'error'
}
