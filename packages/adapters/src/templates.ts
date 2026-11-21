import { BaseAgentAdapter } from './base-adapter.js';
import type { AdapterDependencies, AgentAdapterConfig } from './types.js';

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

export interface GrokAdapterConfig extends AgentAdapterConfig {
  readonly provider: 'xai' | 'mock';
  readonly baseUrl?: string;
  readonly model?: string;
}

/** xAI / OpenAI-compatible adapter template (no real network calls). */
export class GrokAdapter extends BaseAgentAdapter {
  readonly model: string;

  constructor(deps: AdapterDependencies, config: GrokAdapterConfig) {
    if (config.provider !== 'xai' && config.provider !== 'mock') {
      throw new TypeError("provider must be 'xai' or 'mock'");
    }
    if (config.baseUrl !== undefined) requireString(config.baseUrl, 'baseUrl');
    super('grok', deps, config);
    this.model = config.model ?? (config.provider === 'xai' ? 'grok-2-latest' : 'mock-grok');
  }
}

export interface MuseAdapterConfig extends AgentAdapterConfig {
  readonly workspaceId: string;
  readonly model?: string;
}

export class MuseAdapter extends BaseAgentAdapter {
  readonly workspaceId: string;

  constructor(deps: AdapterDependencies, config: MuseAdapterConfig) {
    super('muse', deps, config);
    this.workspaceId = requireString(config.workspaceId, 'workspaceId');
  }
}

export interface HermesAdapterConfig extends AgentAdapterConfig {
  readonly endpoint: string;
  readonly model?: string;
}

export class HermesAdapter extends BaseAgentAdapter {
  readonly endpoint: string;

  constructor(deps: AdapterDependencies, config: HermesAdapterConfig) {
    super('hermes', deps, config);
    this.endpoint = requireString(config.endpoint, 'endpoint');
  }
}

export interface OpenclawAdapterConfig extends AgentAdapterConfig {
  readonly gatewayUrl: string;
  readonly sandboxId?: string;
}

export class OpenclawAdapter extends BaseAgentAdapter {
  readonly gatewayUrl: string;

  constructor(deps: AdapterDependencies, config: OpenclawAdapterConfig) {
    super('openclaw', deps, config);
    this.gatewayUrl = requireString(config.gatewayUrl, 'gatewayUrl');
  }
}

export interface CodexAdapterConfig extends AgentAdapterConfig {
  readonly sandboxId: string;
  readonly model?: string;
}

export class CodexAdapter extends BaseAgentAdapter {
  readonly sandboxId: string;

  constructor(deps: AdapterDependencies, config: CodexAdapterConfig) {
    super('codex', deps, config);
    this.sandboxId = requireString(config.sandboxId, 'sandboxId');
  }
}
