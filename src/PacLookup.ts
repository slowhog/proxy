import crypto from 'crypto';
import getUri from 'get-uri';
import createDebug from 'debug';
import getRawBody from 'raw-body';
import { Readable } from 'stream';
import createPacResolver, { FindProxyForURL } from 'pac-resolver';
import { Delegate, DelegateLookup,
	DirectDelegate, httpDelegate, socksDelegate 
} from './delegate';
import { Agent, AgentOptions, AgentCallbackReturn,
	ClientRequest, RequestOptions 
} from 'agent-base';
import net from 'net';
import tls from 'tls';
import once from '@tootallnate/once';

const debug = createDebug('pac-delegate');

type ProxyKind = 'DIRECT' | 'PROXY' | 
    'SOCKS' | 'SOCKS4' | 'SOCKS5' | 'HTTP' | 'HTTPS';

type ProxyOptions = {
    verb: ProxyKind,
    host?: string,
	port?: number,
    userId?: string,
    password?: string
}

interface CachedPacResolverOptions extends createPacResolver.PacResolverOptions {
    // minutes before reloading pac file
    ttl?: number
};

/**
 * The `CachedPacResolver` class.
 *
 * A few different "protocol" modes are supported (supported protocols are
 * backed by the `get-uri` module):
 *
 * @api public
 */
export class CachedPacResolver {
	uri: string;
	opts: CachedPacResolverOptions;
	cache?: Readable;
	resolver?: FindProxyForURL;
	resolverHash: string;
	resolverPromise?: Promise<FindProxyForURL>;

	constructor(uri: string, opts: CachedPacResolverOptions) { 
		debug('Creating PacDelegate with URI %o and options %o', uri, opts);

		this.uri = uri;
		this.opts = { ...opts };
		this.cache = undefined;
		this.resolver = undefined;
		this.resolverHash = '';
		this.resolverPromise = undefined;

		// For `PacResolver`
		if (!this.opts.filename) {
			this.opts.filename = uri;
		}
	}

	private clearResolverPromise = (): void => {
		this.resolverPromise = undefined;
	};

    private clearAfterTTL = (): void => {
        if (this.opts.ttl) {
            setTimeout(this.clearResolverPromise, this.opts.ttl * 60 * 1000);
        } else if (this.opts.ttl === 0) {
            this.clearResolverPromise();
        } else if (this.opts.ttl === undefined) {
            setTimeout(this.clearResolverPromise, 60 * 60 * 1000);
        }
    };

	/**
	 * Loads the PAC proxy file from the source if necessary, and returns
	 * a generated `FindProxyForURL()` resolver function to use.
	 *
	 * @api private
	 */
	private getResolver(): Promise<FindProxyForURL> {
		if (!this.resolverPromise) {
			this.resolverPromise = this.loadResolver();
			this.resolverPromise.then(
				this.clearAfterTTL,
				this.clearResolverPromise
			);
		}
		return this.resolverPromise;
	}

	private async loadResolver(): Promise<FindProxyForURL> {
		try {
			// (Re)load the contents of the PAC file URI
			const code = await this.loadPacFile();

			// Create a sha1 hash of the JS code
			const hash = crypto
				.createHash('sha1')
				.update(code)
				.digest('hex');

			if (this.resolver && this.resolverHash === hash) {
				debug(
					'Same sha1 hash for code - contents have not changed, reusing previous proxy resolver'
				);
				return this.resolver;
			}

			// Cache the resolver
			debug('Creating new proxy resolver instance');
			this.resolver = createPacResolver(code, this.opts);

			// Store that sha1 hash for future comparison purposes
			this.resolverHash = hash;

			return this.resolver;
		} catch (err) {
			if (this.resolver && err.code === 'ENOTMODIFIED') {
				debug(
					'Got ENOTMODIFIED response, reusing previous proxy resolver'
				);
				return this.resolver;
			}
			throw err;
		}
	}

	/**
	 * Loads the contents of the PAC proxy file.
	 *
	 * @api private
	 */
	private async loadPacFile(): Promise<string> {
		debug('Loading PAC file: %o', this.uri);

		const rs = await getUri(this.uri, { cache: this.cache });
		debug('Got `Readable` instance for URI');
		this.cache = rs;

		const buf = await getRawBody(rs);
		debug('Read %o byte PAC file from URI', buf.length);

		return buf.toString('utf8');
	}

