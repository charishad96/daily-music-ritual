import {
  getArtistTopTracks,
  getAudioFeatures,
  getPlaylistTracks,
  getRecommendations,
  getRecentlyPlayed,
  getRelatedArtists,
  getTopArtists,
  getTopTracks,
  searchTracks
} from "@/lib/spotify";
import { average, clamp, normalize, releaseYear, seededValue, uniqueBy } from "@/lib/utils";
import type {
  AudioFeatures,
  ContextInput,
  RankedTrack,
  RecommendationReason,
  SpotifyArtist,
  SpotifyTrack,
  TasteProfile
} from "@/types";

type ProfileSource = {
  topTracks: SpotifyTrack[];
  topArtists: SpotifyArtist[];
  recentTracks: SpotifyTrack[];
  playlistTracks: SpotifyTrack[];
};

const DEFAULT_AUDIO_FEATURES: AudioFeatures = {
  danceability: 0.56,
  energy: 0.56,
  valence: 0.54,
  tempo: 112,
  acousticness: 0.24,
  instrumentalness: 0.06
};

function uniqueTracks(tracks: SpotifyTrack[]) {
  return uniqueBy(
    tracks.filter((track) => track?.id),
    (track) => track.id
  );
}

function pickTopGenres(artists: SpotifyArtist[]) {
  const genreCounts = new Map<string, number>();

  artists.forEach((artist, artistIndex) => {
    artist.genres?.forEach((genre) => {
      genreCounts.set(genre, (genreCounts.get(genre) || 0) + (artists.length - artistIndex));
    });
  });

  return [...genreCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([genre]) => genre);
}

function mapMoodToFeatures(mood: ContextInput["mood"]): Partial<AudioFeatures> {
  switch (mood) {
    case "calm":
      return { energy: 0.28, valence: 0.52, acousticness: 0.6, tempo: 92 };
    case "focused":
      return { energy: 0.46, valence: 0.42, instrumentalness: 0.32, tempo: 104 };
    case "energetic":
      return { energy: 0.84, valence: 0.68, danceability: 0.68, tempo: 126 };
    case "melancholic":
      return { energy: 0.38, valence: 0.24, acousticness: 0.42, tempo: 98 };
    case "social":
      return { energy: 0.72, valence: 0.7, danceability: 0.76, tempo: 120 };
  }
}

function mapTimeToFeatures(timeOfDay: ContextInput["timeOfDay"]): Partial<AudioFeatures> {
  switch (timeOfDay) {
    case "morning":
      return { energy: 0.45, valence: 0.58, tempo: 102 };
    case "afternoon":
      return { energy: 0.6, valence: 0.56, tempo: 112 };
    case "evening":
      return { energy: 0.5, valence: 0.48, tempo: 108 };
    case "night":
      return { energy: 0.36, valence: 0.34, tempo: 94 };
  }
}

function mapEnergyLevel(level: ContextInput["energyLevel"]): Partial<AudioFeatures> {
  switch (level) {
    case "low":
      return { energy: 0.28, danceability: 0.42, tempo: 92 };
    case "medium":
      return { energy: 0.56, danceability: 0.56, tempo: 108 };
    case "high":
      return { energy: 0.82, danceability: 0.68, tempo: 126 };
  }
}

function buildTargetFeatures(profile: TasteProfile, context: ContextInput): AudioFeatures {
  const mood = mapMoodToFeatures(context.mood);
  const time = mapTimeToFeatures(context.timeOfDay);
  const energy = mapEnergyLevel(context.energyLevel);

  return {
    danceability: average(
      [profile.averageFeatures.danceability, mood.danceability, energy.danceability].filter(
        (value): value is number => typeof value === "number"
      ),
      DEFAULT_AUDIO_FEATURES.danceability
    ),
    energy: average(
      [profile.averageFeatures.energy, mood.energy, time.energy, energy.energy].filter(
        (value): value is number => typeof value === "number"
      ),
      DEFAULT_AUDIO_FEATURES.energy
    ),
    valence: average(
      [profile.averageFeatures.valence, mood.valence, time.valence].filter(
        (value): value is number => typeof value === "number"
      ),
      DEFAULT_AUDIO_FEATURES.valence
    ),
    tempo: average(
      [profile.averageFeatures.tempo, mood.tempo, time.tempo, energy.tempo].filter(
        (value): value is number => typeof value === "number"
      ),
      DEFAULT_AUDIO_FEATURES.tempo
    ),
    acousticness: average(
      [profile.averageFeatures.acousticness, mood.acousticness].filter(
        (value): value is number => typeof value === "number"
      ),
      DEFAULT_AUDIO_FEATURES.acousticness
    ),
    instrumentalness: average(
      [profile.averageFeatures.instrumentalness, mood.instrumentalness].filter(
        (value): value is number => typeof value === "number"
      ),
      DEFAULT_AUDIO_FEATURES.instrumentalness
    )
  };
}

