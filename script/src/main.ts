type WorkersKVNamespace = {
  get<T> (key: string, encoding: 'json'): Promise<T>;
  get (key: string, encoding: 'text'): Promise<string>;
  get (key: string, encoding: 'arrayBuffer'): Promise<ArrayBuffer>;
}

// Set by Cloudflare.
declare var KV: WorkersKVNamespace;
// Set by Cloudflare to the WebAssembly module that was uploaded alongside this script.
declare var QUERY_RUNNER_WASM: WebAssembly.Module;

// Following variables are set by build/js.rs.
// Maximum amount of bytes a query can be.
declare var MAX_QUERY_BYTES: number;
// Maximum amount of terms a query can have across all modes.
declare var MAX_QUERY_TERMS: number;

const exists = <V> (val: V | undefined): val is V => val !== undefined;

// Easy reading and writing of memory sequentially without having to manage and update offsets/positions/pointers.
class MemoryWalker {
  private readonly dataView: DataView;
  private readonly uint8Array: Uint8Array;

  constructor (
    readonly buffer: ArrayBuffer,
    private next: number = 0,
  ) {
    this.dataView = new DataView(buffer);
    this.uint8Array = new Uint8Array(buffer);
  }

  jumpTo (ptr: number): this {
    this.next = ptr;
    return this;
  }

  forkAndJump (ptr: number): MemoryWalker {
    return new MemoryWalker(this.buffer, ptr);
  }

  skip (bytes: number): this {
    this.next += bytes;
    return this;
  }

  readAndDereferencePointer (): MemoryWalker {
    return new MemoryWalker(this.buffer, this.readUInt32LE());
  }

  readSlice (len: number): ArrayBuffer {
    return this.buffer.slice(this.next, this.next += len);
  }

  readBoolean (): boolean {
    return !!this.dataView.getUint8(this.next++);
  }

  readUInt8 (): number {
    return this.dataView.getUint8(this.next++);
  }

  readInt32LE (): number {
    const val = this.dataView.getInt32(this.next, true);
    this.next += 4;
    return val;
  }

  readInt32BE (): number {
    const val = this.dataView.getInt32(this.next, false);
    this.next += 4;
    return val;
  }

  readUInt32LE (): number {
    const val = this.dataView.getUint32(this.next, true);
    this.next += 4;
    return val;
  }

  readUInt32BE (): number {
    const val = this.dataView.getUint32(this.next, false);
    this.next += 4;
    return val;
  }

  readInt64LE (): bigint {
    const val = this.dataView.getBigInt64(this.next, true);
    this.next += 8;
    return val;
  }

  readUInt64LE (): bigint {
    const val = this.dataView.getBigUint64(this.next, true);
    this.next += 8;
    return val;
  }

  readDoubleLE (): number {
    const val = this.dataView.getFloat64(this.next, true);
    this.next += 8;
    return val;
  }

  readNullTerminatedString (): string {
    let end = this.next;
    while (this.uint8Array[end]) {
      end++;
    }
    const val = textDecoder.decode(this.uint8Array.slice(this.next, end));
    this.next = end + 1;
    return val;
  }

  writeUInt32LE (val: number): this {
    this.dataView.setUint32(this.next, val, true);
    this.next += 4;
    return this;
  }

  writeAll (src: Uint8Array): this {
    this.uint8Array.set(src, this.next);
    this.next += src.byteLength;
    return this;
  }
}

const SPECIFIER_PARSERS: { length: Set<string>, type: Set<string>, parse: (mem: MemoryWalker) => number | bigint | string }[] = [
  {length: new Set(['hh', 'h', 'l', 'z', 't', '']), type: new Set('dic'), parse: mem => mem.readInt32LE()},
  {length: new Set(['hh', 'h', 'l', 'z', 't', '']), type: new Set('uxXop'), parse: mem => mem.readUInt32LE()},
  {length: new Set(['ll', 'j']), type: new Set('di'), parse: mem => mem.readInt64LE()},
  {length: new Set(['ll', 'j']), type: new Set('uxXop'), parse: mem => mem.readUInt64LE()},
  {length: new Set(['L', '']), type: new Set('fFeEgGaA'), parse: mem => mem.readDoubleLE()},
  {length: new Set(), type: new Set('s'), parse: mem => mem.readAndDereferencePointer().readNullTerminatedString()},
  {length: new Set(), type: new Set('%'), parse: () => '%'},
];

