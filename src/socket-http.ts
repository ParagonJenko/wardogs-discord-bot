import type { HttpClient, HttpResponse } from './rcon.ts';

// Cloudflare Workers' fetch() cannot reach a bare IP address or a custom port such as 7776,
// which is how game hosts hand out RCON. Raw TCP sockets can, so this speaks just enough HTTP/1.1.

type Socket = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close: () => Promise<void>;
};

export type Connect = (
  address: { hostname: string; port: number },
  options: { secureTransport: 'on' | 'off'; allowHalfOpen: boolean },
) => Socket;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HEADER_END = encoder.encode('\r\n\r\n');

const indexOf = (bytes: Uint8Array, pattern: Uint8Array, from = 0): number => {
  for (let i = from; i <= bytes.length - pattern.length; i++) {
    if (pattern.every((byte, j) => bytes[i + j] === byte)) return i;
  }
  return -1;
};

const dechunk = (bytes: Uint8Array): Uint8Array => {
  const parts: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const lineEnd = indexOf(bytes, encoder.encode('\r\n'), offset);
    if (lineEnd === -1) break;
    const size = parseInt(decoder.decode(bytes.subarray(offset, lineEnd)).split(';')[0] ?? '', 16);
    if (!size) break;
    parts.push(bytes.subarray(lineEnd + 2, lineEnd + 2 + size));
    offset = lineEnd + 2 + size + 2;
  }
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  parts.reduce((position, part) => (out.set(part, position), position + part.length), 0);
  return out;
};

const parseResponse = (raw: Uint8Array): HttpResponse => {
  const headerEnd = indexOf(raw, HEADER_END);
  const head = decoder.decode(headerEnd === -1 ? raw : raw.subarray(0, headerEnd));
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1];
  if (headerEnd === -1 || status === undefined) {
    throw new Error('RCON did not answer with HTTP; check RCON_URL');
  }

  const headers = new Map(
    head
      .split('\r\n')
      .slice(1)
      .map((line) => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()] as const;
      }),
  );
  const rest = raw.subarray(headerEnd + HEADER_END.length);
  const length = Number(headers.get('content-length'));
  const body = headers.get('transfer-encoding')?.toLowerCase().includes('chunked')
    ? dechunk(rest)
    : Number.isFinite(length) && headers.has('content-length')
      ? rest.subarray(0, length)
      : rest;

  return { status: Number(status), body: decoder.decode(body) };
};

// The largest answer the bot reads. ServerSettings.ini is the biggest the game sends; anything far larger is not a
// game server, and reading it all could run the Worker out of memory.
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const readAll = async (readable: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> => {
  const reader = readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw new Error(`RCON answer was larger than ${maxBytes} bytes`);
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(total);
  parts.reduce((position, part) => (out.set(part, position), position + part.length), 0);
  return out;
};

const withTimeout = <T>(work: Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`RCON request timed out after ${timeoutMs}ms`)), timeoutMs);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });

export const socketHttp =
  (connect: Connect, timeoutMs = 8_000, maxBytes = MAX_RESPONSE_BYTES): HttpClient =>
  async (url, headers, body, method) => {
    const secure = url.protocol === 'https:';
    const socket = connect(
      { hostname: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || (secure ? 443 : 80) },
      { secureTransport: secure ? 'on' : 'off', allowHalfOpen: false },
    );
    const payload = body === undefined ? undefined : encoder.encode(body);
    const typed = Object.keys(headers).some((name) => name.toLowerCase() === 'content-type');
    const request = [
      `${method ?? (payload ? 'POST' : 'GET')} ${url.pathname}${url.search} HTTP/1.1`,
      `Host: ${url.host}`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      ...(payload ? [...(typed ? [] : ['Content-Type: application/json']), `Content-Length: ${payload.length}`] : []),
      'Connection: close',
      '',
      '',
    ].join('\r\n');

    const exchange = async (): Promise<HttpResponse> => {
      const writer = socket.writable.getWriter();
      await writer.write(encoder.encode(request));
      if (payload) await writer.write(payload);
      writer.releaseLock();
      // "Connection: close" makes the server close the socket after the response, so read to the end.
      return parseResponse(await readAll(socket.readable, maxBytes));
    };

    try {
      return await withTimeout(exchange(), timeoutMs);
    } finally {
      await socket.close().catch(() => undefined);
    }
  };
