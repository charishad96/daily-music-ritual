import {
  SpotifyApiError,
  getArtistTopTracks,
  getAudioFeatures,
  getPlaylistTracks,
  getRecommendations,
  getRecentlyPlayed,
  getRelatedArtists,
  getTopArtists,
  getTopTracks,
  resolveSpotifyPlaylistId,
  searchTracks
} from "@/lib/spotify";
import { average, canonicalTitleKey, canonicalTrackKey, clamp, normalize, releaseYear, seededValue, uniqueBy } from "@/lib/utils";
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
  friendSignalTracks: SpotifyTrack[];
};

const DEFAULT_AUDIO_FEATURES: AudioFeatures = {
  danceability: 0.56,
  energy: 0.56,
  valence: 0.54,
  tempo: 112,
  acousticness: 0.24,
  instrumentalness: 0.06
};

async function swallowSpotify403<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SpotifyApiError && [400, 403, 404].includes(error.status)) {
      return fallback;
    }

    throw error;
  }
}

const LANGUAGE_QUERY_HINTS: Record<ContextInput["languagePreference"], string[]> = {
  any: [],
  english: ["english indie", "english alternative", "uk indie"],
  greek: ["greek indie", "ellinika", "greek alternative"],
  spanish: ["spanish indie", "espanol alternative", "latin indie"],
  portuguese: ["mpb", "brazilian indie", "portuguese alternative"]
};

const LANGUAGE_LABELS: Record<ContextInput["languagePreference"], string> = {
  any: "language-open",
  english: "English-leaning",
  greek: "Greek-leaning",
  spanish: "Spanish-leaning",
  portuguese: "Portuguese-leaning"
};

function extractPlaylistIds(inputs: string[]) {
  return [
    ...new Set(
      inputs.map((input) => resolveSpotifyPlaylistId(input)).filter((playlistId): playlistId is string => Boolean(playlistId))
    )
  ];
}

function textContainsGreek(text: string) {
  return /[\u0370-\u03ff]/.test(text);
}

function languageFit(track: SpotifyTrack, languagePreference: ContextInput["languagePreference"]) {
  if (languagePreference === "any") {
    return 0.5;
  }

  const haystack = `${track.name} ${track.artists.map((artist) => artist.name).join(" ")} ${track.album.name}`.toLowerCase();

  switch (languagePreference) {
    case "english":
      return textContainsGreek(haystack) ? 0.1 : 0.75;
    case "greek":
      return textContainsGreek(haystack) || haystack.includes("greek") || haystack.includes("ellin") ? 1 : 0.08;
    case "spanish":
      return haystack.includes("spanish") || haystack.includes("espan") || haystack.includes("latin") ? 1 : 0.12;
    case "portuguese":
      return haystack.includes("brazil") || haystack.includes("brasil") || haystack.includes("portugu") || haystack.includes("mpb")
        ? 1
        : 0.12;
  }
}

function timeOfDaySearchHints(timeOfDay: ContextInput["timeOfDay"]) {
  switch (timeOfDay) {
    case "morning":
      return ["morning ambient", "dawn folk", "early day indie"];
    case "afternoon":
      return ["afternoon grooves", "warm indie soul", "daylight electronic"];
    case "evening":
      return ["evening soul", "golden hour indie", "nightfall pop"];
    case "night":
      return ["late night electronic", "midnight indie", "after dark soul"];
  }
}

function contextOnlySearchQueries(context: ContextInput) {
  return [
    context.mood === "focused"
      ? "instrumental indie electronic"
      : context.mood === "calm"
        ? "ambient folk dream pop"
        : context.mood === "energetic"
          ? "indie dance alternative"
          : context.mood === "melancholic"
            ? "art pop slowcore"
            : "nu disco indie soul",
    ...timeOfDaySearchHints(context.timeOfDay),
    context.energyLevel === "high"
      ? "upbeat alternative"
      : context.energyLevel === "low"
        ? "soft atmospheric"
        : "midtempo discovery",
    ...LANGUAGE_QUERY_HINTS[context.languagePreference]
  ].filter(Boolean) as string[];
}