export async function collectProfileSource(playlistIds: string[]): Promise<ProfileSource> {
  const [topTracksShort, topTracksMedium, topArtistsShort, topArtistsMedium, recentTracks] =
    await Promise.all([
      getTopTracks("short_term", 25),
      getTopTracks("medium_term", 25),
      getTopArtists("short_term", 20),
      getTopArtists("medium_term", 20),
      getRecentlyPlayed(30)
    ]);

  const playlistTrackGroups = await Promise.all(playlistIds.map((playlistId) => getPlaylistTracks(playlistId)));
  const playlistTracks = playlistTrackGroups.flat();

  return {
    topTracks: uniqueTracks([...topTracksShort, ...topTracksMedium]),
    topArtists: uniqueBy([...topArtistsShort, ...topArtistsMedium], (artist) => artist.id),
    recentTracks: uniqueTracks(recentTracks),
    playlistTracks: uniqueTracks(playlistTracks)
  };
}

export async function buildTasteProfile(source: ProfileSource): Promise<TasteProfile> {
  const seedTracks = uniqueTracks([...source.topTracks, ...source.recentTracks, ...source.playlistTracks]).slice(
    0,
    80
  );
  const audioFeaturesByTrackId = await getAudioFeatures(seedTracks.map((track) => track.id));
  const dominantGenres = pickTopGenres(source.topArtists);

  const averageFeatures: AudioFeatures = {
    danceability: average(seedTracks.map((track) => audioFeaturesByTrackId[track.id]?.danceability ?? 0.56), 0.56),
    energy: average(seedTracks.map((track) => audioFeaturesByTrackId[track.id]?.energy ?? 0.56), 0.56),
    valence: average(seedTracks.map((track) => audioFeaturesByTrackId[track.id]?.valence ?? 0.54), 0.54),
    tempo: average(seedTracks.map((track) => audioFeaturesByTrackId[track.id]?.tempo ?? 112), 112),
    acousticness: average(
      seedTracks.map((track) => audioFeaturesByTrackId[track.id]?.acousticness ?? 0.24),
      0.24
    ),
    instrumentalness: average(
      seedTracks.map((track) => audioFeaturesByTrackId[track.id]?.instrumentalness ?? 0.06),
      0.06
    )
  };

  const excludedTrackIds = new Set<string>(
    [...source.topTracks, ...source.recentTracks, ...source.playlistTracks].map((track) => track.id)
  );
  const seenArtistIds = new Set<string>(
    [
      ...source.topArtists.map((artist) => artist.id),
      ...seedTracks.flatMap((track) => track.artists.map((artist) => artist.id))
    ]
  );

  return {
    averageFeatures,
    dominantGenres,
    seedArtists: source.topArtists.slice(0, 10),
    seedTracks: seedTracks.slice(0, 10),
    excludedTrackIds,
    seenArtistIds
  };
}

async function expandCandidates(
  profile: TasteProfile,
  context: ContextInput,
  target: AudioFeatures
): Promise<{ candidates: SpotifyTrack[]; audioFeaturesByTrackId: Record<string, AudioFeatures> }> {
  const relatedArtistGroups = await Promise.all(profile.seedArtists.slice(0, 6).map((artist) => getRelatedArtists(artist.id)));
  const relatedArtists = uniqueBy(relatedArtistGroups.flat(), (artist) => artist.id)
    .filter((artist) => !profile.seenArtistIds.has(artist.id))
    .slice(0, 15);

  const recommendationTracks = await getRecommendations({
    limit: 60,
    seed_artists: profile.seedArtists
      .slice(0, 3)
      .map((artist) => artist.id)
      .join(","),
    seed_tracks: profile.seedTracks
      .slice(0, 2)
      .map((track) => track.id)
      .join(","),
    seed_genres: profile.dominantGenres.slice(0, 2).join(","),
    target_energy: clamp(target.energy, 0, 1).toFixed(2),
    target_valence: clamp(target.valence, 0, 1).toFixed(2),
    target_danceability: clamp(target.danceability, 0, 1).toFixed(2),
    target_tempo: Math.round(target.tempo)
  });

  const relatedArtistTrackGroups = await Promise.all(
    relatedArtists.slice(0, 10).map((artist) => getArtistTopTracks(artist.id))
  );

  const decadeQuery =
    context.decadePreference === "any"
      ? ""
      : context.decadePreference === "90s"
        ? " year:1990-1999"
        : context.decadePreference === "2000s"
          ? " year:2000-2009"
          : context.decadePreference === "2010s"
            ? " year:2010-2019"
            : " year:2022-2026";

  const genreSearchGroups = await Promise.all(
    profile.dominantGenres.slice(0, 3).map((genre) => searchTracks(`genre:"${genre}"${decadeQuery}`, 18))
  );

  const candidates = uniqueTracks([
    ...recommendationTracks,
    ...relatedArtistTrackGroups.flat(),
    ...genreSearchGroups.flat()
  ]);
  const filteredCandidates = candidates.filter(
    (track) =>
      !profile.excludedTrackIds.has(track.id) &&
      !(context.excludeTrackIds || []).includes(track.id) &&
      track.artists.every((artist) => !profile.seenArtistIds.has(artist.id) || context.familiarity > 55)
  );
  const audioFeaturesByTrackId = await getAudioFeatures(filteredCandidates.map((track) => track.id));

  return {
    candidates: filteredCandidates,
    audioFeaturesByTrackId
  };
}

