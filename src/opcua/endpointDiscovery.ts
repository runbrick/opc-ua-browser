import { OPCUAClient, EndpointDescription } from 'node-opcua';

export interface DiscoveredEndpoint {
    endpointUrl: string;
    securityMode: string;
    securityPolicy: string;
}

export async function discoverEndpoints(endpointUrl: string): Promise<DiscoveredEndpoint[]> {
    let client: OPCUAClient | undefined;
    try {
        client = OPCUAClient.create({
            endpoint_must_exist: false,
            connectionStrategy: {
                maxRetry: 0,
                initialDelay: 1000
            }
        });

        await client.connect(endpointUrl);
        const endpoints = await client.getEndpoints();

        return endpoints.map((endpoint: EndpointDescription): DiscoveredEndpoint => ({
            endpointUrl: endpoint.endpointUrl || '',
            securityMode: endpoint.securityMode.toString(),
            securityPolicy: endpoint.securityPolicyUri?.split('#')[1] || 'None'
        }));
    } catch (error) {
        console.error('Error discovering OPC UA endpoints:', error);
        return [];
    } finally {
        if (client) {
            try {
                await client.disconnect();
            } catch (disconnectError) {
                console.error('Error disconnecting from OPC UA endpoint discovery client:', disconnectError);
            }
        }
    }
}
