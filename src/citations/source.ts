/**
 * Reading what a citation points at: a file under the discovery root, an
 * absolute path, or an https URL. Network access goes through an injected
 * `fetch` so the suite never leaves the machine, and it can be switched off
 * per eval for an air-gapped job.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { SourceSpec } from "./hash.js";

/** The slice of `fetch` this module uses, so a test can hand in a fake. */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export type SourceRead =
  | { ok: true; text: string }
  | { ok: false; status: "missing" | "unreachable" | "network-off"; detail: string };

export interface SourceReaders {
  /** Discovery root; relative paths resolve against it. */
  root: string;
  fetch?: FetchLike;
  /** Whether URL sources may be fetched at all. */
  network: boolean;
}

const FETCH_TIMEOUT_MS = 30_000;

/** Absolute path of a file source. */
export function sourcePath(spec: SourceSpec & { kind: "file" }, root: string): string {
  return isAbsolute(spec.path) ? spec.path : resolve(root, spec.path);
}

export async function readSource(spec: SourceSpec, readers: SourceReaders): Promise<SourceRead> {
  if (spec.kind === "file") {
    const abs = sourcePath(spec, readers.root);
    try {
      return { ok: true, text: readFileSync(abs, "utf8") };
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
        return { ok: false, status: "missing", detail: `${spec.path} not found` };
      }
      return {
        ok: false,
        status: "unreachable",
        detail: `${spec.path}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
  return fetchSource(spec.fetchUrl, readers);
}

/**
 * The same source at a commit: a GitHub blob URL re-pointed at the commit.
 * Local files go through git instead (see `git.ts`); other URLs have no
 * history to read.
 */
export async function readUrlAtCommit(
  spec: SourceSpec & { kind: "url" },
  commit: string,
  readers: SourceReaders,
): Promise<SourceRead | undefined> {
  if (!spec.github) return undefined;
  const { owner, repo, path } = spec.github;
  return fetchSource(`https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${path}`, readers);
}

async function fetchSource(url: string, readers: SourceReaders): Promise<SourceRead> {
  if (!readers.network) {
    return { ok: false, status: "network-off", detail: `${url} not fetched: options.network is false` };
  }
  const fetch = readers.fetch;
  if (fetch === undefined) {
    return { ok: false, status: "unreachable", detail: `${url}: no fetch implementation available` };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (response.status === 404) {
      return { ok: false, status: "missing", detail: `${url} returned 404` };
    }
    if (!response.ok) {
      return { ok: false, status: "unreachable", detail: `${url} returned ${response.status}` };
    }
    return { ok: true, text: await response.text() };
  } catch (e) {
    return {
      ok: false,
      status: "unreachable",
      detail: `${url}: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
