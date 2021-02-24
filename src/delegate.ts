import { IncomingMessage, ServerResponse } from 'http';
import net from 'net';
import { SocksProxy, SocksClient, SocksClientOptions } from 'socks';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent, HttpsProxyAgentOptions } from 'https-proxy-agent';
import { Agent } from 'agent-base';

const debug = require('debug')('delegate');

export type DelegateLookup = (target: string) => Promise<Delegate>;

export type ConnectOptions = net.TcpSocketConnectOpts & { req: IncomingMessage, res: ServerResponse };
export type onConnectCallback = (res: ServerResponse, socket: net.Socket, needToRespond: boolean) => void;

export type Delegate = {
    agent?: Agent,
    connect: (opts: ConnectOptions, onConnect: onConnectCallback) => Promise<net.Socket>
}

export const StaticLookup = (delegate: Delegate): DelegateLookup => {
    return () => Promise.resolve(delegate);
};

export const DirectDelegate: Delegate = {
	connect: (opts, onConnect) => {
        const port = opts.port;
        const host = opts.host;
        return new Promise((resolve, reject) => {
            debug("Connecting to %s:%s", host, port);
            const socket = net.connect(port, host);
            socket.on('connect', () => {
                debug("Conneced established with %s:%s", host, port);
                onConnect(opts.res, socket, true);
                resolve(socket);
            });
            socket.on('error', reject);
        });
	}
};

export const socksDelegate = (proxy: SocksProxy): Delegate => {
    const { ipaddress, ...agentOpts } = proxy;
    const agent = new SocksProxyAgent(agentOpts);
    return {
        agent, 
        connect: async (opts, onConnect) => {
			const options: SocksClientOptions = {
				proxy,
				command: "connect",
				destination: {
					host: opts.host || "localhost",
					port: opts.port
				}
			}
			const client = await SocksClient.createConnection(options);
            onConnect(opts.res, client.socket, true);
			return client.socket;
		}
	};
};

export const httpDelegate = (agentOpts: HttpsProxyAgentOptions): Delegate => {
    const securedProxy = agentOpts.secureProxy;
    const agent = securedProxy ? 
                new HttpsProxyAgent(agentOpts) : 
                new HttpProxyAgent(agentOpts);
    return {
        agent, 
        connect: (opts, onConnect) => {
            const host = agentOpts.host || "localhost";
            const port: number = (agentOpts.port) ? +agentOpts.port : 80;
            const req = opts.req;
            debug('Tunneling to %s via proxy %s:%d', req.url, host, port);
            return new Promise((resolve, reject) => {
                const socket = net.connect(port, host);
                socket.on('connect', () => {
                    debug(`CONNECT ${req.url} HTTP/${req.httpVersion}`);
                    socket.write(`CONNECT ${req.url} HTTP/${req.httpVersion}\r\n`);
                    // Convey original headers
                    Object.entries(req.headers).forEach(([header, value]) => {
                      debug(`${header}: ${value}`);
                      socket.write(`${header}: ${value}\r\n`)
                    })
                    // TODO: add authentication for proxy
                    if (agentOpts.auth) {
                        debug('setting proxy authorization header')
                        socket.write(`Proxy-Authorization: ${agentOpts.auth}\r\n`)
                    }
                    socket.write('\r\n');
                    onConnect(opts.res, socket, false);
                    resolve(socket);
                });
                socket.on('error', reject);
            });
        }
    }
}