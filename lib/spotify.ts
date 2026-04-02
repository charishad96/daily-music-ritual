import { chunk } from "@/lib/utils";
import { getValidSpotifyAccessToken, SPOTIFY_API_URL } from "@/lib/spotify-auth";
import type { AudioFeatures, SpotifyArtist, SpotifyTrack } from "@/types";

type SpotifyFetchOptions = {
  method?: "GET" | "POST";
  body?: string;
};

export class SpotifyApiError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(`Spotify API error (${status}): ${detail}`);
    this.status = status;
    this.detail = detail;
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
    throw new SpotifyApiError(response.status, detail);
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
  const response = await spotifyFetch<{
    items: {
      id: string;
      name: string;
      description: string;
      images: { url: string; height: number | null; width: number | null }[];
      tracks: { total: number };
    }[];
  }>("/me/playlists?limit=20");

  return response.items;
}

export async function getTopTracks(timeRange: "short_term" | "medium_term", limit = 25) {
  const response = await spotifyFetch<{ items: SpotifyTrack[] }>(
    `/me/top/tracks?time_range=${timeRange}&limit=${limit}`
  );

  return response.items;
}

export async function getTopArtists(timeRange: "short_term" | "medium_term", limit = 20) {
  const response = await spotifyFetch<{ items: SpotifyArtist[] }>(
    `/me/top/artists?time_range=${timeRange}&limit=${limit}`
  );

  return response.items;
}

export async function getRecentlyPlayed(limit = 30) {
  const response = await spotifyFetch<{ items: { track: SpotifyTrack }[] }>(
    `/me/player/recently-played?limit=${limit}`
  );

  return response.items.map((item) => item.track);
}

export async function getPlaylistTracks(playlistId: string, limit = 50) {
  const response = await spotifyFetch<{ items: { track: SpotifyTrack | null }[] }>(
    `/playlists/${playlistId}/tracks?limit=${limit}`
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
  const params = new URLSearchParams({
    q: query,
    type: "track",
    limit: String(limit)
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
      filteredParams.set(key, String(value));
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
  return spotifyFetch<{ snapshot_id: string }>(`/playlists/${playlistId}/tracks`, {
    method: "POST",
    body: JSON.stringify({ uris })
  });
}
