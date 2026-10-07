// Push subscription store — a durable JSON list of the browser Web Push
// subscriptions this AgileHarness instance may notify. Single-user dev tool, so a flat
// file (atomic tmp+rename write) in the gitignored runner state dir is enough — no
// DB, and it never leaks into git (storymap/.runner/ is ignored). Server-only (node:fs).
//
// A PushSubscription is the opaque handle the browser's push service hands back on
// pushManager.subscribe(); the server later POSTs an encrypted payload to its
// `endpoint`. We key by endpoint (unique per browser+device) so re-subscribing the
// same device replaces rather than duplicates.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runnerStateDir } from "@/lib/storymap/paths";
import type { PushSubscription } from "web-push";

function storePath(): string {
  return path.join(runnerStateDir(), "push-subscriptions.json");
}

/** Every stored subscription (empty on missing/corrupt file — never throws). */
export function loadSubscriptions(): PushSubscription[] {
  try {
    const arr = JSON.parse(readFileSync(storePath(), "utf8"));
    return Array.isArray(arr) ? (arr as PushSubscription[]) : [];
  } catch {
    return [];
  }
}

// Atomic write: serialize to a per-pid temp file then rename over the target, so a
// concurrent reader never sees a half-written list (mirrors serialize.ts's pattern).
function persist(subs: PushSubscription[]): void {
  const dir = runnerStateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${storePath()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(subs, null, 2), "utf8");
  renameSync(tmp, storePath());
}

/** Add (or replace, by endpoint) a subscription. */
export function addSubscription(sub: PushSubscription): void {
  const subs = loadSubscriptions().filter((s) => s.endpoint !== sub.endpoint);
  subs.push(sub);
  persist(subs);
}

/** Drop a subscription by its endpoint (on unsubscribe, or when the push service 404/410s). */
export function removeSubscription(endpoint: string): void {
  persist(loadSubscriptions().filter((s) => s.endpoint !== endpoint));
}

// O «Agora não» do item «Ative o aviso no celular» do Inbox: o dono que não quer push não é lembrado em todo Inbox.
// Um arquivo no estado do runner (gitignored), como as inscrições — durável entre reinícios, nunca no git.
function offerDismissedPath(): string {
  return path.join(runnerStateDir(), "push-offer-dismissed.json");
}

/** O dono dispensou a oferta de ativar o aviso? (arquivo ausente/ilegível = não — nunca lança.) */
export function isPushOfferDismissed(): boolean {
  try {
    const v = JSON.parse(readFileSync(offerDismissedPath(), "utf8")) as { at?: unknown };
    return typeof v?.at === "string";
  } catch {
    return false;
  }
}

/** Grava a dispensa da oferta (escrita atômica, como `persist`). */
export function dismissPushOffer(at: string): void {
  const dir = runnerStateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${offerDismissedPath()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ at }), "utf8");
  renameSync(tmp, offerDismissedPath());
}
