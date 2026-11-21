import { JsonRpcErrorCode } from '@agentmesh/protocol';

/** One error class per AgentMesh JSON-RPC code; `data` is preserved. */
export class AgentMeshError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
    readonly method?: string,
  ) {
    super(message);
    this.name = 'AgentMeshError';
  }
}

export class UnauthorizedError extends AgentMeshError {
  constructor(message: string, data?: unknown, method?: string) {
    super(JsonRpcErrorCode.Unauthorized, message, data, method);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends AgentMeshError {
  constructor(message: string, data?: unknown, method?: string) {
    super(JsonRpcErrorCode.Forbidden, message, data, method);
    this.name = 'ForbiddenError';
  }
}

export class InvalidStateError extends AgentMeshError {
  constructor(message: string, data?: unknown, method?: string) {
    super(JsonRpcErrorCode.InvalidState, message, data, method);
    this.name = 'InvalidStateError';
  }
}

export class NotFoundError extends AgentMeshError {
  constructor(message: string, data?: unknown, method?: string) {
    super(JsonRpcErrorCode.NotFound, message, data, method);
    this.name = 'NotFoundError';
  }
}

export class RateLimitedError extends AgentMeshError {
  constructor(message: string, data?: unknown, method?: string) {
    super(JsonRpcErrorCode.RateLimited, message, data, method);
    this.name = 'RateLimitedError';
  }

  get retryAfterMs(): number | undefined {
    const value = (this.data as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
    return typeof value === 'number' ? value : undefined;
  }
}

export class ProtocolVersionError extends AgentMeshError {
  constructor(message: string, data?: unknown, method?: string) {
    super(JsonRpcErrorCode.ProtocolVersionIncompatible, message, data, method);
    this.name = 'ProtocolVersionError';
  }
}

export class VersionConflictError extends AgentMeshError {
  constructor(message: string, data?: unknown, method?: string) {
    super(JsonRpcErrorCode.VersionConflict, message, data, method);
    this.name = 'VersionConflictError';
  }

  get taskId(): string | undefined {
    const value = (this.data as { taskId?: unknown } | undefined)?.taskId;
    return typeof value === 'string' ? value : undefined;
  }

  get expectedVersion(): number | undefined {
    const value = (this.data as { expectedVersion?: unknown } | undefined)?.expectedVersion;
    return typeof value === 'number' ? value : undefined;
  }

  get currentVersion(): number | undefined {
    const value = (this.data as { currentVersion?: unknown } | undefined)?.currentVersion;
    return typeof value === 'number' ? value : undefined;
  }
}

export function errorFromResponse(
  code: number,
  message: string,
  data: unknown,
  method?: string,
): AgentMeshError {
  switch (code) {
    case JsonRpcErrorCode.Unauthorized:
      return new UnauthorizedError(message, data, method);
    case JsonRpcErrorCode.Forbidden:
      return new ForbiddenError(message, data, method);
    case JsonRpcErrorCode.InvalidState:
      return new InvalidStateError(message, data, method);
    case JsonRpcErrorCode.NotFound:
      return new NotFoundError(message, data, method);
    case JsonRpcErrorCode.RateLimited:
      return new RateLimitedError(message, data, method);
    case JsonRpcErrorCode.ProtocolVersionIncompatible:
      return new ProtocolVersionError(message, data, method);
    case JsonRpcErrorCode.VersionConflict:
      return new VersionConflictError(message, data, method);
    default:
      return new AgentMeshError(code, message, data, method);
  }
}
