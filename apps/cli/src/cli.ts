/**
 * Command dispatch for `agentmesh`.
 *
 * Every command that talks to the server goes through `@agentmesh/sdk`; the
 * CLI adds argument parsing, config persistence and human output only.
 */

import {
  booleanFlag,
  optionalString,
  parseArgs,
  requireString,
  UsageError,
} from './args.js';
import { ConfigError, resolveConfig, saveConfig, type ResolvedConfig } from './config.js';
import type { ClientFactory, CommandContext } from './context.js';
import {
  runAgentList,
  runLogin,
  runLogout,
  runRegister,
  runWhoami,
} from './commands/account.js';
import {
  runChannelCreate,
  runChannelJoin,
  runChannelLeave,
  runChannelList,
} from './commands/channel.js';
import { collectDoctorChecks, formatDoctor } from './commands/doctor.js';
import { runMessageHistory, runMessageSend } from './commands/message.js';
import {
  runTaskAward,
  runTaskBid,
  runTaskBids,
  runTaskCancel,
  runTaskComplete,
  runTaskFail,
  runTaskGet,
  runTaskList,
  runTaskProgress,
  runTaskPublish,
  runTaskReassign,
  runTaskReview,
} from './commands/task.js';
import { runTaskWatch, watchOptionsFromContext } from './commands/watch.js';
import { formatCliError, jsonError } from './errors.js';
import { nodeTransport } from './node-transport.js';
import { AgentMeshClient } from '@agentmesh/sdk';

export const VERSION = '0.1.0';

export const USAGE = `agentmesh ${VERSION} — AgentMesh client CLI

Usage:
  agentmesh [--url <url>] [--profile <name>] [--json] <command> [options]

Global options:
  -u, --url <url>         Server WebSocket URL (env: AGENTMESH_URL)
  -p, --profile <name>    Config profile (env: AGENTMESH_PROFILE)
      --config <path>     Explicit config file
  -t, --token <jwt>       Override the stored token
      --json              Machine-readable output
  -h, --help              Show this help
      --version           Print the version

Account:
  register --name <name> [--owner <o>] [--skills a,b] [--role agent|admin]
  login --agent-id <id> [--secret <s> | --secret-stdin] [--name <n>]
  logout
  whoami
  agent list [--role <role>] [--limit <n>] [--offset <n>]

Channels and messages:
  channel create --name <name>
  channel join --channel <id> [--agent <id>]
  channel leave --channel <id> [--agent <id>]
  channel list [--limit <n>] [--offset <n>]
  message send --channel <id> (--body <text> | --body-stdin)
  message history --channel <id> [--after-seq <n>] [--before-seq <n>] [--limit <n>]

Tasks:
  task publish --title <t> [--description <d>] [--skills a,b] [--budget <n>]
               [--deadline <iso|epoch-ms>] [--bidding-deadline <iso|epoch-ms>]
               [--parent <taskId>]
  task list [--status <status>] [--limit <n>] [--offset <n>]
  task get --task <taskId>
  task bid --task <taskId> --price <n> [--eta <n>] [--approach <text>]
           [--confidence <0..1>]
  task bids --task <taskId>
  task award --task <taskId> --expected-version <n> [--awardee <agentId>]
             [--strategy manual|auto]
  task progress --task <taskId> --progress <0..100> [--note <text>]
                [--artifact <ref>]...
  task complete --task <taskId> --expected-version <n> [--note <text>]
                [--artifact <ref>]...
  task fail --task <taskId> --expected-version <n> [--reason <text>]
  task review --task <taskId> --expected-version <n>
              --decision approve|reject|request-revision [--comment <text>]
  task reassign --task <taskId> --expected-version <n> --to <agentId>
                [--reason <text>]
  task cancel --task <taskId> --expected-version <n> [--reason <text>]
  task watch --task <taskId>

Diagnostics:
  doctor

Config precedence: flags > env (AGENTMESH_URL / AGENTMESH_PROFILE /
AGENTMESH_HOME) > profile file > default file. Account secrets are never
persisted; the token is stored in a 0600 file.`;

export interface RunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly clientFactory?: ClientFactory;
}

const defaultClientFactory: ClientFactory = (config, options) => {
  if (config.url === undefined) {
    throw new ConfigError('no server URL configured; pass --url or set AGENTMESH_URL');
  }
  return new AgentMeshClient({
    url: config.url,
    transportFactory: nodeTransport,
    autoReconnect: options.autoReconnect,
    ...(config.token === undefined ? {} : { token: config.token }),
  });
};

function withoutToken(config: ResolvedConfig): ResolvedConfig {
  const { token: _token, ...rest } = config;
  return rest;
}

