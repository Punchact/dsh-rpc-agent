export declare const CODE: {
  readonly parseError: -32700;
  readonly invalidRequest: -32600;
  readonly methodNotFound: -32601;
  readonly invalidParams: -32602;
  readonly internal: -32603;
  readonly server: -32000;
  readonly unauthorized: -32001;
  readonly forbidden: -32002;
  readonly notFound: -32003;
  readonly busy: -32004;
  readonly timeout: -32005;
  readonly cancelled: -32006;
};

export declare class RpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown);
}