const SPECIFIER_FORMATTERS = {
  '%': () => '%',
  d: (val: number | bigint) => val.toString(),
  i: (val: number | bigint) => val.toString(),
  u: (val: number | bigint) => val.toString(),
  f: (val: number) => val.toLocaleString('fullwide', {useGrouping: false, maximumFractionDigits: 20}),
  F: (val: number) => val.toLocaleString('fullwide', {useGrouping: false, maximumFractionDigits: 20}).toUpperCase(),
  e: (val: number) => val.toExponential(2),
  E: (val: number) => val.toExponential(2).toUpperCase(),
  g: (val: number) => val.toString(),
  G: (val: number) => val.toString().toUpperCase(),
  x: (val: number | bigint) => val.toString(16),
  X: (val: number | bigint) => val.toString(16).toUpperCase(),
  o: (val: number | bigint) => val.toString(8),
  s: (val: string) => val,
  c: (val: number) => String.fromCharCode(val),
  p: (val: number | bigint) => val.toString(16),
  a: (val: number) => val.toString(16),
  A: (val: number) => val.toString(16).toUpperCase(),
};

const formatFromVarargs = (mem: MemoryWalker): string => mem
  .readAndDereferencePointer()
  .readNullTerminatedString()
  .replace(/%([-+ 0'#]*)((?:[0-9]+|\*)?)((?:\.(?:[0-9]+|\*))?)((?:hh|h|l|ll|L|z|j|t|I|I32|I64|q)?)([%diufFeEgGxXoscpaA])/g, ((spec, flags, width, precision, length, type) => {
    // These aren't used in our C code right now but we can implement later on if we do.
    if (flags || width || precision) {
      throw new Error(`Unsupported format specifier "${spec}"`);
    }

    const parser = SPECIFIER_PARSERS.find(p => p.length.has(length) && p.type.has(type));
    if (!parser) {
      throw new SyntaxError(`Invalid format specifier "${spec}"`);
    }
    const rawValue = parser.parse(mem);

    return SPECIFIER_FORMATTERS[type](rawValue);
  }));

const wasmMemory = new WebAssembly.Memory({initial: 2048});

const wasmInstance = new WebAssembly.Instance(QUERY_RUNNER_WASM, {
  env: {
    _wasm_import_log (argsPtr: number) {
      console.log(formatFromVarargs(queryRunnerMemory.forkAndJump(argsPtr)));
    },
    _wasm_import_error (argsPtr: number) {
      throw new Error(`[fprintf] ${formatFromVarargs(queryRunnerMemory.forkAndJump(argsPtr))}`);
    },
    memory: wasmMemory,
  },
});

const queryRunner = wasmInstance.exports as {
  // Keep synchronised with function declarations wasm/*.c with WASM_EXPORT.
  reset (): void;
  malloc (size: number): number;
  index_query_malloc (): number;
  index_query (input: number): number;
  find_chunk_containing_term (termPtr: number, termLen: number): number;
  find_chunk_containing_doc (doc: number): number;
  search_bst_chunk_for_term (chunkPtr: number, midPos: number, termPtr: number, termLen: number): number;
  search_bst_chunk_for_doc (chunkPtr: number, midPos: number, doc: number): number;
};

const queryRunnerMemory = new MemoryWalker(wasmMemory.buffer);

const textEncoder = new TextEncoder();

const textDecoder = new TextDecoder();

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const responsePreflight = () => new Response(null, {
  headers: CORS_HEADERS,
});

const responseError = (error: string, status: number = 400) => new Response(JSON.stringify({error}), {
  status, headers: {
    'Content-Type': 'application/json',
    ...CORS_HEADERS,
  },
});

const responseRawJson = (json: string, status = 200) => new Response(json, {
  status, headers: {
    'Content-Type': 'application/json',
    ...CORS_HEADERS,
  },
});

const responseDefaultResults = async () => responseRawJson(`{"results":${await KV.get('default', 'text')},"continuation":null,"total":0}`);

const responseNoResults = async () => responseRawJson(`{"results":[],"continuation":null,"total":0}`);

