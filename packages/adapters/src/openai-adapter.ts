import type { AgentMeshClient, TaskView } from '@agentmesh/sdk';

import type {
  AdapterDependencies,
  AgentAdapterConfig,
} from './types.js';

import { BaseAgentAdapter } from './base-adapter.js';

declare const process: {
  env: Record<string, string | undefined>;
};

export interface OpenAIAdapterConfig extends AgentAdapterConfig {
  readonly provider: 'openai';
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly apiKey?: string;
  readonly systemPrompt?: string;
  readonly temperature?: number;
}

interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  max_tokens?: number;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: { role: 'assistant'; content: string };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function validateConfig(config: OpenAIAdapterConfig): void {
  if (config.provider !== 'openai') {
    throw new TypeError("provider must be 'openai'");
  }
  if (config.baseUrl !== undefined) requireNonEmpty(config.baseUrl, 'baseUrl');
  if (config.model !== undefined) requireNonEmpty(config.model, 'model');
  if (config.timeoutMs !== undefined) {
    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1000) {
      throw new TypeError('timeoutMs must be a positive integer >= 1000');
    }
  }
  if (config.maxRetries !== undefined) {
    if (!Number.isSafeInteger(config.maxRetries) || config.maxRetries < 0 || config.maxRetries > 10) {
      throw new TypeError('maxRetries must be an integer between 0 and 10');
    }
  }
  if (config.temperature !== undefined) {
    if (typeof config.temperature !== 'number' || config.temperature < 0 || config.temperature > 2) {
      throw new TypeError('temperature must be a number between 0 and 2');
    }
  }
}

export class OpenAIAdapter extends BaseAgentAdapter {
  readonly #baseUrl: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #systemPrompt: string;
  readonly #temperature: number;
  readonly #apiKey: string;
  readonly #client: AgentMeshClient;
  readonly #unsubscribers: Array<() => void>;

  constructor(deps: AdapterDependencies, config: OpenAIAdapterConfig) {
    validateConfig(config);
    super('openai', deps, config);

    this.#client = deps.client;
    this.#unsubscribers = [];

    this.#baseUrl = config.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    this.#model = config.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
    this.#timeoutMs = config.timeoutMs ?? parseInt(process.env.OPENAI_TIMEOUT_MS ?? '60000', 10);
    this.#maxRetries = config.maxRetries ?? 3;
    this.#systemPrompt = config.systemPrompt ?? process.env.OPENAI_SYSTEM_PROMPT ?? 'You are an AI agent working in a collaborative task system.\nYou will be given a task with specific requirements.\nComplete the task and return your work as a clear, well-structured response.\nFocus on practical, actionable output.';
    this.#temperature = config.temperature ?? 0.3;

    const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new TypeError('OPENAI_API_KEY is required (env or config)');
    }
    this.#apiKey = apiKey;

    const unsubAwarded = deps.client.on('task.awarded', (payload: { awardeeId: string; taskId: string }) => {
      if (payload.awardeeId === this.agentId) {
        this.#executeTask(payload.taskId).catch((err) => {
          console.error('[OpenAIAdapter] Task execution error:', err);
        });
      }
    });
    this.#unsubscribers.push(unsubAwarded);
  }

  #buildRequest(prompt: string): ChatCompletionRequest {
    return {
      model: this.#model,
      messages: [
        { role: 'system', content: this.#systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature: this.#temperature,
      max_tokens: 4096,
    };
  }

  async #fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async #callLLM(prompt: string): Promise<string> {
    const url = this.#baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const body = this.#buildRequest(prompt);

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt++) {
      try {
        const response = await this.#fetchWithTimeout(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + this.#apiKey,
          },
          body: JSON.stringify(body),
        }, this.#timeoutMs);

        if (!response.ok) {
          const errorText = await response.text().catch(() => 'unknown');
          throw new Error('LLM API error: ' + response.status + ' ' + response.statusText + ' - ' + errorText);
        }

        const data = await response.json() as ChatCompletionResponse;
        const content = data.choices?.[0]?.message?.content?.trim();
        if (!content) {
          throw new Error('LLM returned empty response');
        }
        return content;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.#maxRetries) {
          const delayMs = 1000 * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }
    throw lastError ?? new Error('LLM call failed after retries');
  }

  #buildPrompt(task: TaskView): string {
    const parts: string[] = [
      '## Task: ' + task.title,
      '',
      'Description: ' + (task.description ?? '(none)'),
      'Required Skills: ' + (task.requiredSkills?.join(', ') ?? '(none)'),
      'Budget: ' + (task.budget ?? 0),
      'Status: ' + task.status,
      '',
      'Please complete this task and provide your deliverable as a clear response.',
    ];
    return parts.join('\n');
  }

  async #executeTask(taskId: string): Promise<void> {
    await this.progress(taskId, 0, { note: 'Starting LLM execution...' });

    try {
      const task = await this.#client.getTask({ taskId });
      const prompt = this.#buildPrompt(task);
      const result = await this.#callLLM(prompt);

      await this.progress(taskId, 100, { note: 'LLM execution completed' });
      await this.complete(taskId, task.version, {
        note: 'Completed by LLM',
        artifacts: ['artifact://llm-output/' + taskId],
      });

      console.log('[OpenAIAdapter] Task ' + taskId + ' completed. Result length: ' + result.length + ' chars');
    } catch (error) {
      const task = await this.#client.getTask({ taskId }).catch(() => null);
      const version = task?.version ?? 0;
      await this.fail(taskId, version, error instanceof Error ? error.message : String(error));
      console.error('[OpenAIAdapter] Task ' + taskId + ' failed:', error);
    }
  }
}

interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  max_tokens?: number;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: { role: 'assistant'; content: string };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}


export function createOpenAIAdapter(deps: AdapterDependencies, config: Omit<OpenAIAdapterConfig, 'provider'>): OpenAIAdapter {
  return new OpenAIAdapter(deps, { ...config, provider: 'openai' });
}

export interface OpenAIAdapterConfig extends AgentAdapterConfig {
  readonly provider: 'openai';
  readonly baseUrl?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly apiKey?: string;
  readonly systemPrompt?: string;
  readonly temperature?: number;
}