function defaultStdout(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function defaultStderr(text: string): void {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** Entry point shared by the binary and the tests. */
export async function run(argv: readonly string[], options: RunOptions = {}): Promise<number> {
  const stdout = options.stdout ?? defaultStdout;
  const stderr = options.stderr ?? defaultStderr;
  const env = options.env ?? process.env;
  const factory = options.clientFactory ?? defaultClientFactory;

  let json = false;
  try {
    const args = parseArgs(argv);
    json = booleanFlag(args, 'json');

    if (booleanFlag(args, 'help')) {
      stdout(USAGE);
      return 0;
    }
    if (booleanFlag(args, 'version')) {
      stdout(VERSION);
      return 0;
    }

    const [group, action] = args.positionals;
    if (group === undefined) {
      stdout(USAGE);
      return 0;
    }

    const load = (): { config: ResolvedConfig; ctx: CommandContext } => {
      const flagUrl = optionalString(args, 'url');
      const flagToken = optionalString(args, 'token');
      const flagProfile = optionalString(args, 'profile');
      const flagConfig = optionalString(args, 'config');
      const flagAgentId = optionalString(args, 'agent-id');
      const config = resolveConfig({
        flags: {
          ...(flagUrl === undefined ? {} : { url: flagUrl }),
          ...(flagToken === undefined ? {} : { token: flagToken }),
          ...(flagProfile === undefined ? {} : { profile: flagProfile }),
          ...(flagConfig === undefined ? {} : { config: flagConfig }),
          ...(flagAgentId === undefined ? {} : { agentId: flagAgentId }),
        },
        env,
        ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
      });
      const ctx: CommandContext = {
        args,
        config,
        json,
        out: stdout,
        save: (patch) => {
          saveConfig(config.path, patch);
        },
      };
      return { config, ctx };
    };

    const withClient = async (
      autoReconnect: boolean,
      fn: (client: AgentMeshClient, ctx: CommandContext) => Promise<void>,
      configTransform: (config: ResolvedConfig) => ResolvedConfig = (config) => config,
    ): Promise<void> => {
      const { config, ctx } = load();
      const client = factory(configTransform(config), { autoReconnect });
      try {
        await client.connect();
        await fn(client, ctx);
      } finally {
        client.close();
      }
    };

    switch (group) {
      case 'register':
        await withClient(false, runRegister, withoutToken);
        return 0;
      case 'login':
      case 'authenticate':
        await withClient(false, runLogin);
        return 0;
      case 'logout': {
        const { ctx } = load();
        runLogout(ctx);
        return 0;
      }
      case 'whoami': {
        const { ctx } = load();
        runWhoami(ctx);
        return 0;
      }
      case 'doctor': {
        const { ctx } = load();
        const checks = await collectDoctorChecks(ctx, factory);
        const ok = checks.every((check) => check.ok);
        ctx.out(
          ctx.json
            ? JSON.stringify({ ok, checks }, null, 2)
            : formatDoctor(checks),
        );
        return ok ? 0 : 1;
      }
      case 'agent':
        if (action === 'list') {
          await withClient(false, runAgentList);
          return 0;
        }
        throw new UsageError('usage: agentmesh agent list [options]');
      case 'channel':
        switch (action) {
          case 'create':
            await withClient(false, runChannelCreate);
            return 0;
          case 'join':
            await withClient(false, runChannelJoin);
            return 0;
          case 'leave':
            await withClient(false, runChannelLeave);
            return 0;
          case 'list':
            await withClient(false, runChannelList);
            return 0;
          default:
            throw new UsageError(
              'usage: agentmesh channel create|join|leave|list [options]',
            );
        }
      case 'message':
        switch (action) {
          case 'send':
            await withClient(false, runMessageSend);
            return 0;
          case 'history':
            await withClient(false, runMessageHistory);
            return 0;
          default:
            throw new UsageError('usage: agentmesh message send|history [options]');
        }
      case 'task':
        switch (action) {
          case 'publish':
            await withClient(false, runTaskPublish);
            return 0;
          case 'list':
            await withClient(false, runTaskList);
            return 0;
          case 'get':
            await withClient(false, runTaskGet);
            return 0;
          case 'bid':
            await withClient(false, runTaskBid);
            return 0;
          case 'bids':
            await withClient(false, runTaskBids);
            return 0;
          case 'award':
            await withClient(false, runTaskAward);
            return 0;
          case 'progress':
            await withClient(false, runTaskProgress);
            return 0;
          case 'complete':
            await withClient(false, runTaskComplete);
            return 0;
          case 'fail':
            await withClient(false, runTaskFail);
            return 0;
          case 'review':
            await withClient(false, runTaskReview);
            return 0;
          case 'reassign':
            await withClient(false, runTaskReassign);
            return 0;
          case 'cancel':
            await withClient(false, runTaskCancel);
            return 0;
          case 'watch': {
            const taskId = requireString(args, 'task');
            await withClient(true, (client, ctx) =>
              runTaskWatch(client, watchOptionsFromContext(ctx, taskId)),
            );
            return 0;
          }
          default:
            throw new UsageError(
              'usage: agentmesh task publish|list|get|bid|bids|award|progress|' +
                'complete|fail|review|reassign|cancel|watch [options]',
            );
        }
      default:
        throw new UsageError(`unknown command: ${group}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(`error: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    if (error instanceof ConfigError) {
      stderr(`error: ${error.message}`);
      return 2;
    }
    stderr(json ? JSON.stringify(jsonError(error), null, 2) : formatCliError(error));
    return 1;
  }
}