	public async resolve(url: string): Promise<ProxyOptions[]> { 
		// First, get a generated `FindProxyForURL()` function,
		// either cached or retrieved from the source
		const resolver = await this.getResolver();

		debug('url: %o', url);
		let result = await resolver(url);

		// Default to "DIRECT" if a falsey value was returned (or nothing)
		if (!result) {
			result = 'DIRECT';
		}

		const proxies = String(result)
			.trim()
			.split(/\s*;\s*/g)
			.filter(Boolean);

		return proxies.map(proxy => {
			const [verb, target] = proxy.split(/\s+/);
			debug('Find proxy: %o', proxy);
			if (verb === 'DIRECT') {
				return { verb };
			} else {
				var parts = target.split(':');
				return {
					verb: verb as ProxyKind,
					host: parts[0],
					port: +parts[1]
				};
			}
		});
	}
};

export const createPacLookup = (pacUrl: string, opts: CachedPacResolverOptions): DelegateLookup => {
	const resolver = new CachedPacResolver(pacUrl, opts);
	return async (target) => {
		const proxies = await resolver.resolve(target);
		const delegate = createProxiesDelegate(proxies, opts);
		return delegate;
	};
};

export const createProxiesDelegate = (proxies: ProxyOptions[], opts: AgentOptions): Delegate => {
	const delegates = proxies.map(createDelegate);
	return {
		agent: new ProxiesAgent(delegates, opts),
		connect: async (opts, onConnect) => {
			let lastError;
			for (const delegate of delegates) {
				debug("Connecting %s:%s ...", opts.host, opts.port);
				try {
					const socket = await delegate.connect(opts, (res, socket, needToRespond) => {
						onConnect(res, socket, needToRespond);
					})
					return socket;
				} catch (error) {
					lastError = error;
					debug("Error %o", error);
					continue;
				}
			}
			debug("Exhausted proxies, throw error from last attempt");
			throw lastError;
		}
	};
};

export const createDelegate = (opts: ProxyOptions): Delegate => {
	const { verb } = opts;
	const host = opts.host || 'localhost';
	const port = opts.port || 8888;

	switch (verb) {
		case 'DIRECT': 
			// Direct connection to the destination endpoint
			return DirectDelegate;
		case 'SOCKS':
		case 'SOCKS5':
			return socksDelegate({ host, port, type: 5 });
		case 'SOCKS4':
			return socksDelegate({ host, port, type: 4 });
		case 'PROXY':
		case 'HTTP':
			return httpDelegate({ host, port, protocol: 'http:', secureProxy: false});
		case 'HTTPS':
			return httpDelegate({ host, port, protocol: 'https:', secureProxy: true});
		default:
			throw new Error(`Unsupported proxy type: ${verb}`);
	};
};

export class ProxiesAgent extends Agent {
	proxies: Delegate[];
	constructor(proxies: Delegate[], opts: AgentOptions) {
		super(opts);
		this.proxies = proxies;
	}

	/**
	 * Called when the node-core HTTP client library is creating a new HTTP request.
	 *
	 * @api protected
	 */
	async callback(
		req: ClientRequest,
		opts: RequestOptions
	): Promise<AgentCallbackReturn> {
		const { secureEndpoint } = opts;
		for (const proxy of this.proxies) {
			const agent = proxy.agent;
			try {
				if (!agent) {
					// "DIRECT" connection, wait for connection confirmation
					const socket = secureEndpoint ? tls.connect(opts) : net.connect(opts);
					await once(socket, 'connect');
					req.emit('proxy', { proxy, socket });
					return socket;
				}
				if (agent) {
					const s = await agent.callback(req, opts);
					req.emit('proxy', { proxy, socket: s });
					return s;
				}
				throw new Error(`Could not determine proxy type for: ${proxy}`);
			} catch (err) {
				debug('Got error for proxy %o: %o', proxy, err);
				req.emit('proxy', { proxy, error: err });
			}
		}
		throw new Error(`Failed to establish a socket connection to proxies`);
	};
};

export { createPacLookup as default };