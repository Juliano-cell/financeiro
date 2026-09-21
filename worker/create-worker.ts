import {
  runAutomaticNotificationDispatcher,
  type AutomaticNotificationDispatcherSummary,
} from "../lib/automatic-notification-dispatcher.ts";
import {
  runNotificationScheduler,
  type NotificationSchedulerContext,
  type NotificationSchedulerSummary,
} from "../lib/notification-scheduler.ts";
import { TelegramNotificationTransport } from "../lib/telegram-notification-transport.ts";

export const NOTIFICATION_PLANNER_CRON = "*/5 * * * *";
export const NOTIFICATION_DISPATCHER_CRON = "* * * * *";

function automaticNotificationsEnabled(value: unknown) {
  return value === "true";
}

export type VinextFetchHandler<Env> = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
) => Response | Promise<Response>;

export interface VinextWorkerHandler<Env> {
  fetch: VinextFetchHandler<Env>;
}

export interface ApplicationWorker<Env> extends ExportedHandler<Env> {
  fetch: VinextFetchHandler<Env>;
  scheduled: ExportedHandlerScheduledHandler<Env>;
}

export type WorkerScheduler = (
  context: NotificationSchedulerContext,
) => Promise<NotificationSchedulerSummary>;

export type WorkerDispatcherContext = {
  d1: D1Database;
  now: Date;
};

export type WorkerDispatcher = (
  context: WorkerDispatcherContext,
) => Promise<AutomaticNotificationDispatcherSummary>;

export type WorkerEntrypointOptions = {
  runScheduler?: WorkerScheduler;
  runDispatcher?: WorkerDispatcher;
  logSchedulerSummary?: (summary: NotificationSchedulerSummary & { cron: string; durationMs: number }) => void;
  logDispatcherSummary?: (summary: AutomaticNotificationDispatcherSummary & { cron: string; durationMs: number }) => void;
};

export function createWorkerEntrypoint<Env>(
  vinextHandler: VinextWorkerHandler<Env>,
  options: WorkerEntrypointOptions = {},
): ApplicationWorker<Env> {
  return {
    fetch(request, env, ctx) {
      return vinextHandler.fetch(request, env, ctx);
    },

    scheduled(controller, env, ctx) {
      if (controller.cron !== NOTIFICATION_PLANNER_CRON
        && controller.cron !== NOTIFICATION_DISPATCHER_CRON) return;
      const flags = env as Env & {
        NOTIFICATION_PLANNER_ENABLED?: string;
        NOTIFICATION_DISPATCHER_ENABLED?: string;
      };
      if (controller.cron === NOTIFICATION_PLANNER_CRON
        && !automaticNotificationsEnabled(flags.NOTIFICATION_PLANNER_ENABLED)) return;
      if (controller.cron === NOTIFICATION_DISPATCHER_CRON
        && !automaticNotificationsEnabled(flags.NOTIFICATION_DISPATCHER_ENABLED)) return;
      const startedAt = Date.now();
      const runtimeEnv = env as Env & { DB: D1Database; TELEGRAM_BOT_TOKEN?: string };
      const now = new Date(controller.scheduledTime);
      const execution = controller.cron === NOTIFICATION_PLANNER_CRON
        ? (options.runScheduler ?? runNotificationScheduler)({
            d1: runtimeEnv.DB,
            now,
          }).then((summary) => {
            const technicalSummary = { cron: controller.cron, durationMs: Date.now() - startedAt, ...summary };
            if (options.logSchedulerSummary) options.logSchedulerSummary(technicalSummary);
            else console.info("notification_scheduler_cycle", technicalSummary);
          })
        : Promise.resolve().then(() => {
            if (options.runDispatcher) return options.runDispatcher({ d1: runtimeEnv.DB, now });
            return runAutomaticNotificationDispatcher({
              d1: runtimeEnv.DB,
              now,
              transport: new TelegramNotificationTransport({
                token: runtimeEnv.TELEGRAM_BOT_TOKEN ?? "",
                fetchImpl: globalThis.fetch.bind(globalThis),
              }),
            });
          }).then((summary) => {
            const technicalSummary = { cron: controller.cron, durationMs: Date.now() - startedAt, ...summary };
            if (options.logDispatcherSummary) options.logDispatcherSummary(technicalSummary);
            else console.info("notification_dispatcher_cycle", technicalSummary);
          });
      ctx.waitUntil(execution.catch(() => {
        console.error(controller.cron === NOTIFICATION_PLANNER_CRON
          ? "notification_scheduler_cycle_failed"
          : "notification_dispatcher_cycle_failed", {
            cron: controller.cron,
            durationMs: Date.now() - startedAt,
        });
      }));
    },
  };
}