async function buildContextOnlyRecommendations(context: ContextInput) {
  const dailySalt = `${new Date().toISOString().slice(0, 10)}:${context.refreshKey || "0"}`;
  const queries = contextOnlySearchQueries(context);
  const searchGroups = await Promise.all(
    queries.map((query) => swallowSpotify403(() => searchTracks(query, 10), []))
  );
  const candidates = uniqueTracks(searchGroups.flat()).filter(
    (track) => !(context.excludeTrackIds || []).includes(track.id)
  );
  const audioFeaturesByTrackId = await getAudioFeatures(candidates.map((track) => track.id));
  const pseudoProfile = {
    averageFeatures: {
      ...DEFAULT_AUDIO_FEATURES,
      ...mapMoodToFeatures(context.mood),
      ...mapTimeToFeatures(context.timeOfDay),
      ...mapEnergyLevel(context.energyLevel)
    },
    dominantGenres: queries.slice(0, 4),
    seedArtists: [],
    seedTracks: [],
    excludedTrackIds: new Set<string>(),
    excludedTrackKeys: new Set<string>(),
    seenArtistIds: new Set<string>()
  } satisfies TasteProfile;
  const target = buildTargetFeatures(pseudoProfile, context);

  const ranked = candidates
    .map((track) => {
      const features = audioFeaturesByTrackId[track.id] || DEFAULT_AUDIO_FEATURES;
      const similarity = clamp(1 - tasteDistance(target, features) / 1.7, 0, 1);
      const contextFit =
        clamp(1 - Math.abs(target.energy - features.energy), 0, 1) * 0.32 +
        clamp(1 - Math.abs(target.valence - features.valence), 0, 1) * 0.18 +
        clamp(1 - Math.abs(target.danceability - features.danceability), 0, 1) * 0.15 +
        clamp(1 - Math.abs(target.tempo - features.tempo) / 70, 0, 1) * 0.2 +
        languageFit(track, context.languagePreference) * 0.15;
      const novelty = clamp(1 - normalize(track.popularity, 20, 90), 0, 1);
      const score = similarity * 0.34 + contextFit * 0.38 + novelty * 0.22 + seededValue(`${dailySalt}:${track.id}`) * 0.06;

      return {
        ...track,
        score,
        similarity,
        novelty,
        contextFit,
        reason: {
          headline: "Light-profile discovery mode",
          detail: `Spotify gave very little taste history, so this batch leans on your ${context.mood} / ${context.timeOfDay} vibe${
            context.languagePreference !== "any" ? ` with a ${LANGUAGE_LABELS[context.languagePreference].toLowerCase()} bias` : ""
          } while still trying to stay fresh.`
        }
      } satisfies RankedTrack;
    })
    .sort((left, right) => right.score - left.score);

  const seenTitles = new Set<string>();
  const finalTracks: RankedTrack[] = [];

  for (const track of ranked) {
    const titleKey = canonicalTitleKey(track);
    if (seenTitles.has(titleKey)) {
      continue;
    }

    seenTitles.add(titleKey);
    finalTracks.push(track);

    if (finalTracks.length === 24) {
      break;
    }
  }

  return {
    profileSummary: {
      dominantGenres: queries.slice(0, 5),
      averageFeatures: {
        energy: target.energy,
        valence: target.valence
      }
    },
    tracks: finalTracks
  };
}

