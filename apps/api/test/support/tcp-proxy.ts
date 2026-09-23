import net from 'node:net';

/**
 * A TCP proxy between the application and PostgreSQL that a test can break on purpose,
 * the way a database restart, failover or network partition would:
 *   - `cut()`       drops every open connection and refuses new ones (server down);
 *   - `blackhole()` accepts connections but never answers (network partition);
 *   - `restore()`   forwards traffic again.
 */
export class FaultyTcpProxy {
  private mode: 'forward' | 'refuse' | 'blackhole' = 'forward';
  private readonly sockets = new Set<net.Socket>();
  private readonly server: net.Server;

  private constructor(
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {
    this.server = net.createServer((client) => {
      this.track(client);
      if (this.mode === 'refuse') {
        client.destroy();
        return;
      }
      if (this.mode === 'blackhole') return; // hold the socket open, say nothing
      const upstream = net.connect(this.targetPort, this.targetHost);
      this.track(upstream);
      client.pipe(upstream).pipe(client);
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on('error', close);
      upstream.on('error', close);
      client.on('close', close);
      upstream.on('close', close);
    });
  }

  static async start(targetUrl: string): Promise<{ proxy: FaultyTcpProxy; url: string }> {
    const target = new URL(targetUrl);
    const proxy = new FaultyTcpProxy(target.hostname, Number(target.port || 5432));
    await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
    const { port } = proxy.server.address() as net.AddressInfo;
    const url = new URL(targetUrl);
    url.hostname = '127.0.0.1';
    url.port = String(port);
    return { proxy, url: url.toString() };
  }

  cut(): void {
    this.mode = 'refuse';
    this.dropAll();
  }

  blackhole(): void {
    this.mode = 'blackhole';
    this.dropAll();
  }

  restore(): void {
    this.mode = 'forward';
  }

  /** Drops open connections but keeps forwarding new ones (e.g. idle connections killed). */
  dropAll(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  async close(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  private track(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => {
      this.sockets.delete(socket);
    });
    socket.on('error', () => undefined);
  }
}
