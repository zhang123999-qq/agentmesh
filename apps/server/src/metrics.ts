/**
 * Minimal, dependency-free Prometheus metrics registry (US observability).
 *
 * Why not `prom-client`: adding a runtime dependency requires regenerating the
 * lockfile, which the local npm/arborist bug cannot do; a tiny in-house registry
 * keeps the surface auditable and avoids that. It supports counters, gauges and
 * fixed-bucket histograms and renders the Prometheus text exposition format.
 *
 * Cardinality rules (see decisions.md):
 * - `method` (26) and `code` (a handful) are safe label keys.
 * - taskId / agentId / workspaceId must NEVER be labels (unbounded cardinality);
 *   tenant-level facts are exposed as aggregate gauges only.
 */

export type MetricLabels = Record<string, string | number>;

const DEFAULT_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const;

function labelKey(labels: MetricLabels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
}

function renderLabelSet(labels: MetricLabels, extra?: string): string {
  const pairs = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  if (extra !== undefined) pairs.push(extra);
  return pairs.length === 0 ? '' : `{${pairs.join(',')}}`;
}

interface CounterSeries {
  labels: MetricLabels;
  value: number;
}
interface GaugeSeries {
  labels: MetricLabels;
  value: number;
}
interface HistogramSeries {
  labels: MetricLabels;
  counts: number[];
  sum: number;
  count: number;
}

interface MetricEntry {
  type: 'counter' | 'gauge' | 'histogram';
  help: string;
  buckets?: number[];
  counters?: Map<string, CounterSeries>;
  gauges?: Map<string, GaugeSeries>;
  histograms?: Map<string, HistogramSeries>;
}

export class MetricsRegistry {
  readonly #metrics = new Map<string, MetricEntry>();

  #entry(
    name: string,
    type: MetricEntry['type'],
    help: string,
    buckets?: number[],
  ): MetricEntry {
    let entry = this.#metrics.get(name);
    if (entry === undefined) {
      entry = { type, help, ...(buckets === undefined ? {} : { buckets }) };
      if (type === 'counter') entry.counters = new Map();
      if (type === 'gauge') entry.gauges = new Map();
      if (type === 'histogram') entry.histograms = new Map();
      this.#metrics.set(name, entry);
    }
    return entry;
  }

  incCounter(name: string, labels: MetricLabels = {}, help = ''): void {
    const entry = this.#entry(name, 'counter', help);
    const key = labelKey(labels);
    const series = entry.counters!.get(key) ?? { labels, value: 0 };
    series.value += 1;
    entry.counters!.set(key, series);
  }

  setGauge(name: string, value: number, labels: MetricLabels = {}, help = ''): void {
    const entry = this.#entry(name, 'gauge', help);
    entry.gauges!.set(labelKey(labels), { labels, value });
  }

  observe(
    name: string,
    value: number,
    labels: MetricLabels = {},
    help = '',
    buckets: number[] = [...DEFAULT_BUCKETS_MS],
  ): void {
    const entry = this.#entry(name, 'histogram', help, buckets);
    const key = labelKey(labels);
    const series =
      entry.histograms!.get(key) ??
      { labels, counts: new Array(buckets.length).fill(0), sum: 0, count: 0 };
    series.sum += value;
    series.count += 1;
    for (let i = 0; i < buckets.length; i += 1) {
      if (value <= buckets[i]!) series.counts[i] = (series.counts[i] ?? 0) + 1;
    }
    entry.histograms!.set(key, series);
  }

  /** Render the whole registry in Prometheus text exposition format. */
  render(): string {
    const lines: string[] = [];
    for (const [name, entry] of [...this.#metrics.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`# HELP ${name} ${entry.help}`);
      lines.push(`# TYPE ${name} ${entry.type}`);
      if (entry.type === 'counter') {
        for (const series of entry.counters!.values()) {
          lines.push(`${name}${renderLabelSet(series.labels)} ${series.value}`);
        }
      } else if (entry.type === 'gauge') {
        for (const series of entry.gauges!.values()) {
          lines.push(`${name}${renderLabelSet(series.labels)} ${series.value}`);
        }
      } else {
        const buckets = entry.buckets!;
        for (const series of entry.histograms!.values()) {
          let cumulative = 0;
          for (let i = 0; i < buckets.length; i += 1) {
            cumulative += series.counts[i] ?? 0;
            lines.push(
              `${name}_bucket${renderLabelSet(series.labels, `le="${buckets[i]}"`)} ${cumulative}`,
            );
          }
          lines.push(`${name}_bucket${renderLabelSet(series.labels, 'le="+Inf"')} ${series.count}`);
          lines.push(`${name}_sum${renderLabelSet(series.labels)} ${series.sum}`);
          lines.push(`${name}_count${renderLabelSet(series.labels)} ${series.count}`);
        }
      }
    }
    return `${lines.join('\n')}\n`;
  }
}
