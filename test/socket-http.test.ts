import { describe, expect, it } from 'vitest';
import { socketGet, type Connect } from '../src/socket-http.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// A fake TCP socket: records what was written and answers with the given chunks, then closes.
const fakeServer = (chunks: string[] | 'hang') => {
  const written: string[] = [];
  const calls: { address: { hostname: string; port: number }; secureTransport: string }[] = [];
  let closed = false;
  const connect: Connect = (address, options) => {
    calls.push({ address, secureTransport: options.secureTransport });
    return {
      writable: new WritableStream<Uint8Array>({
        write: (chunk) => {
          written.push(decoder.decode(chunk));
        },
      }),
      readable: new ReadableStream<Uint8Array>({
        start: (controller) => {
          if (chunks === 'hang') return;
          chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
          controller.close();
        },
      }),
      close: async () => {
        closed = true;
      },
    };
  };
  return { connect, written, calls, isClosed: () => closed };
};

const url = new URL('http://203.0.113.10:7776/v1/status');

describe('socketGet', () => {
  it('connects to the host and port and sends a GET with the given headers', async () => {
    const server = fakeServer(['HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}']);

    await socketGet(server.connect)(url, { Authorization: 'Bearer secret' });

    expect(server.calls).toEqual([{ address: { hostname: '203.0.113.10', port: 7776 }, secureTransport: 'off' }]);
    const request = server.written.join('');
    expect(request).toMatch(/^GET \/v1\/status HTTP\/1\.1\r\n/);
    expect(request).toContain('Host: 203.0.113.10:7776\r\n');
    expect(request).toContain('Authorization: Bearer secret\r\n');
    expect(request).toContain('Connection: close\r\n');
    expect(request.endsWith('\r\n\r\n')).toBe(true);
  });

  it('returns the status and body of a Content-Length response split across packets', async () => {
    const body = JSON.stringify({ players: { current: 3, max: 98 } });
    const server = fakeServer([`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Len`, `gth: ${body.length}\r\n\r\n${body.slice(0, 5)}`, body.slice(5)]);

    await expect(socketGet(server.connect)(url, {})).resolves.toEqual({ status: 200, body });
  });

  it('decodes a chunked response', async () => {
    const server = fakeServer(['HTTP/1.1 401 Unauthorized\r\nTransfer-Encoding: chunked\r\n\r\n4\r\n{"er\r\n', 'a\r\nror":"no"}\r\n0\r\n\r\n']);

    await expect(socketGet(server.connect)(url, {})).resolves.toEqual({ status: 401, body: '{"error":"no"}' });
  });

  it('uses TLS and port 443 for https URLs', async () => {
    const server = fakeServer(['HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n']);

    await socketGet(server.connect)(new URL('https://rcon.example.com/v1/status'), {});

    expect(server.calls).toEqual([{ address: { hostname: 'rcon.example.com', port: 443 }, secureTransport: 'on' }]);
  });

  it('gives up and closes the socket when the server never answers', async () => {
    const server = fakeServer('hang');

    await expect(socketGet(server.connect, 20)(url, {})).rejects.toThrow(/timed out/);
    expect(server.isClosed()).toBe(true);
  });

  it('rejects a response that is not HTTP', async () => {
    const server = fakeServer(['SSH-2.0-OpenSSH_9.6\r\n']);

    await expect(socketGet(server.connect)(url, {})).rejects.toThrow(/HTTP/);
  });
});
