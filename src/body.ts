// A request's JSON body, or undefined when it is not JSON or is over `limit` bytes. The body is read a chunk at a time
// and dropped once past the limit, so one sent without a length is never held whole.
export const readJsonBody = async (request: Request, limit: number): Promise<unknown> => {
  if (Number(request.headers.get('content-length') ?? 0) > limit) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  for (;;) {
    const read = reader === undefined ? { done: true as const } : await reader.read();
    if (read.done) break;
    size += read.value.byteLength;
    if (size > limit) {
      await reader?.cancel();
      return undefined;
    }
    chunks.push(read.value);
  }
  const body = new Uint8Array(size);
  chunks.reduce((at, chunk) => (body.set(chunk, at), at + chunk.byteLength), 0);
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
};
