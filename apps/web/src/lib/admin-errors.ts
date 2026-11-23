/**
 * Pure error-mapping helpers for the admin console (US-021G).
 *
 * These are extracted from the login / task-board pages so the mapping
 * (JSON-RPC code → user-facing copy) is unit-testable without a DOM, and so the
 * `-32007` retry entry can surface both `expectedVersion` and `currentVersion`
 * from the SDK's typed `VersionConflictError`.
 */
import { VersionConflictError } from '@agentmesh/sdk';

export type LoginErrorKind = 'unauthorized' | 'forbidden' | 'other';

export interface LoginErrorResult {
  message: string;
  kind: LoginErrorKind;
}

/** Map an `agent.authenticate` failure to a login-banner message. */
export function mapLoginError(err: unknown): LoginErrorResult {
  const msg = err instanceof Error ? err.message : '登录失败';
  if (msg.includes('-32001') || msg.includes('Unauthorized')) {
    return { message: '凭据无效或已过期', kind: 'unauthorized' };
  }
  if (msg.includes('-32002')) {
    return { message: '权限不足：需要 admin 角色', kind: 'forbidden' };
  }
  return { message: msg, kind: 'other' };
}

export interface TaskActionErrorResult {
  message: string;
  isVersionConflict: boolean;
  expectedVersion?: number;
  currentVersion?: number;
}

/**
 * Map a CAS task action failure. A `-32007` version conflict must show both the
 * `expectedVersion` the caller sent and the `currentVersion` the server holds so
 * the operator knows exactly how to retry.
 */
export function mapTaskActionError(
  err: unknown,
  action: string,
  expectedVersion: number,
): TaskActionErrorResult {
  if (err instanceof VersionConflictError) {
    const expected = err.expectedVersion ?? expectedVersion;
    const current = err.currentVersion;
    const currentPart = current === undefined ? '' : `，current=${current}`;
    return {
      message: `版本冲突：任务已更新，expected=${expected}${currentPart}。请刷新后重试`,
      isVersionConflict: true,
      expectedVersion: expected,
      currentVersion: current,
    };
  }
  const msg = err instanceof Error ? err.message : `${action} 失败`;
  if (msg.includes('-32007') || msg.includes('version conflict')) {
    return {
      message: `版本冲突：请刷新任务详情获取最新 version，当前 expected=${expectedVersion}`,
      isVersionConflict: true,
      expectedVersion,
    };
  }
  return { message: msg, isVersionConflict: false };
}