const findInChunks = async (key: string | number, chunksIdPrefix: string): Promise<ArrayBuffer | undefined> => {
  let chunkRefPtr;
  let cKey: { ptr: number; len: number; } | number;
  if (typeof key == 'string') {
    const encoded = textEncoder.encode(key);
    const len = encoded.length;
    const ptr = queryRunner.malloc(len);
    cKey = {ptr, len};
    queryRunnerMemory.forkAndJump(ptr).writeAll(encoded);
    chunkRefPtr = queryRunner.find_chunk_containing_term(ptr, len);
  } else {
    cKey = key;
    chunkRefPtr = queryRunner.find_chunk_containing_doc(key);
  }

  console.log('Found chunk');
  if (chunkRefPtr === 0) {
    return undefined;
  }
  const chunkRef = queryRunnerMemory.forkAndJump(chunkRefPtr);
  const chunkId = chunkRef.readUInt32LE();
  const chunkMidPos = chunkRef.readUInt32LE();

  const chunkData = await KV.get(`${chunksIdPrefix}${chunkId}`, 'arrayBuffer');
  console.log('Fetched chunk from KV');
  const chunkPtr = queryRunner.malloc(chunkData.byteLength);
  queryRunnerMemory.forkAndJump(chunkPtr).writeAll(new Uint8Array(chunkData));
  let entryPtr;
  if (typeof cKey == 'number') {
    entryPtr = queryRunner.search_bst_chunk_for_doc(chunkPtr, chunkMidPos, cKey);
  } else {
    entryPtr = queryRunner.search_bst_chunk_for_term(chunkPtr, chunkMidPos, cKey.ptr, cKey.len);
  }

  console.log('Found entry in chunk');
  if (entryPtr === 0) {
    return undefined;
  }
  const entry = queryRunnerMemory.forkAndJump(entryPtr);
  const entryLen = entry.readUInt32LE();
  return entry.readAndDereferencePointer().readSlice(entryLen);
};

// Keep order in sync with mode_t.
type ParsedQuery = [
  // Require.
  string[],
  // Contain.
  string[],
  // Exclude.
  string[],
];

// Take a raw query string and parse in into an array with three subarrays, each subarray representing terms for a mode.
const parseQuery = (termsRaw: string[]): ParsedQuery | undefined => {
  const modeTerms: ParsedQuery = [
    Array<string>(),
    Array<string>(),
    Array<string>(),
  ];
  for (const value of termsRaw) {
    // Synchronise mode IDs with mode_t enum in wasm/index.c.
    const matches = /^([012])_([^&]+)(?:&|$)/.exec(value);
    if (!matches) {
      return;
    }
    const mode = Number.parseInt(matches[1], 10);
    const term = decodeURIComponent(matches[2]);
    modeTerms[mode].push(term);
  }

  return modeTerms;
};

type QueryResult = {
  continuation: number | null;
  total: number;
  documents: number[];
};

const readResult = (result: MemoryWalker): QueryResult => {
  // Synchronise with `results_t` in wasm/index.c.
  const continuation = result.readInt32LE();
  const total = result.readUInt32LE();
  const count = result.readUInt8();
  // Starts from next WORD_SIZE (uint32_t) due to alignment.
  result.skip(3);
  const documents: number[] = [];
  for (let resultNo = 0; resultNo < count; resultNo++) {
    // Synchronise with `doc_id_t` in wasm/index.c.
    const docId = result.readUInt32LE();
    documents.push(docId);
  }
  return {continuation: continuation == -1 ? null : continuation, total, documents};
};

const findSerialisedTermBitmaps = async (query: ParsedQuery): Promise<(ArrayBuffer | undefined)[][]> => {
  return await Promise.all(
    query.map(modeTerms => Promise.all(
      modeTerms.map(term =>
        // Keep in sync with deploy/mod.rs.
        findInChunks(term, 'terms_'),
      ),
    )),
  );
};

const buildIndexQuery = async (firstRank: number, modeTermBitmaps: ArrayBuffer[][]): Promise<Uint8Array> => {
  const bitmapCount = modeTermBitmaps.reduce((count, modeTerms) => count + modeTerms.length, 0);

  // Synchronise with index_query_t.
  const input = new MemoryWalker(new ArrayBuffer(4 + (bitmapCount * 2 + 3) * 4));
  input.writeUInt32LE(firstRank);
  for (const mode of modeTermBitmaps) {
    for (const bitmap of mode) {
      const ptr = queryRunner.malloc(bitmap.byteLength);
      queryRunnerMemory.forkAndJump(ptr).writeAll(new Uint8Array(bitmap));
      // WASM is LE.
      input
        .writeUInt32LE(bitmap.byteLength)
        .writeUInt32LE(ptr);
    }
    input.writeUInt32LE(0);
  }

  return new Uint8Array(input.buffer);
};

