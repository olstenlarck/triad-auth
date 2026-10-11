import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function timeAgo(seconds: number | null | undefined): string {
  if (!seconds) {
    return "";
  }
  const delta = Math.floor(Date.now() / 1000) - seconds;
  if (delta < 60) {
    return "just now";
  }
  if (delta < 3600) {
    return `${Math.floor(delta / 60)}m ago`;
  }
  if (delta < 86_400) {
    return `${Math.floor(delta / 3600)}h ago`;
  }
  if (delta < 86_400 * 30) {
    return `${Math.floor(delta / 86_400)}d ago`;
  }

  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export function formatBytes(size: number | undefined): string {
  if (size === undefined) {
    return "";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

// Browser-side mutation helper against the same REST API the loaders use.
export async function mutate<T>(
  path: string,
  init: { method: string; body?: unknown },
): Promise<T> {
  const response = await fetch(path, {
    method: init.method,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
  });
  const text = await response.text();
  // SAFETY: the REST API answers with the JSON shape the caller names or a problem body carrying
  // `message`; an empty body stands in for an empty object.
  const parsed = (text ? JSON.parse(text) : {}) as T & { message?: string };
  if (!response.ok) {
    throw new Error(parsed.message ?? `request failed with ${response.status}`);
  }

  return parsed;
}