function tasteDistance(target: AudioFeatures, actual: AudioFeatures) {
  return Math.sqrt(
    Math.pow(target.danceability - actual.danceability, 2) +
      Math.pow(target.energy - actual.energy, 2) +
      Math.pow(target.valence - actual.valence, 2) +
      Math.pow((target.tempo - actual.tempo) / 100, 2) +
      Math.pow(target.acousticness - actual.acousticness, 2) +
      Math.pow(target.instrumentalness - actual.instrumentalness, 2)
  );
}

function decadeBonus(context: ContextInput, releaseDate?: string) {
  const year = releaseYear(releaseDate);
  if (!year || context.decadePreference === "any") {
    return 0.05;
  }

  const matches =
    (context.decadePreference === "90s" && year >= 1990 && year <= 1999) ||
    (context.decadePreference === "2000s" && year >= 2000 && year <= 2009) ||
    (context.decadePreference === "2010s" && year >= 2010 && year <= 2019) ||
    (context.decadePreference === "new" && year >= 2022);

  return matches ? 0.14 : -0.08;
}

function explainRecommendation(
  features: AudioFeatures,
  context: ContextInput,
  profile: TasteProfile,
  novelty: number
): RecommendationReason {
  if (novelty > 0.72) {
    return {
      headline: "Fresh but still aligned",
      detail: `Less obvious pick with a lower-popularity profile that still matches your ${context.mood} ${context.timeOfDay} lane.`
    };
  }

  if (features.energy > 0.72 && context.energyLevel === "high") {
    return {
      headline: "Built for momentum",
      detail: "High energy and forward motion make this a strong fit for a more active session."
    };
  }

  if (features.acousticness > 0.45 && context.mood === "calm") {
    return {
      headline: "A softer deep cut",
      detail: "The calmer acoustic lean keeps it close to your taste while avoiding the obvious tracks."
    };
  }

  return {
    headline: profile.dominantGenres[0] ? `Extends your ${profile.dominantGenres[0]} orbit` : "Taste-adjacent discovery",
    detail: "Its feature profile lands near your saved preferences, but the artist overlap stays intentionally light."
  };
}

export async function generateDailyRecommendations(context: ContextInput) {
  const source = await collectProfileSource(context.playlistIds);
  const profile = await buildTasteProfile(source);
  const target = buildTargetFeatures(profile, context);
  const { candidates, audioFeaturesByTrackId } = await expandCandidates(profile, context, target);
  const safety = normalize(context.familiarity, 0, 100);
  const exploration = 1 - safety;
  const dailySalt = `${new Date().toISOString().slice(0, 10)}:${context.refreshKey || "0"}`;

  const ranked: RankedTrack[] = candidates
    .map((track) => {
      const features = audioFeaturesByTrackId[track.id] || DEFAULT_AUDIO_FEATURES;
      const distance = tasteDistance(target, features);
      const closeness = clamp(1 - distance / 1.6, 0, 1);
      const novelty =
        clamp(1 - normalize(track.popularity, 20, 90), 0, 1) * 0.68 +
        clamp(1 - normalize(track.artists[0]?.popularity || 50, 25, 90), 0, 1) * 0.22 +
        decadeBonus(context, track.album.release_date);
      const contextFit =
        clamp(1 - Math.abs(target.energy - features.energy), 0, 1) * 0.35 +
        clamp(1 - Math.abs(target.valence - features.valence), 0, 1) * 0.2 +
        clamp(1 - Math.abs(target.danceability - features.danceability), 0, 1) * 0.15 +
        clamp(1 - Math.abs(target.tempo - features.tempo) / 70, 0, 1) * 0.15 +
        clamp(1 - Math.abs(target.acousticness - features.acousticness), 0, 1) * 0.15;

      const safeWeight = 0.34 + safety * 0.24;
      const noveltyWeight = 0.2 + exploration * 0.28;
      const contextWeight = 0.24;
      const randomness = seededValue(`${dailySalt}:${track.id}`) * 0.04;
      const score = closeness * safeWeight + novelty * noveltyWeight + contextFit * contextWeight + randomness;
      const reason = explainRecommendation(features, context, profile, novelty);

      return {
        ...track,
        score,
        similarity: closeness,
        novelty,
        contextFit,
        reason
      };
    })
    .filter((track) => track.popularity <= 82)
    .sort((a, b) => b.score - a.score);

  const artistCap = new Map<string, number>();
  const finalTracks: RankedTrack[] = [];

  for (const track of ranked) {
    const leadArtistId = track.artists[0]?.id;
    const currentCount = leadArtistId ? artistCap.get(leadArtistId) || 0 : 0;

    if (leadArtistId && currentCount >= 1) {
      continue;
    }

    if (leadArtistId) {
      artistCap.set(leadArtistId, currentCount + 1);
    }
    finalTracks.push(track);

    if (finalTracks.length === 24) {
      break;
    }
  }

  return {
    profileSummary: {
      dominantGenres: profile.dominantGenres,
      averageFeatures: profile.averageFeatures
    },
    tracks: finalTracks
  };
}
