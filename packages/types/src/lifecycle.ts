import { ActorType, HelmetStatus } from './enums';

/**
 * Allowed helmet status transitions, keyed by source status.
 * Each target lists the actor types permitted to perform it.
 * See docs/HELMET-LIFECYCLE.md for the rationale behind every edge.
 */
type TransitionTable = Record<HelmetStatus, Partial<Record<HelmetStatus, readonly ActorType[]>>>;

const A = ActorType.ADMIN;
const S = ActorType.SYSTEM;
const O = ActorType.OWNER;

export const HELMET_STATUS_TRANSITIONS: TransitionTable = {
  GENERATED: { PRINTED: [A, S], DEACTIVATED: [A] },
  PRINTED: { IN_INVENTORY: [A], DAMAGED: [A], DEACTIVATED: [A], RECALLED: [A] },
  IN_INVENTORY: { SOLD: [A], ACTIVATED: [S], DAMAGED: [A], DEACTIVATED: [A], RECALLED: [A] },
  SOLD: { ACTIVATED: [S], IN_INVENTORY: [A], DAMAGED: [A], DEACTIVATED: [A], RECALLED: [A] },
  ACTIVATED: {
    ACTIVE: [S, O],
    LOST: [O, A],
    STOLEN: [O, A],
    DAMAGED: [O, A],
    RECALLED: [A],
    DEACTIVATED: [A],
  },
  ACTIVE: {
    // Owner disabled the emergency profile.
    ACTIVATED: [S, O],
    LOST: [O, A],
    STOLEN: [O, A],
    DAMAGED: [O, A],
    REPLACED: [A],
    RECALLED: [A],
    DEACTIVATED: [A],
  },
  LOST: { ACTIVE: [O, A], STOLEN: [O, A], REPLACED: [A], DEACTIVATED: [A] },
  STOLEN: { ACTIVE: [O, A], REPLACED: [A], DEACTIVATED: [A] },
  DAMAGED: { REPLACED: [A], DEACTIVATED: [A] },
  RECALLED: { REPLACED: [A], DEACTIVATED: [A] },
  REPLACED: {},
  DEACTIVATED: {},
};

/**
 * Statuses from which a customer may always activate a helmet. The API's ActivationPolicy is
 * the single place that applies this (plus the configurable IN_INVENTORY allowance).
 */
export const ACTIVATABLE_STATUSES: readonly HelmetStatus[] = [HelmetStatus.SOLD];
/** Activatable only while the temporary `ACTIVATION_ALLOW_IN_INVENTORY` allowance is on. */
export const CONDITIONALLY_ACTIVATABLE_STATUSES: readonly HelmetStatus[] = [
  HelmetStatus.IN_INVENTORY,
];

export function allowedTransitions(from: HelmetStatus, actor: ActorType): HelmetStatus[] {
  const edges = HELMET_STATUS_TRANSITIONS[from];
  return (Object.keys(edges) as HelmetStatus[]).filter((to) => edges[to]?.includes(actor));
}

export function canTransition(from: HelmetStatus, to: HelmetStatus, actor: ActorType): boolean {
  return HELMET_STATUS_TRANSITIONS[from][to]?.includes(actor) ?? false;
}
