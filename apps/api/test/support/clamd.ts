import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** The standard antivirus test string (harmless; every scanner detects it). */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * Starts a real clamd with a single custom signature (the EICAR test string anywhere in a
 * file), so scanning is exercised end to end without downloading signature databases.
 * Requires the `clamd` binary (apt: clamav-daemon).
 */
export async function startClamd(): Promise<{ port: number; stop(): Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'onetappe-clamd-'));
  const port = await freePort();
  await writeFile(
    path.join(dir, 'onetappe-test.ndb'),
    `OneTappe.Test.EICAR:0:*:${Buffer.from(EICAR).toString('hex')}\n`,
  );
  const config = path.join(dir, 'clamd.conf');
  await writeFile(
    config,
    [
      'Foreground yes',
      `DatabaseDirectory ${dir}`,
      `TCPSocket ${String(port)}`,
      'TCPAddr 127.0.0.1',
      `PidFile ${path.join(dir, 'clamd.pid')}`,
      'StreamMaxLength 10M',
      'LogVerbose no',
    ].join('\n'),
  );
  let child: ChildProcess;
  try {
    child = spawn('clamd', ['--config-file', config], { stdio: 'ignore' });
  } catch (error) {
    throw new Error('clamd could not be started (install clamav-daemon)', { cause: error });
  }
  await new Promise<void>((resolve, reject) => {
    child.once('error', (error) => {
      reject(new Error(`clamd could not be started (install clamav-daemon): ${error.message}`));
    });
    const started = Date.now();
    const probe = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', () => {
        if (Date.now() - started > 30_000) reject(new Error('clamd did not start within 30s'));
        else setTimeout(probe, 200);
      });
    };
    probe();
  });
  return {
    port,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
  });
}
