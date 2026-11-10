import assert from "node:assert/strict";
import test from "node:test";
import { createSuggestedActivityService, type SuggestedActivityProfile } from "../src/suggestions/activities.ts";
import { createSuggestionItems, createSuggestionsPass, SUGGESTIONS_SURFACE } from "../src/suggestions/loop-items.ts";
import { LEGACY_MANAGED_PREFIX } from "../src/suggestions/prompt.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createScheduler } from "../src/cron/scheduler.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import { createLoopOutputStore } from "../src/loops/output-store.ts";
import { createShipGrantStore } from "../src/loops/ship-grant-store.ts";
import { createLoopFireService } from "../src/loops/loop-fire.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { testDatabaseUrl, testMap } from "./support/test-database.ts";
import { createPostgresCronFireStore } from "../src/cron/fire-store.ts";

const batch = (ids: string[]) =>
  ids.map((id) => ({ id, title: `Build my ${id}`, prompt: "Help me with this project.", icon: "🛠️" }));

const ids = (result: { activities: Array<{ id: string }> }) => result.activities.map((activity) => activity.id);

function fixture(opts: { enabled?: boolean } = {}) {
  let time = Date.now();
  let output = JSON.stringify(batch(["app", "brief", "deck", "hire", "plan"]));
  const store = testMap<SuggestedActivityProfile>();
  const crons = createCronStore(testMap(), { fires: createPostgresCronFireStore(testDatabaseUrl()) });
  const loops = createLoopStore(testMap());
  const items = createLoopItemLedger(testMap());
  const suggestions = createSuggestionItems({ loops, items, crons });
  const deliveries = createDeliveryStore();
  const idempotency = createIdempotencyStore(testMap());
  const identity = createIdentityService(testMap(), { externalMembers: testMap() });
  const prompts: string[] = [];
  const settled: Promise<void>[] = [];
  const run = async (request: TurnRequest) => {
    prompts.push(request.text ?? "");
    return { status: "ok" as const, reply: output, sessionId: `s${prompts.length}` };
  };
  const loopFire = createLoopFireService({
    loops,
    crons,
    items,
    outputs: createLoopOutputStore(testMap()),
    grants: createShipGrantStore(testMap()),
    files: { listOwnedByScopes: async () => ({ files: [] }), open: async () => null } as never,
    suggestionsPass: createSuggestionsPass({
      suggestions,
      crons,
      seeds: async (owner) => (await store.get(owner))?.seeds ?? [],
      context: "Deployment context.",
    }),
    trigger: { deliveries, idempotency, identity, run },
  });
  const scheduler = createScheduler({
    ...singleProcessDeps(),
    now: () => time,
    crons,
    deliveries,
    identity,
    idempotency,
    run,
    fireLoop: (loopId, fireKey, cronId) => loopFire.fire(loopId, fireKey, cronId),
  });
  const service = createSuggestedActivityService({
    store,
    suggestions,
    crons,
    enabled: opts.enabled ?? true,
    now: () => time,
    scheduler: {
      notifyChanged: (id: string) => scheduler.notifyChanged(id),
      runNow: async (id: string) => {
        const result = await scheduler.runNow(id);
        if (result.started) settled.push(result.settled);
        return result;
      },
    },
  });
  return {
    service,
    scheduler,
    store,
    crons,
    loops,
    items,
    prompts,
    settle: () => Promise.all(settled.splice(0)),
    advance: (ms: number) => {
      time += ms;
    },
    output: (value: string) => {
      output = value;
    },
  };
}

async function primed(f: ReturnType<typeof fixture>, principal = "alice") {
  await f.service.get(principal, [], { timezone: "America/Los_Angeles" });
  await f.settle();
  return f.service.get(principal, [], { poll: true });
}

test("a fresh user gets one hidden suggestions loop bound to the nightly cron, and items after a fire", async () => {
  const f = fixture();
  const first = await f.service.get("alice", [], { timezone: "America/Los_Angeles" });
  assert.equal(first.pending, true);
  await f.settle();
  const result = await f.service.get("alice", [], { poll: true });
  assert.deepEqual(ids(result), ["app", "brief", "deck", "hire", "plan"]);
  assert.equal(result.pending, false);
  const [loop, ...others] = await f.loops.list();
  assert.equal(others.length, 0);
  assert.equal(loop!.surface, SUGGESTIONS_SURFACE);
  const cron = await f.crons.get(loop!.cronId!);
  assert.equal(cron!.loopId, loop!.id);
  assert.equal(cron!.ownerScopeId, scopeId("personal", "alice"));
  assert.ok(f.prompts[0]!.startsWith(LEGACY_MANAGED_PREFIX));
  assert.match(f.prompts[0]!, /Deployment context\./);
  assert.equal(f.prompts.length, 1);
});

test("dismissing closes the item and a reserve item takes its place without a refill", async () => {
  const f = fixture();
  await primed(f);
  assert.equal(await f.service.dismiss("alice", "app"), true);
  assert.equal(await f.service.dismiss("alice", "app"), false);
  const result = await f.service.get("alice", [], { poll: true, refresh: true });
  assert.deepEqual(ids(result), ["brief", "deck", "hire", "plan"]);
  assert.equal(result.pending, false);
  assert.equal(f.prompts.length, 1);
});

