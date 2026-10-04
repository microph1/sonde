/** Column names are ClickHouse's, unchanged: the rows are piped from the
 * database to the browser without an intermediate shape to keep in sync. */

export interface Attributes {
  readonly [key: string]: string;
}

export interface Span {
  readonly Timestamp: string;
  readonly TraceId: string;
  readonly SpanId: string;
  readonly ParentSpanId: string;
  readonly SpanName: string;
  readonly SpanKind: string;
  readonly ServiceName: string;
  /** Nanoseconds. */
  readonly Duration: number;
  readonly StatusCode: string;
  readonly StatusMessage: string;
  readonly ScopeName: string;
  readonly SpanAttributes: Attributes;
  readonly ResourceAttributes: Attributes;
  readonly EventsTimestamp?: string[];
  readonly EventsName?: string[];
  readonly EventsAttributes?: Attributes[];
}

export interface LogRecord {
  readonly Timestamp: string;
  readonly ServiceName: string;
  readonly SeverityText: string;
  readonly SeverityNumber: number;
  readonly Body: string;
  readonly TraceId: string;
  readonly SpanId: string;
  readonly ScopeName: string;
  readonly LogAttributes: Attributes;
  readonly ResourceAttributes: Attributes;
}

export interface ServiceSummary {
  readonly ServiceName: string;
  readonly traces: number;
  readonly logs: number;
  /** Metric points, counted so a service that exports nothing else still
   * registers as alive. */
  readonly metrics: number;
  readonly lastSeen: string;
}

/**
 * One trace, as the list shows it: when it started, what it entered through,
 * and how big it turned out to be. Not a span — the page lists traces.
 */
export interface TraceRow {
  readonly TraceId: string;
  readonly StartedAt: string;
  readonly RootName: string;
  readonly RootService: string;
  readonly Spans: number;
  readonly Services: number;
  readonly Errors: number;
  /** Nanoseconds, wall time across the whole trace. */
  readonly TotalDuration: number;
}

export interface TraceFilters {
  service?: string;
  from?: string;
  to?: string;
  limit?: number;
  minDurationMs?: number;
  status?: string;
  name?: string;
}

export interface LogFilters {
  service?: string;
  from?: string;
  to?: string;
  limit?: number;
  minSeverity?: number;
  contains?: string;
  traceId?: string;
  /** Instrumentation scope, exactly — a Rust service's module path. */
  scope?: string;
}

export interface VolumePoint {
  readonly bucket: string;
  readonly ServiceName: string;
  readonly spans: number;
  readonly logs: number;
  readonly errors: number;
}

/** Long-form series data: one entry per bucket per series. The chart's only
 * input shape — every view maps its own rows into this. */
export interface SeriesPoint {
  readonly bucket: string;
  readonly series: string;
  readonly value: number;
}
