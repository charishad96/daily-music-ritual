export type Mood = "calm" | "focused" | "energetic" | "melancholic" | "social";
export type TimeOfDay = "morning" | "afternoon" | "evening" | "night";
export type EnergyLevel = "low" | "medium" | "high";
export type DecadePreference = "any" | "90s" | "2000s" | "2010s" | "new";
export type LanguagePreference = "any" | "english" | "greek" | "spanish" | "portuguese";

export type ContextInput = {
  mood: Mood;
  timeOfDay: TimeOfDay;
  energyLevel: EnergyLevel;
  decadePreference: DecadePreference;
  languagePreference: LanguagePreference;
  familiarity: number;
  playlistIds: string[];
  friendPlaylistInputs: string[];
  excludeTrackIds?: string[];
  refreshKey?: string;
};

export type SpotifyImage = {
  url: string;
  height: number | null;
  width: number | null;
};

export type SpotifyArtist = {
  id: string;
  name: string;
  genres?: string[];
  popularity?: number;
};

export type SpotifyTrack = {
  id: string;
  name: string;
  uri: string;
  popularity: number;
  preview_url: string | null;
  duration_ms: number;
  external_urls: {
    spotify: string;
  };
  album: {
    id?: string;
    name: string;
    images: SpotifyImage[];
    release_date?: string;
  };
  artists: SpotifyArtist[];
};

export type AudioFeatures = {
  danceability: number;
  energy: number;
  valence: number;
  tempo: number;
  acousticness: number;
  instrumentalness: number;
};

export type TasteProfile = {
  averageFeatures: AudioFeatures;
  dominantGenres: string[];
  seedArtists: SpotifyArtist[];
  seedTracks: SpotifyTrack[];
  excludedTrackIds: Set<string>;
  excludedTrackKeys: Set<string>;
  seenArtistIds: Set<string>;
};

export type RecommendationReason = {
  headline: string;
  detail: string;
};

export type RankedTrack = SpotifyTrack & {
  score: number;
  reason: RecommendationReason;
  contextFit: number;
  novelty: number;
  similarity: number;
};

export type BootstrapResponse = {
  authenticated: boolean;
  profile?: {
    id: string;
    display_name: string;
    email?: string;
    country?: string;
    images?: SpotifyImage[];
  };
  playlists?: {
    id: string;
    name: string;
    description: string;
    images: SpotifyImage[];
    tracksTotal: number;
  }[];
};