test("dismissing past the reserve refills once, supersedes the old batch, and never suggests dismissed titles again", async () => {
  const f = fixture();
  await primed(f);
  await f.service.dismiss("alice", "app");
  await f.service.dismiss("alice", "brief");
  f.output(JSON.stringify(batch(["deck", "memo", "tour", "talk", "wiki"])));
  const refill = await f.service.get("alice", [], { poll: true, refresh: true });
  assert.equal(refill.pending, true);
  assert.equal((await f.service.get("alice", [], { poll: true, refresh: true })).pending, true);
  await f.settle();
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[1]!, /Do not suggest them or close variants again:\n\["Build my app","Build my brief"\]/);
  const result = await f.service.get("alice", [], { poll: true });
  assert.deepEqual(ids(result), ["deck", "memo", "tour", "talk", "wiki"]);
  assert.equal(result.pending, false);
  f.output(JSON.stringify(batch(["app", "brief", "hire", "plan", "deck"])));
  f.advance(5 * 60 * 60_000);
  await f.service.get("alice", []);
  await f.settle();
  assert.deepEqual(ids(await f.service.get("alice", [], { poll: true })), ["hire", "plan", "deck"]);
});

test("a three-item custom batch does not refill on every visit", async () => {
  const f = fixture();
  f.output(JSON.stringify(batch(["one", "two", "six"])));
  await primed(f);
  await f.service.get("alice", [], { refresh: true });
  await f.service.get("alice", []);
  assert.equal(f.prompts.length, 1);
});

test("a failed fire keeps serving seeds and retries only after the cooldown", async () => {
  const f = fixture();
  f.output("not json");
  const seeds = batch(["seed"]);
  const result = await primed(f);
  assert.deepEqual(ids(await f.service.get("alice", seeds, { poll: true })), ["seed"]);
  assert.equal(result.pending, false);
  await f.service.get("alice", seeds);
  assert.equal(f.prompts.length, 1);
  f.advance(11 * 60_000);
  await f.service.get("alice", seeds);
  await f.settle();
  assert.equal(f.prompts.length, 2);
});

test("dismissed fallback seeds stay hidden", async () => {
  const f = fixture();
  f.output("not json");
  const seeds = batch(["seed", "other"]);
  await f.service.get("alice", seeds);
  await f.settle();
  assert.equal(await f.service.dismiss("alice", "seed"), true);
  assert.deepEqual(ids(await f.service.get("alice", seeds, { poll: true })), ["other"]);
});

test("an existing user with a customized cron task migrates intact, keeping legacy dismissals", async () => {
  const f = fixture();
  const custom = "Generate three suggestions about my reviews. Return a JSON array.";
  const cron = await f.crons.create({
    owner: "bob",
    createdBy: "bob",
    ownerScopeId: scopeId("personal", "bob"),
    title: "Refresh my suggested activities",
    schedule: { cron: "0 2 * * *", timezone: "UTC" },
    action: custom,
  });
  await f.store.put("bob", {
    timezone: "UTC",
    lastSeenAt: 0,
    cronId: cron.id,
    managedAction: `${LEGACY_MANAGED_PREFIX}old`,
    dismissed: [{ id: "old", title: "Old idea", at: 1 }],
  });
  f.output(JSON.stringify(batch(["one", "two", "six"])));
  await f.service.get("bob", []);
  await f.settle();
  const migrated = await f.crons.get(cron.id);
  assert.equal(migrated!.action, custom);
  assert.ok(migrated!.loopId);
  assert.equal((await f.loops.get(migrated!.loopId!))!.cronId, cron.id);
  assert.equal(
    f.prompts[0],
    `${custom}\n\nThe owner dismissed these suggestions. Do not suggest them or close variants again:\n["Old idea"]`,
  );
  assert.deepEqual(ids(await f.service.get("bob", [], { poll: true })), ["one", "two", "six"]);
  const profile = await f.store.get("bob");
  assert.equal(profile!.dismissed, undefined);
  assert.equal(profile!.managedAction, undefined);
});

test("an existing user on the stock task migrates to the code prompt", async () => {
  const f = fixture();
  const cron = await f.crons.create({
    owner: "carol",
    createdBy: "carol",
    ownerScopeId: scopeId("personal", "carol"),
    title: "Refresh my suggested activities",
    schedule: { cron: "0 2 * * *", timezone: "UTC" },
    action: `${LEGACY_MANAGED_PREFIX}stale guidance`,
  });
  await f.store.put("carol", { timezone: "UTC", lastSeenAt: 0, cronId: cron.id });
  await f.service.get("carol", []);
  await f.settle();
  const migrated = await f.crons.get(cron.id);
  assert.equal(migrated!.action, `fire loop ${migrated!.loopId}`);
  assert.match(f.prompts[0]!, /Deployment context\./);
  assert.doesNotMatch(f.prompts[0]!, /stale guidance/);
});

test("nightly fires skip when nothing was opened since the last refresh, and when the feature is off", async () => {
  const f = fixture();
  await primed(f);
  const cron = (await f.crons.list())[0]!;
  const skipped = createSuggestedActivityService({
    store: f.store,
    suggestions: createSuggestionItems({ loops: f.loops, items: f.items, crons: f.crons }),
    crons: f.crons,
    enabled: false,
    scheduler: { notifyChanged: () => {}, runNow: async () => ({ started: false, reason: "disabled" }) as never },
  });
  assert.equal(await skipped.skipFire(cron), "suggested activities are turned off");
  assert.equal(await f.service.skipFire(cron), "no new sessions opened since the last refresh");
  f.advance(60_000);
  await f.service.get("alice", []);
  assert.equal(await f.service.skipFire(cron), undefined);
});

test("each principal has an independent loop and cron", async () => {
  const f = fixture();
  await primed(f, "alice");
  await primed(f, "dave");
  const loops = await f.loops.list();
  assert.equal(new Set(loops.map((loop) => loop.owner)).size, 2);
  assert.equal(new Set(loops.map((loop) => loop.cronId)).size, 2);
});
