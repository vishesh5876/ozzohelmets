/**
 * Minimal Prometheus text-format registry (no dependency). Labels must be LOW-CARDINALITY and
 * NON-PERSONAL: route templates, methods, status classes, fixed enum values. Never put Helmet
 * IDs, Customer IDs, emails, IPs, tokens or medical values in a label.
 */
type Labels = Record<string, string>;

const escape = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const labelKey = (labels: Labels) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escape(labels[k]!)}"`)
    .join(',');

interface Metric {
  name: string;
  help: string;
  render(): string[];
}

export class Counter implements Metric {
  private readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, by = 1): void {
    const k = labelKey(labels);
    this.values.set(k, (this.values.get(k) ?? 0) + by);
  }

  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [k, v] of this.values) out.push(`${this.name}${k ? `{${k}}` : ''} ${v}`);
    return out;
  }
}

export class Histogram implements Metric {
  private readonly series = new Map<string, { buckets: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    private readonly bounds: number[],
  ) {}

  observe(labels: Labels, value: number): void {
    const k = labelKey(labels);
    let s = this.series.get(k);
    if (!s) {
      s = { buckets: this.bounds.map(() => 0), sum: 0, count: 0 };
      this.series.set(k, s);
    }
    this.bounds.forEach((b, i) => {
      if (value <= b) s.buckets[i]! += 1;
    });
    s.sum += value;
    s.count += 1;
  }

  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [k, s] of this.series) {
      const sep = k ? `${k},` : '';
      this.bounds.forEach((b, i) =>
        out.push(`${this.name}_bucket{${sep}le="${b}"} ${s.buckets[i]}`),
      );
      out.push(`${this.name}_bucket{${sep}le="+Inf"} ${s.count}`);
      out.push(`${this.name}_sum${k ? `{${k}}` : ''} ${s.sum}`);
      out.push(`${this.name}_count${k ? `{${k}}` : ''} ${s.count}`);
    }
    return out;
  }
}

/** Value computed at scrape time (process stats, DB-derived freshness). */
export interface GaugeSample {
  labels?: Labels;
  value: number;
}

export function renderGauge(name: string, help: string, samples: GaugeSample[]): string[] {
  const out = [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`];
  for (const s of samples) {
    const k = labelKey(s.labels ?? {});
    out.push(`${name}${k ? `{${k}}` : ''} ${Number.isFinite(s.value) ? s.value : 0}`);
  }
  return out;
}

class Registry {
  private readonly metrics: Metric[] = [];
  register<T extends Metric>(m: T): T {
    this.metrics.push(m);
    return m;
  }
  render(): string[] {
    return this.metrics.flatMap((m) => m.render());
  }
}

export const registry = new Registry();

const SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Process-wide application metrics (one API process = one registry). */
export const metrics = {
  httpRequests: registry.register(
    new Counter(
      'helmet_http_requests_total',
      'HTTP requests by route template, method and status class',
    ),
  ),
  httpDuration: registry.register(
    new Histogram(
      'helmet_http_request_duration_seconds',
      'HTTP request duration by route template',
      SECONDS,
    ),
  ),
  auditEvents: registry.register(
    new Counter(
      'helmet_audit_events_total',
      'Audited domain events by action (activation, logins, uploads, lifecycle…)',
    ),
  ),
  dependencyUnavailable: registry.register(
    new Counter(
      'helmet_dependency_unavailable_total',
      'Requests affected by an unavailable dependency, by dependency and handling',
    ),
  ),
  uploads: registry.register(
    new Counter('helmet_uploads_total', 'File uploads by kind and result'),
  ),
  passwordHashRejected: registry.register(
    new Counter(
      'helmet_password_hash_rejected_total',
      'Logins/activations refused with 503 because the Argon2 queue was full (protects emergency pages)',
    ),
  ),
};
