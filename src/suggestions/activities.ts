import type { SuggestedActivity } from "../../plugins/chassis/src/suggested-activities.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { CronStore } from "../cron/cron-store.ts";
import type { Scheduler } from "../cron/scheduler.ts";
import { claimManagedCron, nightlyAt, type ManagedCronClaim } from "../cron/managed.ts";
import { scopeId } from "../types.ts";
import type { Cron } from "../triggers/types.ts";
import type { Loop } from "../loops/types.ts";
import { LEGACY_MANAGED_PREFIX } from "./prompt.ts";
import { GENERATED_COUNT, VISIBLE_COUNT, suggestionsCronAction, type SuggestionItems } from "./loop-items.ts";

export interface SuggestedActivityProfile extends ManagedCronClaim {
  timezone: string;
  lastSeenAt: number;
  lastRefreshAt?: number;
  loopId?: string;
  seeds?: SuggestedActivity[];
  managedAction?: string;
  dismissed?: Array<{ id: string; title: string; at: number }>;
}

export interface SuggestedActivityResult {
  activities: SuggestedActivity[];
  pending: boolean;
}

const STALE_AFTER_MS = 4 * 60 * 60_000;
const REFILL_COOLDOWN_MS = 10 * 60_000;

export function createSuggestedActivityService(deps: {
  store: DurableMap<SuggestedActivityProfile>;
  suggestions: SuggestionItems;
  crons: CronStore;
  scheduler: Pick<Scheduler, "notifyChanged" | "runNow">;
  enabled: boolean;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const owned = (cron: Cron | null, principalId: string): cron is Cron =>
    !!cron && cron.owner === principalId && cron.ownerScopeId === scopeId("personal", principalId);

  const loopFor = async (principalId: string, profile: SuggestedActivityProfile): Promise<Loop> => {
    const stored = profile.loopId ? await deps.suggestions.getLoop(profile.loopId) : null;
    if (stored) return stored;
    const loop = await deps.suggestions.ensureLoop(principalId);
    await deps.store.merge(principalId, { loopId: loop.id });
    return loop;
  };

  const migrate = async (principalId: string, profile: SuggestedActivityProfile, loop: Loop, cron: Cron) => {
    if (cron.loopId === loop.id && loop.cronId === cron.id && !profile.dismissed && !profile.managedAction) return;
    const action = cron.action ?? "";
    const stock =
      action === suggestionsCronAction(loop.id) ||
      action === profile.managedAction ||
      action.startsWith(LEGACY_MANAGED_PREFIX);
    await deps.suggestions.bind(loop, cron, stock);
    if (profile.dismissed?.length) await deps.suggestions.importDismissed(loop.id, profile.dismissed);
    await deps.store.update(principalId, ({ dismissed: _dismissed, managedAction: _managedAction, ...value }) => value);
  };

  const claimRefresh = async (principalId: string, gapMs: number, since = 0): Promise<boolean> => {
    const timestamp = now();
    let won = false;
    await deps.store.update(principalId, (value) => {
      const last = value.lastRefreshAt ?? 0;
      won = last < since || last <= timestamp - gapMs;
      return won ? { ...value, lastRefreshAt: timestamp } : value;
    });
    return won;
  };

  return {
    async get(
      principalId: string,
      seeds: SuggestedActivity[],
      {
        timezone = "UTC",
        poll = false,
        refresh = false,
      }: { timezone?: string; poll?: boolean; refresh?: boolean } = {},
    ): Promise<SuggestedActivityResult> {
      if (!deps.enabled) return { activities: seeds.slice(0, GENERATED_COUNT), pending: false };
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      let profile = await deps.store.putIfAbsent(principalId, { timezone, lastSeenAt: now() });
      const seen = poll ? {} : { lastSeenAt: now() };
      await deps.store.merge(principalId, { ...seen, seeds });
      profile = { ...profile, ...seen, seeds };
      const loop = await loopFor(principalId, profile);
      if (!profile.cronId || profile.arming) {
        profile = await claimManagedCron(deps, principalId, profile, {
          owner: principalId,
          createdBy: principalId,
          ownerScopeId: scopeId("personal", principalId),
          title: "Refresh my suggested activities",
          schedule: { cron: nightlyAt(principalId, 2), timezone: profile.timezone },
          action: suggestionsCronAction(loop.id),
          loopId: loop.id,
        });
      }
      const dismissed = await deps.suggestions.dismissedIds(loop.id);
      const fallback = seeds.filter((seed) => !dismissed.has(seed.id)).slice(0, GENERATED_COUNT);
      const cron = await deps.crons.get(profile.cronId!);
      if (!owned(cron, principalId) || cron.archived) return { activities: fallback, pending: false };
      await migrate(principalId, profile, loop, cron);
      const batch = await deps.suggestions.current(loop.id);
      const { runs } = await deps.crons.listFires(cron.id, { limit: 10 });
      let pending = runs.some((run) => run.status === "running");
      if (!pending && cron.enabled) {
        const reserveExhausted = batch.depth === 0 || (batch.depth <= VISIBLE_COUNT && batch.depth < batch.batchSize);
        const claimed =
          ((refresh || !poll) &&
            reserveExhausted &&
            (await claimRefresh(principalId, REFILL_COOLDOWN_MS, batch.batchAt))) ||
          (batch.batchAt <= now() - STALE_AFTER_MS && (await claimRefresh(principalId, STALE_AFTER_MS)));
        if (claimed) {
          const result = await deps.scheduler.runNow(cron.id);
          pending = result.started || result.reason === "already_running";
        }
      }
      return { activities: batch.depth ? batch.activities : fallback, pending };
    },

    async dismiss(principalId: string, id: string): Promise<boolean> {
      if (!deps.enabled) return false;
      const profile = await deps.store.get(principalId);
      if (!profile?.loopId) return false;
      const seed = profile.seeds?.find((candidate) => candidate.id === id);
      return deps.suggestions.dismiss(profile.loopId, id, seed);
    },

    async skipFire(cron: Cron): Promise<string | undefined> {
      if (!cron.ownerScopeId.startsWith("personal:")) return undefined;
      const profile = await deps.store.get(cron.owner);
      if (profile?.cronId !== cron.id) return undefined;
      if (!deps.enabled) return "suggested activities are turned off";
      const { runs } = await deps.crons.listFires(cron.id, { limit: 1 });
      const last = runs.at(-1);
      return last && profile.lastSeenAt <= last.firedAt ? "no new sessions opened since the last refresh" : undefined;
    },
  };
}