function uniqueTracks(tracks: SpotifyTrack[]) {
  return uniqueBy(
    tracks.filter((track) => track?.id),
    (track) => canonicalTrackKey(track)
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

export async function collectProfileSource(
  playlistIds: string[],
  friendPlaylistInputs: string[] = []
): Promise<ProfileSource> {
  const [topTracksShort, topTracksMedium, topArtistsShort, topArtistsMedium, recentTracks] =
    await Promise.all([
      swallowSpotify403(() => getTopTracks("short_term", 25), []),
      swallowSpotify403(() => getTopTracks("medium_term", 25), []),
      swallowSpotify403(() => getTopArtists("short_term", 20), []),
      swallowSpotify403(() => getTopArtists("medium_term", 20), []),
      swallowSpotify403(() => getRecentlyPlayed(30), [])
    ]);

  const playlistTrackGroups = await Promise.all(
    playlistIds.map((playlistId) => swallowSpotify403(() => getPlaylistTracks(playlistId), []))
  );
  const friendPlaylistIds = extractPlaylistIds(friendPlaylistInputs).filter((playlistId) => !playlistIds.includes(playlistId));
  const friendPlaylistGroups = await Promise.all(
    friendPlaylistIds.map((playlistId) => swallowSpotify403(() => getPlaylistTracks(playlistId), []))
  );
  const playlistTracks = playlistTrackGroups.flat();
  const friendSignalTracks = friendPlaylistGroups.flat();

  return {
    topTracks: uniqueTracks([...topTracksShort, ...topTracksMedium]),
    topArtists: uniqueBy([...topArtistsShort, ...topArtistsMedium], (artist) => artist.id),
    recentTracks: uniqueTracks(recentTracks),
    playlistTracks: uniqueTracks(playlistTracks),
    friendSignalTracks: uniqueTracks(friendSignalTracks)
  };
}

export async function buildTasteProfile(source: ProfileSource): Promise<TasteProfile> {
  const blendedArtists = uniqueBy(
    [...source.topArtists, ...source.friendSignalTracks.flatMap((track) => track.artists)],
    (artist) => artist.id
  ).slice(0, 20);
  const seedTracks = uniqueTracks([
    ...source.topTracks,
    ...source.recentTracks,
    ...source.playlistTracks,
    ...source.friendSignalTracks.slice(0, 40)
  ]).slice(0, 80);
  const audioFeaturesByTrackId = await getAudioFeatures(seedTracks.map((track) => track.id));
  const dominantGenres = pickTopGenres(blendedArtists);

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
    [...source.topTracks, ...source.recentTracks, ...source.playlistTracks, ...source.friendSignalTracks].map(
      (track) => track.id
    )
  );
  const excludedTrackKeys = new Set<string>(
    [...source.topTracks, ...source.recentTracks, ...source.playlistTracks, ...source.friendSignalTracks].map((track) =>
      canonicalTrackKey(track)
    )
  );
  const seenArtistIds = new Set<string>(
    [
      ...blendedArtists.map((artist) => artist.id),
      ...seedTracks.flatMap((track) => track.artists.map((artist) => artist.id))
    ]
  );

  return {
    averageFeatures,
    dominantGenres,
    seedArtists: blendedArtists.slice(0, 10),
    seedTracks: seedTracks.slice(0, 10),
    excludedTrackIds,
    excludedTrackKeys,
    seenArtistIds
  };
}

async function expandCandidates(
  profile: TasteProfile,
  context: ContextInput,
  target: AudioFeatures
): Promise<{ candidates: SpotifyTrack[]; audioFeaturesByTrackId: Record<string, AudioFeatures> }> {
  const relatedArtistGroups = await Promise.all(
    profile.seedArtists
      .slice(0, 6)
      .map((artist) => swallowSpotify403(() => getRelatedArtists(artist.id), []))
  );
  const relatedArtists = uniqueBy(relatedArtistGroups.flat(), (artist) => artist.id)
    .filter((artist) => !profile.seenArtistIds.has(artist.id))
    .slice(0, 15);

  const recommendationTracks = await swallowSpotify403(
    () =>
      getRecommendations({
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
      }),
    []
  );

  const relatedArtistTrackGroups = await Promise.all(
    relatedArtists.slice(0, 10).map((artist) => swallowSpotify403(() => getArtistTopTracks(artist.id), []))
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
    profile.dominantGenres
      .slice(0, 3)
      .map((genre) => swallowSpotify403(() => searchTracks(`genre:"${genre}"${decadeQuery}`, 18), []))
  );

  const broadFallbackQueries = [
    profile.dominantGenres[0],
    profile.dominantGenres[1],
    context.mood === "focused"
      ? "indie alternative"
      : context.mood === "calm"
      ? "dream pop"
        : context.mood === "energetic"
          ? "indie dance"
          : context.mood === "melancholic"
            ? "art pop"
            : "nu disco",
    ...timeOfDaySearchHints(context.timeOfDay),
    context.energyLevel === "high"
      ? "high energy"
      : context.energyLevel === "low"
        ? "soft chill"
        : "midtempo",
    ...LANGUAGE_QUERY_HINTS[context.languagePreference]
  ].filter(Boolean) as string[];

  const broadFallbackSearchGroups = await Promise.all(
    broadFallbackQueries.map((query) => swallowSpotify403(() => searchTracks(`${query}${decadeQuery}`, 25), []))
  );

  const candidates = uniqueTracks([
    ...recommendationTracks,
    ...relatedArtistTrackGroups.flat(),
    ...genreSearchGroups.flat(),
    ...broadFallbackSearchGroups.flat()
  ]);
  const filteredCandidates = candidates.filter(
    (track) =>
      !profile.excludedTrackIds.has(track.id) &&
      !profile.excludedTrackKeys.has(canonicalTrackKey(track)) &&
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
  const source = await collectProfileSource(context.playlistIds, context.friendPlaylistInputs);
  const hasProfileData =
    source.topTracks.length ||
    source.topArtists.length ||
    source.recentTracks.length ||
    source.playlistTracks.length ||
    source.friendSignalTracks.length;

  if (!hasProfileData) {
    return buildContextOnlyRecommendations(context);
  }

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
      const languageScore = languageFit(track, context.languagePreference);
      const contextFit =
        clamp(1 - Math.abs(target.energy - features.energy), 0, 1) * 0.35 +
        clamp(1 - Math.abs(target.valence - features.valence), 0, 1) * 0.2 +
        clamp(1 - Math.abs(target.danceability - features.danceability), 0, 1) * 0.15 +
        clamp(1 - Math.abs(target.tempo - features.tempo) / 70, 0, 1) * 0.15 +
        clamp(1 - Math.abs(target.acousticness - features.acousticness), 0, 1) * 0.15 +
        languageScore * 0.18;

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
  const trackKeyCap = new Set<string>();
  const titleCap = new Map<string, number>();
  const finalTracks: RankedTrack[] = [];

  for (const track of ranked) {
    const leadArtistId = track.artists[0]?.id;
    const currentCount = leadArtistId ? artistCap.get(leadArtistId) || 0 : 0;
    const trackKey = canonicalTrackKey(track);
    const titleKey = canonicalTitleKey(track);
    const titleCount = titleCap.get(titleKey) || 0;

    if (leadArtistId && currentCount >= 1) {
      continue;
    }

    if (trackKeyCap.has(trackKey)) {
      continue;
    }

    if (titleCount >= 1) {
      continue;
    }

    if (leadArtistId) {
      artistCap.set(leadArtistId, currentCount + 1);
    }
    trackKeyCap.add(trackKey);
    titleCap.set(titleKey, titleCount + 1);
    finalTracks.push(track);

    if (finalTracks.length === 24) {
      break;
    }
  }

  if (!finalTracks.length) {
    const emergencyQueries = [
      profile.dominantGenres[0],
      profile.dominantGenres[1],
      context.mood === "focused"
        ? "indie alternative"
        : context.mood === "calm"
          ? "dream pop"
          : context.mood === "energetic"
            ? "dance rock"
            : context.mood === "melancholic"
              ? "art pop"
              : "nu disco",
      ...timeOfDaySearchHints(context.timeOfDay),
      ...LANGUAGE_QUERY_HINTS[context.languagePreference]
    ].filter(Boolean) as string[];

    const emergencySearchGroups = await Promise.all(
      emergencyQueries.map((query) => swallowSpotify403(() => searchTracks(query, 30), []))
    );
    const emergencyTracks = uniqueTracks(emergencySearchGroups.flat())
      .filter((track) => !profile.excludedTrackIds.has(track.id) && !profile.excludedTrackKeys.has(canonicalTrackKey(track)))
      .sort(
        (left, right) =>
          seededValue(`${dailySalt}:${right.id}`) +
          (1 - normalize(right.popularity, 20, 90)) * 0.2 -
          (seededValue(`${dailySalt}:${left.id}`) + (1 - normalize(left.popularity, 20, 90)) * 0.2)
      )
      .slice(0, 24)
      .map((track, index) => ({
        ...track,
        score: 0.4 - index * 0.001,
        similarity: 0.52,
        novelty: clamp(1 - normalize(track.popularity, 20, 90), 0, 1),
        contextFit: 0.48,
        reason: {
          headline: "Broader discovery fallback",
          detail: `Spotify returned a sparse first-pass set, so this pick comes from a wider ${context.mood} discovery search${
            context.languagePreference !== "any"
              ? ` with a ${LANGUAGE_LABELS[context.languagePreference].toLowerCase()} bias`
              : ""
          }.`
        }
      }));

    return {
      profileSummary: {
        dominantGenres: profile.dominantGenres,
        averageFeatures: profile.averageFeatures
      },
      tracks: emergencyTracks
    };
  }

  return {
    profileSummary: {
      dominantGenres: profile.dominantGenres,
      averageFeatures: profile.averageFeatures
    },
    tracks: finalTracks
  };
}
