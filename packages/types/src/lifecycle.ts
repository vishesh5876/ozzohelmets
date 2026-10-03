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
    // Owner enabled emergency information for this helmet.
    ACTIVE: [S, O],
    LOST: [O, A],
    STOLEN: [O, A],
    DAMAGED: [O, A],
    REPLACED: [A],
    RECALLED: [A],
    DEACTIVATED: [O, A],
  },
  ACTIVE: {
    // Owner disabled emergency information, ownership transferred (S) or revoked (A).
    ACTIVATED: [S, O, A],
    LOST: [O, A],
    STOLEN: [O, A],
    DAMAGED: [O, A],
    REPLACED: [A],
    RECALLED: [A],
    DEACTIVATED: [O, A],
  },
  // Restores (→ ACTIVE/ACTIVATED) go through HelmetLifecycleService, which picks the target.
  LOST: { ACTIVE: [O, A], ACTIVATED: [O, A], STOLEN: [O, A], REPLACED: [A], DEACTIVATED: [O, A] },
  STOLEN: { ACTIVE: [O, A], ACTIVATED: [O, A], REPLACED: [A], DEACTIVATED: [O, A] },
  // Damage can only be undone by support (e.g. marked by mistake).
  DAMAGED: { ACTIVE: [A], ACTIVATED: [A], REPLACED: [A], DEACTIVATED: [O, A] },
  RECALLED: { REPLACED: [A], DEACTIVATED: [A] },
  REPLACED: {},
  // Retirement is only reversible by support, back to the owner's ACTIVATED state.
  DEACTIVATED: { ACTIVATED: [A] },
};

/** Statuses in which a helmet is in normal use by its owner. */
export const OPERATIONAL_STATUSES: readonly HelmetStatus[] = [
  HelmetStatus.ACTIVATED,
  HelmetStatus.ACTIVE,
];
/** Ownership can only be transferred from these statuses. */
export const TRANSFERABLE_STATUSES: readonly HelmetStatus[] = OPERATIONAL_STATUSES;
/** Temporary problem states; `previousOperationalStatus` remembers where to return. */
export const INTERRUPTED_STATUSES: readonly HelmetStatus[] = [
  HelmetStatus.LOST,
  HelmetStatus.STOLEN,
  HelmetStatus.DAMAGED,
];
/**
 * Targets the generic admin status endpoint may not set: operational states are reached only
 * through activation, emergency enablement, transfer or the support restore action.
 */
export const LIFECYCLE_MANAGED_TARGETS: readonly HelmetStatus[] = OPERATIONAL_STATUSES;

/** Explicit owner actions (never a generic "set status"). */
export const OwnerHelmetAction = {
  TRANSFER: 'TRANSFER',
  REPORT_LOST: 'REPORT_LOST',
  MARK_FOUND: 'MARK_FOUND',
  REPORT_STOLEN: 'REPORT_STOLEN',
  MARK_RECOVERED: 'MARK_RECOVERED',
  MARK_DAMAGED: 'MARK_DAMAGED',
  RETIRE: 'RETIRE',
  ENABLE_EMERGENCY: 'ENABLE_EMERGENCY',
  DISABLE_EMERGENCY: 'DISABLE_EMERGENCY',
} as const;
export type OwnerHelmetAction = (typeof OwnerHelmetAction)[keyof typeof OwnerHelmetAction];

/** Single source for which owner actions make sense in a status (API enforces; UI displays). */
export function ownerActions(status: HelmetStatus): OwnerHelmetAction[] {
  switch (status) {
    case HelmetStatus.ACTIVATED:
      return [
        'ENABLE_EMERGENCY',
        'TRANSFER',
        'REPORT_LOST',
        'REPORT_STOLEN',
        'MARK_DAMAGED',
        'RETIRE',
      ];
    case HelmetStatus.ACTIVE:
      return [
        'DISABLE_EMERGENCY',
        'TRANSFER',
        'REPORT_LOST',
        'REPORT_STOLEN',
        'MARK_DAMAGED',
        'RETIRE',
      ];
    case HelmetStatus.LOST:
      return ['MARK_FOUND', 'REPORT_STOLEN', 'RETIRE'];
    case HelmetStatus.STOLEN:
      return ['MARK_RECOVERED', 'RETIRE'];
    case HelmetStatus.DAMAGED:
      return ['RETIRE'];
    default:
      return [];
  }
}

export type HelmetListGroup = 'ACTIVE' | 'NEEDS_ATTENTION' | 'RETIRED';

/** How "My helmets" groups a helmet. */
export function helmetListGroup(status: HelmetStatus): HelmetListGroup {
  if (OPERATIONAL_STATUSES.includes(status)) return 'ACTIVE';
  if (INTERRUPTED_STATUSES.includes(status) || status === HelmetStatus.RECALLED)
    return 'NEEDS_ATTENTION';
  return 'RETIRED';
}

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
