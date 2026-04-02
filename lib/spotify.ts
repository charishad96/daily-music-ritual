import { chunk } from "@/lib/utils";
import { getValidSpotifyAccessToken, SPOTIFY_API_URL } from "@/lib/spotify-auth";
import type { AudioFeatures, SpotifyArtist, SpotifyTrack } from "@/types";

type SpotifyFetchOptions = {
  method?: "GET" | "POST";
  body?: string;
};

function clampLimit(limit: number, min: number, max: number) {
  return Math.min(Math.max(limit, min), max);
}

export function resolveSpotifyPlaylistId(input: string) {
  const value = input.trim();

  if (!value) {
    return null;
  }

  const uriMatch = value.match(/^spotify:playlist:([A-Za-z0-9]+)$/i);
  if (uriMatch) {
    return uriMatch[1];
  }

  const urlMatch = value.match(/spotify\.com\/playlist\/([A-Za-z0-9]+)/i);
  if (urlMatch) {
    return urlMatch[1];
  }

  if (/^[A-Za-z0-9]{10,}$/.test(value)) {
    return value;
  }

  return null;
}

export class SpotifyApiError extends Error {
  status: number;
  detail: string;
  path: string;

  constructor(status: number, detail: string, path: string) {
    super(`Spotify API error (${status}) on ${path}: ${detail}`);
    this.status = status;
    this.detail = detail;
    this.path = path;
  }
}

async function spotifyFetch<T>(path: string, options: SpotifyFetchOptions = {}): Promise<T> {
  const accessToken = await getValidSpotifyAccessToken();

  if (!accessToken) {
    throw new Error("Spotify session missing.");
  }

  const response = await fetch(`${SPOTIFY_API_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: options.body
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new SpotifyApiError(response.status, detail, path);
  }

  return response.json();
}

export async function getCurrentUserProfile() {
  return spotifyFetch<{
    id: string;
    display_name: string;
    email?: string;
    country?: string;
    images?: { url: string; height: number | null; width: number | null }[];
  }>("/me");
}

export async function getCurrentUserPlaylists() {
  const safeLimit = clampLimit(20, 1, 50);
  const response = await spotifyFetch<{
    items: {
      id: string;
      name: string;
      description: string;
      images: { url: string; height: number | null; width: number | null }[];
      tracks: { total: number };
    }[];
  }>(`/me/playlists?limit=${safeLimit}`);

  return response.items;
}

export async function getTopTracks(timeRange: "short_term" | "medium_term", limit = 25) {
  const safeLimit = clampLimit(limit, 1, 50);
  const response = await spotifyFetch<{ items: SpotifyTrack[] }>(
    `/me/top/tracks?time_range=${timeRange}&limit=${safeLimit}`
  );

  return response.items;
}

export async function getTopArtists(timeRange: "short_term" | "medium_term", limit = 20) {
  const safeLimit = clampLimit(limit, 1, 50);
  const response = await spotifyFetch<{ items: SpotifyArtist[] }>(
    `/me/top/artists?time_range=${timeRange}&limit=${safeLimit}`
  );

  return response.items;
}

export async function getRecentlyPlayed(limit = 30) {
  const safeLimit = clampLimit(limit, 1, 50);
  const response = await spotifyFetch<{ items: { track: SpotifyTrack }[] }>(
    `/me/player/recently-played?limit=${safeLimit}`
  );

  return response.items.map((item) => item.track);
}

export async function getPlaylistTracks(playlistId: string, limit = 50) {
  const safeLimit = clampLimit(limit, 1, 100);
  const response = await spotifyFetch<{ items: { track: SpotifyTrack | null }[] }>(
    `/playlists/${playlistId}/tracks?limit=${safeLimit}`
  );

  return response.items.map((item) => item.track).filter(Boolean) as SpotifyTrack[];
}

export async function getRelatedArtists(artistId: string) {
  const response = await spotifyFetch<{ artists: SpotifyArtist[] }>(
    `/artists/${artistId}/related-artists`
  );

  return response.artists;
}

export async function getArtistTopTracks(artistId: string, market = "from_token") {
  const response = await spotifyFetch<{ tracks: SpotifyTrack[] }>(
    `/artists/${artistId}/top-tracks?market=${market}`
  );

  return response.tracks;
}

export async function searchTracks(query: string, limit = 15) {
  const safeLimit = clampLimit(limit, 1, 10);
  const params = new URLSearchParams({
    q: query,
    type: "track",
    limit: String(safeLimit)
  });

  const response = await spotifyFetch<{ tracks: { items: SpotifyTrack[] } }>(
    `/search?${params.toString()}`
  );

  return response.tracks.items;
}

export async function getRecommendations(params: Record<string, string | number | undefined>) {
  const filteredParams = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      if (key === "limit" && typeof value === "number") {
        filteredParams.set(key, String(clampLimit(value, 1, 100)));
      } else {
        filteredParams.set(key, String(value));
      }
    }
  });

  try {
    const response = await spotifyFetch<{ tracks: SpotifyTrack[] }>(
      `/recommendations?${filteredParams.toString()}`
    );
    return response.tracks;
  } catch {
    return [];
  }
}

export async function getAudioFeatures(trackIds: string[]) {
  const batches = chunk(trackIds, 100);
  const features: Record<string, AudioFeatures> = {};

  for (const batch of batches) {
    try {
      const response = await spotifyFetch<{
        audio_features: (AudioFeatures & { id: string })[];
      }>(`/audio-features?ids=${batch.join(",")}`);

      response.audio_features.forEach((feature) => {
        if (feature?.id) {
          features[feature.id] = {
            danceability: feature.danceability,
            energy: feature.energy,
            valence: feature.valence,
            tempo: feature.tempo,
            acousticness: feature.acousticness,
            instrumentalness: feature.instrumentalness
          };
        }
      });
    } catch {
      batch.forEach((trackId) => {
        features[trackId] = {
          danceability: 0.5,
          energy: 0.5,
          valence: 0.5,
          tempo: 110,
          acousticness: 0.25,
          instrumentalness: 0.05
        };
      });
    }
  }

  return features;
}

export async function createPlaylist(name: string, description: string) {
  return spotifyFetch<{ id: string; external_urls: { spotify: string } }>("/me/playlists", {
    method: "POST",
    body: JSON.stringify({
      name,
      public: false,
      description
    })
  });
}

export async function addItemsToPlaylist(playlistId: string, uris: string[]) {
  return spotifyFetch<{ snapshot_id: string }>(`/playlists/${playlistId}/items`, {
    method: "POST",
    body: JSON.stringify({ uris })
  });
}
