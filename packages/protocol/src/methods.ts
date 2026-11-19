import { NOTIFICATION_EVENT_TYPES } from './events.js';
import type { NotificationEventType } from './events.js';

/**
 * Canonical JSON-RPC method names.
 *
 * Grouped for discoverability and also exposed flat (`METHOD_NAMES`) for
 * dispatch tables, routing validation and tests.
 */

export const METHODS = {
  agent: {
    register: 'agent.register',
    authenticate: 'agent.authenticate',
    list: 'agent.list',
  },
  channel: {
    create: 'channel.create',
    join: 'channel.join',
    leave: 'channel.leave',
    list: 'channel.list',
  },
  message: {
    send: 'message.send',
    history: 'message.history',
  },
  task: {
    publish: 'task.publish',
    list: 'task.list',
    get: 'task.get',
    bid: 'task.bid',
    bids: 'task.bids',
    award: 'task.award',
    progress: 'task.progress',
    complete: 'task.complete',
    fail: 'task.fail',
    review: 'task.review',
    reassign: 'task.reassign',
  },
  system: {
    subscribe: 'system.subscribe',
  },
} as const;

export type MethodGroups = typeof METHODS;

export const METHOD_NAMES = [
  METHODS.agent.register,
  METHODS.agent.authenticate,
  METHODS.agent.list,
  METHODS.channel.create,
  METHODS.channel.join,
  METHODS.channel.leave,
  METHODS.channel.list,
  METHODS.message.send,
  METHODS.message.history,
  METHODS.task.publish,
  METHODS.task.list,
  METHODS.task.get,
  METHODS.task.bid,
  METHODS.task.bids,
  METHODS.task.award,
  METHODS.task.progress,
  METHODS.task.complete,
  METHODS.task.fail,
  METHODS.task.review,
  METHODS.task.reassign,
  METHODS.system.subscribe,
] as const;

export type MethodName = (typeof METHOD_NAMES)[number];

export function isMethodName(value: string): value is MethodName {
  return (METHOD_NAMES as readonly string[]).includes(value);
}

/**
 * Server → client event notifications use the event type itself as the
 * JSON-RPC notification method (e.g. `method: "task.awarded"`), with the
 * event envelope as `params` (see `eventNotificationSchema`).
 */
export const EVENT_NOTIFICATION_METHODS = NOTIFICATION_EVENT_TYPES;

export function isEventNotificationMethod(
  method: string,
): method is NotificationEventType {
  return (EVENT_NOTIFICATION_METHODS as readonly string[]).includes(method);
}
