// T12.3 — Renderer-side reactive cache for project ↔ service links.
//
// Each PlanFlow / GitHub / Vercel / Neon / Railway view needs the
// `externalId` stored in `project_links` (T11.5) for its workspace
// project. Calling `listProjectLinks` from every view on every render
// would round-trip through Tauri uselessly, so the renderer keeps a
// reactive cache keyed by Work Station projectId and exposes a single
// accessor pair: load + invalidate.
//
// The cache is sparse on purpose — entries materialise the first time
// a view asks for them. T12.2 (Settings UI for linking) will call
// `invalidateProjectLinks(projectId)` after mutations so dependent
// views re-fetch.

import { createMemo, createResource, type Resource } from "solid-js";

import {
  Integration,
  type IntegrationId,
  listProjectLinks,
  type ProjectLink,
} from "../db/projectLinks";

interface CacheEntry {
  links: ProjectLink[];
  loadedAt: number;
}

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<ProjectLink[]>>();
const subscribers = new Map<string, Set<(links: ProjectLink[]) => void>>();

async function load(projectId: string, force: boolean): Promise<ProjectLink[]> {
  if (!force) {
    const cached = cache.get(projectId);
    if (cached) return cached.links;
    const inflight = pending.get(projectId);
    if (inflight) return inflight;
  }
  const promise = (async (): Promise<ProjectLink[]> => {
    try {
      const links = await listProjectLinks(projectId);
      cache.set(projectId, { links, loadedAt: Date.now() });
      const subs = subscribers.get(projectId);
      if (subs) {
        for (const subscriber of subs) subscriber(links);
      }
      return links;
    } finally {
      pending.delete(projectId);
    }
  })();
  pending.set(projectId, promise);
  return promise;
}

/** Drop the cached links for `projectId` and rerun anyone subscribed.
 *  Call from mutation paths (link / unlink). */
export async function invalidateProjectLinks(projectId: string): Promise<void> {
  cache.delete(projectId);
  await load(projectId, true);
}

/** Drop every cached entry — used by the project store when a project is
 *  removed so a recreated project with the same id doesn't see ghosts. */
export function clearProjectLinkCache(projectId?: string): void {
  if (projectId == null) {
    cache.clear();
    return;
  }
  cache.delete(projectId);
}

/** Return a Solid resource that resolves a workspace project's link for
 *  a given service. `null` means the project has no link for that service
 *  yet; the calling view should render the "open Settings to link"
 *  empty state. The accessor is reactive on `projectId` so switching
 *  projects refetches automatically. */
export function useProjectServiceLink(
  projectId: () => string | null,
  service: IntegrationId,
): Resource<ProjectLink | null> {
  const [resource] = createResource(
    () => projectId(),
    async (id): Promise<ProjectLink | null> => {
      const links = await load(id, false);
      return links.find((link) => link.service === service) ?? null;
    },
  );
  return resource;
}

/** Synchronous-ish accessor for components that already pull all links
 *  for unrelated reasons. Returns the cached snapshot or `null` when
 *  nothing has loaded yet — callers should still `await` an explicit
 *  load if they need certainty. */
export function readCachedLinks(projectId: string): readonly ProjectLink[] | null {
  return cache.get(projectId)?.links ?? null;
}

/** Memoised "is this project linked to a PlanFlow project?" — convenience
 *  for the tab strip's lock indicator and similar quick checks. */
export function usePlanFlowLink(projectId: () => string | null): Resource<ProjectLink | null> {
  const resource = useProjectServiceLink(projectId, Integration.PlanFlow);
  return resource;
}

/** Memoised external id accessor for the PlanFlow project linked to the
 *  given Work Station project, or `null` when there is no link. Wrap in
 *  `createMemo` at the call site if you need it to react to other
 *  signals. */
export function usePlanFlowExternalId(projectId: () => string | null): () => string | null {
  const link = usePlanFlowLink(projectId);
  const externalId = createMemo(() => link()?.externalId ?? null);
  return externalId;
}
