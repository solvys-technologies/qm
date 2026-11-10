import { parseSuggestedActivities, type SuggestedActivity } from "../../plugins/chassis/src/suggested-activities.ts";
import type { CronStore } from "../cron/cron-store.ts";
import { loopItemId, type LoopItemLedger } from "../loops/item-ledger.ts";
import { loopCronAction, type LoopStore } from "../loops/loop-store.ts";
import type { Loop, LoopItem } from "../loops/types.ts";
import type { Cron } from "../triggers/types.ts";
import { scopeId } from "../types.ts";
import { suggestionsPrompt } from "./prompt.ts";

export const SUGGESTIONS_SURFACE = "suggestions";
export const GENERATED_COUNT = 5;
export const VISIBLE_COUNT = 3;
const MAX_DISMISSED = 30;
const DISMISSED = "dismissed";
const SUPERSEDED = "superseded";
const STOCK_PLAYBOOK = "Generate suggested activities with the built-in suggestions task.";

export function isSuggestionsLoop(loop: Pick<Loop, "surface">): boolean {
  return loop.surface === SUGGESTIONS_SURFACE;
}

export interface SuggestionBatch {
  activities: SuggestedActivity[];
  depth: number;
  batchSize: number;
  batchAt: number;
  dismissed: Set<string>;
}

type SuggestionItemDeps = {
  loops: LoopStore;
  items: LoopItemLedger;
  crons: Pick<CronStore, "get" | "update">;
};

const activityOf = (item: LoopItem): SuggestedActivity => {
  const payload = item.sourcePayload ?? {};
  return {
    id: item.sourceKey,
    title: String(payload.title ?? ""),
    prompt: String(payload.prompt ?? ""),
    icon: String(payload.icon ?? ""),
  };
};

const batchAtOf = (item: LoopItem) => Number(item.sourcePayload?.batchAt ?? 0);
const rankOf = (item: LoopItem) => Number(item.sourcePayload?.rank ?? 0);

