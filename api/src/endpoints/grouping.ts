/**
 * What a chart or a list can be split by.
 *
 * `service` is the column; everything else is a resource attribute, which is
 * why this is an allow-list rather than a free-text dimension: the value is
 * interpolated into a `ResourceAttributes[...]` lookup, and the one place user
 * input must never reach is the SQL text.
 */
export const GROUPINGS = {
  service: { label: 'Service', expression: 'ServiceName' },
  app: {
    label: 'App',
    // Stamped by the receiver from the ingest key, so unlike service it cannot
    // be self-declared.
    expression: "ResourceAttributes['watchers.app']",
  },
  environment: {
    label: 'Environment',
    expression: "ResourceAttributes['deployment.environment']",
  },
  cluster: {
    label: 'Cluster',
    // `k8s.cluster.name` is the semantic convention; the bare `cluster` is what
    // hand-rolled resources tend to use, so both are accepted and the first
    // non-empty one wins.
    expression:
      "coalesce(nullIf(ResourceAttributes['k8s.cluster.name'], ''), nullIf(ResourceAttributes['cluster'], ''), '')",
  },
  host: { label: 'Host', expression: "ResourceAttributes['host.name']" },
} as const;

export type Grouping = keyof typeof GROUPINGS;

export function groupingExpression(grouping: string | undefined): string {
  const key = (grouping ?? 'service') as Grouping;

  if (!Object.hasOwn(GROUPINGS, key)) {
    throw new Error(
      `[400] group must be one of: ${Object.keys(GROUPINGS).join(', ')}`,
    );
  }

  return GROUPINGS[key].expression;
}
