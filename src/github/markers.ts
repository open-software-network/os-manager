export type MarkerKind = "triage" | "plan" | "review" | "meta-review" | "claim" | "budget" | "merge";

export interface Marker<TPayload = unknown> {
  kind: MarkerKind | string;
  payload: TPayload;
  raw: string;
}

const markerPattern = /<!--\s*osm:([a-z-]+)(?:\s+([\s\S]*?))?\s*-->/g;

export function makeMarker(kind: MarkerKind | string, payload: unknown = {}, visibleMarkdown = ""): string {
  const json = JSON.stringify(payload);
  const marker = `<!-- osm:${kind} ${json} -->`;
  return visibleMarkdown ? `${marker}\n\n${visibleMarkdown}` : marker;
}

export function parseMarkers(body: string | null | undefined, kind?: MarkerKind | string): Marker[] {
  if (!body) {
    return [];
  }
  const markers: Marker[] = [];
  for (const match of body.matchAll(markerPattern)) {
    const markerKind = match[1] ?? "";
    if (kind && markerKind !== kind) {
      continue;
    }
    const rawPayload = (match[2] ?? "{}").trim();
    let payload: unknown = rawPayload;
    if (rawPayload.startsWith("{") || rawPayload.startsWith("[")) {
      try {
        payload = JSON.parse(rawPayload);
      } catch {
        payload = rawPayload;
      }
    }
    markers.push({ kind: markerKind, payload, raw: match[0] ?? "" });
  }
  return markers;
}

export function hasMarker(body: string | null | undefined, kind: MarkerKind | string): boolean {
  return parseMarkers(body, kind).length > 0;
}

export function latestMarker<TPayload = unknown>(body: string | null | undefined, kind: MarkerKind | string): Marker<TPayload> | undefined {
  const markers = parseMarkers(body, kind);
  return markers.at(-1) as Marker<TPayload> | undefined;
}