export function createSuggestionItems(deps: SuggestionItemDeps) {
  const closeAs = (loopId: string, id: string, kind: string) =>
    deps.items.recordAction(loopItemId(loopId, id), { kind, outcome: "dismissed" });

  const record = async (
    loopId: string,
    activities: Array<SuggestedActivity & { rank: number }>,
    batchAt: number,
  ): Promise<void> => {
    await deps.items.ingest(
      activities.map(({ rank, ...activity }) => ({
        loopId,
        dedupeKey: activity.id,
        source: SUGGESTIONS_SURFACE,
        summary: activity.title,
        sourcePayload: { title: activity.title, prompt: activity.prompt, icon: activity.icon, rank, batchAt },
        proposal: { data: { title: activity.title, prompt: activity.prompt, icon: activity.icon }, by: "agent" },
      })),
    );
  };

  const newestDismissed = (items: LoopItem[]) =>
    items
      .filter((item) => item.actionKind === DISMISSED)
      .toSorted((a, b) => (a.actedAt ?? 0) - (b.actedAt ?? 0))
      .slice(-MAX_DISMISSED);

  return {
    async ensureLoop(owner: string): Promise<Loop> {
      const ownerScopeId = scopeId("personal", owner);
      const { loop } = await deps.loops.create({
        owner,
        createdBy: owner,
        ownerScopeId,
        name: "Suggested activities",
        surface: SUGGESTIONS_SURFACE,
        purpose: "Suggested activities for the new-chat screen.",
        playbook: STOCK_PLAYBOOK,
        successCondition: "The new-chat screen has current suggestions.",
      });
      return loop;
    },

    getLoop: (loopId: string) => deps.loops.get(loopId),

    async bind(loop: Loop, cron: Cron, customTask: string | undefined): Promise<void> {
      if (customTask && loop.playbook === STOCK_PLAYBOOK)
        await deps.loops.editPlaybook(loop.id, { playbook: customTask, by: loop.owner, note: "migrated cron task" });
      if (cron.loopId !== loop.id || cron.action !== loopCronAction(loop.id))
        await deps.crons.update(cron.id, {
          loopId: loop.id,
          action: loopCronAction(loop.id),
          ...(cron.runtime ? { runtime: null } : {}),
        });
      if (loop.cronId !== cron.id) await deps.loops.update(loop.id, { cronId: cron.id });
    },

    async current(loopId: string): Promise<SuggestionBatch> {
      const all = await deps.items.byLoop(loopId);
      const batchAt = Math.max(0, ...all.map(batchAtOf));
      const open = all
        .filter((item) => item.status === "ready")
        .toSorted((a, b) => batchAtOf(b) - batchAtOf(a) || rankOf(a) - rankOf(b));
      return {
        activities: open.map(activityOf),
        depth: open.length,
        batchSize: all.filter((item) => batchAtOf(item) === batchAt).length,
        batchAt,
        dismissed: new Set(all.filter((item) => item.actionKind === DISMISSED).map((item) => item.sourceKey)),
      };
    },

    async dismiss(loopId: string, id: string, fallback?: SuggestedActivity): Promise<boolean> {
      const item = await deps.items.get(loopItemId(loopId, id));
      if (item?.status === "ready") return !!(await closeAs(loopId, id, DISMISSED));
      if (item || !fallback) return false;
      await record(loopId, [{ ...fallback, rank: 0 }], 0);
      return !!(await closeAs(loopId, id, DISMISSED));
    },

    async dismissedTitles(loopId: string): Promise<string[]> {
      return newestDismissed(await deps.items.byLoop(loopId)).map((item) => activityOf(item).title);
    },

    async importDismissed(loopId: string, entries: Array<{ id: string; title: string }>): Promise<void> {
      for (const entry of entries) {
        if (await deps.items.get(loopItemId(loopId, entry.id))) continue;
        await record(loopId, [{ ...entry, prompt: entry.title, icon: "", rank: 0 }], 0);
        await closeAs(loopId, entry.id, DISMISSED);
      }
    },

    async replaceBatch(loopId: string, activities: SuggestedActivity[], batchAt: number): Promise<void> {
      await record(
        loopId,
        activities.map((activity, rank) => ({ ...activity, rank })),
        batchAt,
      );
      const incoming = new Set(activities.map((activity) => activity.id));
      for (const item of await deps.items.byLoop(loopId))
        if (!incoming.has(item.sourceKey) && item.status === "ready") await closeAs(loopId, item.sourceKey, SUPERSEDED);
      await deps.items.prune(loopId, {
        maxItems: Number.MAX_SAFE_INTEGER,
        retentionMs: 0,
        keep: (item) => item.actionKind === DISMISSED,
      });
    },
  };
}

export type SuggestionItems = ReturnType<typeof createSuggestionItems>;

export interface SuggestionsPass {
  prompt(loop: Loop): Promise<string>;
  ingest(loop: Loop, reply: string, at: number): Promise<string>;
}

export function createSuggestionsPass(deps: {
  suggestions: SuggestionItems;
  seeds: (owner: string) => Promise<SuggestedActivity[]>;
  context?: string;
}): SuggestionsPass {
  return {
    async prompt(loop) {
      const customTask = loop.playbook === STOCK_PLAYBOOK ? undefined : loop.playbook;
      return suggestionsPrompt({
        ...(customTask ? { customTask } : {}),
        ...(deps.context ? { context: deps.context } : {}),
        seeds: customTask ? [] : await deps.seeds(loop.owner),
        dismissed: await deps.suggestions.dismissedTitles(loop.id),
      });
    },
    async ingest(loop, reply, at) {
      const activities = parseSuggestedActivities(reply.trim());
      if (activities.length < VISIBLE_COUNT || activities.length > GENERATED_COUNT)
        throw new Error(`expected ${VISIBLE_COUNT} to ${GENERATED_COUNT} suggestions, got ${activities.length}`);
      await deps.suggestions.replaceBatch(loop.id, activities, at);
      return `${activities.length} suggestions`;
    },
  };
}
