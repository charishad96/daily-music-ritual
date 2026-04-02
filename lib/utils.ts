import type { SpotifyTrack } from "@/types";

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

export function average(values: number[], fallback = 0): number {
  if (!values.length) {
    return fallback;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function uniqueBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();

  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function normalize(value: number, min: number, max: number): number {
  if (max === min) {
    return 0;
  }

  return clamp((value - min) / (max - min), 0, 1);
}

export function seededValue(seed: string): number {
  let hash = 2166136261;

  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return Math.abs(hash % 10000) / 10000;
}

export function formatDateLabel(date = new Date()): string {
  return new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "short",
    day: "numeric"
  }).format(date);
}

export function releaseYear(dateString?: string): number | null {
  if (!dateString) {
    return null;
  }

  const year = Number(dateString.slice(0, 4));
  return Number.isNaN(year) ? null : year;
}

export function normalizeComparableText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\bfeat(?:uring)?\b.*$/g, "")
    .replace(/\((?:[^)]*(?:live|remaster|mono|stereo|acoustic|edit|version|deluxe|demo|radio)[^)]*)\)/g, "")
    .replace(/\[(?:[^\]]*(?:live|remaster|mono|stereo|acoustic|edit|version|deluxe|demo|radio)[^\]]*)\]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalTrackKey(track: SpotifyTrack) {
  const leadArtist = normalizeComparableText(track.artists[0]?.name || "");
  const title = normalizeComparableText(track.name);
  return `${leadArtist}::${title}`;
}