const executePostingsListQuery = (queryData: Uint8Array): QueryResult | undefined => {
  const inputPtr = queryRunner.index_query_malloc();
  queryRunnerMemory.forkAndJump(inputPtr).writeAll(queryData);
  const outputPtr = queryRunner.index_query(inputPtr);
  return outputPtr == 0 ? undefined : readResult(queryRunnerMemory.forkAndJump(outputPtr));
};

const getAsciiBytes = (str: string) => new Uint8Array(str.split('').map(c => c.charCodeAt(0)));

const COMMA = getAsciiBytes(',');

const handleSearch = async (url: URL) => {
  queryRunner.reset();

  // NOTE: Just because there are no valid words does not mean that there are no valid results.
  // For example, excluding an invalid word actually results in all entries matching.
  const query = parseQuery(url.searchParams.getAll('t'));
  if (!query) {
    return responseError('Malformed query');
  }
  const continuation = Math.max(0, Number.parseInt(url.searchParams.get('c') || '', 10) || 0);

  const termCount = query.reduce((count, modeTerms) => count + modeTerms.length, 0);
  if (termCount > MAX_QUERY_TERMS) {
    return responseError('Too many terms', 413);
  }

  const modeTermBitmaps = await findSerialisedTermBitmaps(query);
  console.log('Bit sets retrieved');
  // Handling non-existent terms:
  // - If REQUIRE, then immediately return zero results, regardless of other terms of any mode.
  // - If CONTAIN, then simply omit.
  // - If EXCLUDE, then it depends; if there are other terms of any mode, then simply omit. If there are no other terms of any mode, then return default results.
  if (modeTermBitmaps[0].some(bm => !bm)) {
    return responseNoResults();
  }
  modeTermBitmaps[1] = modeTermBitmaps[1].filter(bm => bm);
  modeTermBitmaps[2] = modeTermBitmaps[2].filter(bm => bm);
  if (modeTermBitmaps.every(modeTerms => !modeTerms.length)) {
    return responseDefaultResults();
  }

  const indexQueryData = await buildIndexQuery(continuation, modeTermBitmaps as ArrayBuffer[][]);
  console.log('Query built');

  const result = await executePostingsListQuery(indexQueryData);
  if (!result) {
    throw new Error(`Failed to execute query`);
  }
  console.log('Query executed');

  // We want to avoid JSON.{parse,stringify} as they take up a lot of CPU time and often cause timeout exceptions in CF Workers for large payloads.
  // So, we manually build our response with buffers, as that's how documents are stored.
  // The buffers represent parts of the UTF-8 encoded JSON serialised response bytes.
  const jsonResPrefix = getAsciiBytes(`{"total":${result.total},"continuation":${continuation},"results":[`);
  const jsonResSuffix = getAsciiBytes(`]}`);
  const documents = (await Promise.all(result.documents.map(docId =>
    // Each document should be a JSON serialised value encoded in UTF-8.
    findInChunks(docId, 'doc_'),
  ))).filter(exists).map(d => new Uint8Array(d));
  console.log('Documents fetched');

  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  writer.write(jsonResPrefix);
  for (let i = 0; i < documents.length; i++) {
    if (i !== 0) {
      writer.write(COMMA);
    }
    writer.write(documents[i]);
  }
  writer.write(jsonResSuffix);
  writer.releaseLock();

  return new Response(stream.readable, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
};

const requestHandler = async (request: Request) => {
  if (request.method == 'OPTIONS') {
    return responsePreflight();
  }

  const url = new URL(request.url);

  return url.pathname === '/search'
    ? handleSearch(url)
    : new Response(null, {status: 404});
};

// See https://github.com/Microsoft/TypeScript/issues/14877.
(self as unknown as ServiceWorkerGlobalScope).addEventListener('fetch', event => {
  event.respondWith(requestHandler(event.request));
});
