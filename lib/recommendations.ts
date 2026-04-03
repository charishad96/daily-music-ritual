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
import { average, canonicalTitleKey, canonicalTrackKey, clamp, normalize, normalizeComparableText, releaseYear, seededValue, uniqueBy } from "@/lib/utils";
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
    if (error instanceof SpotifyApiError && [400, 403, 404, 429].includes(error.status)) {
      return fallback;
    }

    throw error;
  }
}

const LANGUAGE_QUERY_HINTS: Record<ContextInput["languagePreference"], string[]> = {
  any: [],
  english: ["english indie", "english alternative", "uk indie", "american indie", "indie singer songwriter"],
  greek: ["greek indie", "greek alternative", "greek pop", "entechno", "greek rock", "athens indie"],
  spanish: [
    "musica en espanol",
    "indie espanol",
    "spanish indie",
    "latin alternative",
    "argentine indie",
    "mexican indie",
    "indie latino"
  ],
  portuguese: [
    "mpb",
    "musica brasileira",
    "brazilian indie",
    "nova mpb",
    "portuguese indie",
    "brazilian soul",
    "indie brasileiro"
  ]
};

const LANGUAGE_LABELS: Record<ContextInput["languagePreference"], string> = {
  any: "language-open",
  english: "English-leaning",
  greek: "Greek-leaning",
  spanish: "Spanish-leaning",
  portuguese: "Portuguese-leaning"
};

const MIN_LANGUAGE_BATCH = 5;

const LANGUAGE_LEXICAL_SEEDS: Record<Exclude<ContextInput["languagePreference"], "any">, string[]> = {
  english: ["love", "night", "heart", "dream"],
  greek: ["αγαπη", "καρδια", "ονειρο", "νυχτα"],
  spanish: ["amor", "corazon", "vida", "noche", "quiero"],
  portuguese: ["amor", "coracao", "vida", "noite", "saudade"]
};

const SPANISH_STRONG_TOKENS = [
  "amor",
  "vida",
  "corazon",
  "noche",
  "quiero",
  "para",
  "beso",
  "corazon",
  "sueno",
  "cancion"
];

const PORTUGUESE_STRONG_TOKENS = [
  "amor",
  "vida",
  "coracao",
  "noite",
  "saudade",
  "voce",
  "pra",
  "meu",
  "minha",
  "cancao"
];

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

function textContainsLatinDiacritics(text: string) {
  return /[\u00e1\u00e9\u00ed\u00f3\u00fa\u00f1\u00fc\u00e3\u00f5\u00e2\u00ea\u00f4\u00e0\u00e7]/i.test(text);
}

function textIncludesAny(text: string, tokens: string[]) {
  return tokens.some((token) => text.includes(token));
}

function normalizedLanguageText(track: SpotifyTrack) {
  const title = normalizeComparableText(track.name);
  const album = normalizeComparableText(track.album.name);
  return `${title} ${album}`.trim();
}

function tokenMatchScore(text: string, tokens: string[]) {
  const padded = ` ${text} `;
  return tokens.reduce((score, token) => score + (padded.includes(` ${token} `) ? 1 : 0), 0);
}

function strongLanguageMatch(track: SpotifyTrack, languagePreference: ContextInput["languagePreference"]) {
  const textOnly = normalizedLanguageText(track);

  switch (languagePreference) {
    case "any":
      return true;
    case "english":
      return !textContainsGreek(track.name) && !textContainsGreek(track.album.name) && !textContainsLatinDiacritics(textOnly);
    case "greek":
      return textContainsGreek(track.name) || textContainsGreek(track.album.name);
    case "spanish":
      return /[\u00f1\u00e1\u00e9\u00ed\u00f3\u00fa]/i.test(track.name) || tokenMatchScore(textOnly, SPANISH_STRONG_TOKENS) >= 1;
    case "portuguese":
      return /[\u00e3\u00f5\u00e7]/i.test(track.name) || tokenMatchScore(textOnly, PORTUGUESE_STRONG_TOKENS) >= 1;
  }
}

function softLanguageMatch(track: SpotifyTrack, languagePreference: ContextInput["languagePreference"]) {
  if (strongLanguageMatch(track, languagePreference)) {
    return true;
  }

  const textOnly = normalizedLanguageText(track);

  switch (languagePreference) {
    case "any":
      return true;
    case "english":
      return languageFit(track, languagePreference) >= 0.55;
    case "greek":
      return textIncludesAny(textOnly, ["entechno", "athina", "athens"]);
    case "spanish":
      return textIncludesAny(textOnly, ["latino", "espanol", "cancion", "mexico", "argentina"]);
    case "portuguese":
      return textIncludesAny(textOnly, ["brasil", "brasileiro", "mpb", "portugues"]);
  }
}

function languageFit(track: SpotifyTrack, languagePreference: ContextInput["languagePreference"]) {
  if (languagePreference === "any") {
    return 0.5;
  }

  const textOnly = normalizedLanguageText(track);
  const spanishTokens = ["el", "la", "de", "del", "que", "como", "sin", "para", "mi", "tu", "yo", "amor", "vida"];
  const portugueseTokens = ["voce", "nao", "pra", "saudade", "meu", "minha", "com", "uma", "eu", "amor"];

  switch (languagePreference) {
    case "english":
      return textContainsGreek(track.name) || textContainsGreek(track.album.name)
        ? 0.05
        : textContainsLatinDiacritics(textOnly)
          ? 0.28
          : 0.82;
    case "greek":
      return textContainsGreek(track.name) || textContainsGreek(track.album.name)
        ? 1
        : textIncludesAny(textOnly, ["entechno", "athina", "athens"])
          ? 0.34
          : 0.02;
    case "spanish":
      return tokenMatchScore(textOnly, spanishTokens) >= 2 || /[\u00f1\u00e1\u00e9\u00ed\u00f3\u00fa]/i.test(track.name)
        ? 0.96
        : textIncludesAny(textOnly, ["latino", "cancion", "espanol"])
          ? 0.38
          : 0.02;
    case "portuguese":
      return tokenMatchScore(textOnly, portugueseTokens) >= 2 || /[\u00e3\u00f5\u00e7]/i.test(track.name)
        ? 0.96
        : textIncludesAny(textOnly, ["brasil", "brasileiro", "mpb", "portugues"])
          ? 0.38
          : 0.02;
  }
}

function languageFloor(languagePreference: ContextInput["languagePreference"]) {
  switch (languagePreference) {
    case "any":
      return 0;
    case "english":
      return 0.35;
    case "greek":
      return 0.72;
    case "spanish":
      return 0.68;
    case "portuguese":
      return 0.68;
  }
}

function languageSoftFloor(languagePreference: ContextInput["languagePreference"]) {
  if (languagePreference === "any") {
    return 0;
  }

  return Math.max(languageFloor(languagePreference) - 0.18, 0.34);
}

function enforceLanguagePreference(tracks: SpotifyTrack[], languagePreference: ContextInput["languagePreference"]) {
  if (languagePreference === "any") {
    return tracks;
  }

  const strictMatches = tracks.filter((track) => strongLanguageMatch(track, languagePreference));

  if (strictMatches.length >= 12) {
    return strictMatches;
  }

  const softMatches = tracks.filter((track) => softLanguageMatch(track, languagePreference));

  if (softMatches.length >= 8) {
    return softMatches;
  }

  if (strictMatches.length) {
    return strictMatches;
  }

  return softMatches;
}

function isLanguageLocked(languagePreference: ContextInput["languagePreference"]) {
  return languagePreference !== "any";
}

function languageLockedQueries(context: ContextInput) {
  if (!isLanguageLocked(context.languagePreference)) {
    return [] as string[];
  }

  const moodHint =
    context.mood === "focused"
      ? "focused"
      : context.mood === "calm"
        ? "soft"
        : context.mood === "energetic"
          ? "upbeat"
          : context.mood === "melancholic"
            ? "melancholic"
            : "social";

  return LANGUAGE_QUERY_HINTS[context.languagePreference]
    .flatMap((hint) => [hint, `${hint} ${moodHint}`])
    .slice(0, 3);
}

function languageRescueQueries(context: ContextInput) {
  const moodHint =
    context.mood === "focused"
      ? "focused"
      : context.mood === "calm"
        ? "soft"
        : context.mood === "energetic"
          ? "upbeat"
          : context.mood === "melancholic"
            ? "melancholic"
            : "social";

  switch (context.languagePreference) {
    case "any":
      return [] as string[];
    case "english":
      return ["english indie", `english indie ${moodHint}`, "uk alternative"];
    case "greek":
      return ["greek indie", `greek indie ${moodHint}`, "greek singer songwriter"];
    case "spanish":
      return ["musica en espanol", `spanish indie ${moodHint}`, "latin alternative"];
    case "portuguese":
      return ["musica brasileira", `brazilian indie ${moodHint}`, "mpb"];
  }
}

async function searchLanguageLockedTracks(context: ContextInput) {
  if (!isLanguageLocked(context.languagePreference)) {
    return [] as SpotifyTrack[];
  }

  const queries = languageLockedQueries(context);
  const searchGroups = await Promise.all(
    queries.map((query) => swallowSpotify403(() => searchTracks(query, 10), []))
  );

  const languageFirst = uniqueTracks(searchGroups.flat()).filter(
    (track) => languageFit(track, context.languagePreference) >= languageFloor(context.languagePreference)
  );

  return languageFirst;
}

async function searchLanguageRescueTracks(
  context: ContextInput,
  excludeTrackIds: string[] = []
) {
  if (!isLanguageLocked(context.languagePreference)) {
    return [] as SpotifyTrack[];
  }

  const lexicalQueries = LANGUAGE_LEXICAL_SEEDS[context.languagePreference].slice(0, 3);
  const queries = [...languageRescueQueries(context), ...lexicalQueries];
  const searchGroups = await Promise.all(
    queries.map((query) => swallowSpotify403(() => searchTracks(query, 6), []))
  );

  const unique = uniqueTracks(searchGroups.flat()).filter((track) => !excludeTrackIds.includes(track.id));
  const strict = unique.filter((track) => strongLanguageMatch(track, context.languagePreference));

  if (strict.length >= MIN_LANGUAGE_BATCH) {
    return strict.slice(0, 12);
  }

  const soft = unique
    .filter((track) => softLanguageMatch(track, context.languagePreference))
    .slice(0, 12);

  if (strict.length) {
    return uniqueTracks([...strict, ...soft]).slice(0, 12);
  }

  return soft;
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
    ...LANGUAGE_QUERY_HINTS[context.languagePreference],
    ...(context.languagePreference === "greek"
      ? ["greek singer songwriter", "athens indie"]
      : context.languagePreference === "spanish"
        ? ["latin singer songwriter", "indie latino"]
        : context.languagePreference === "portuguese"
          ? ["brazilian singer songwriter", "indie brasileiro"]
          : [])
  ].filter(Boolean) as string[];
}

function buildFamiliaritySets(source: ProfileSource) {
  return {
    topTrackIds: new Set(source.topTracks.map((track) => track.id)),
    recentTrackIds: new Set(source.recentTracks.map((track) => track.id)),
    playlistTrackIds: new Set(source.playlistTracks.map((track) => track.id))
  };
}

async function buildSafeRecallTracks(
  source: ProfileSource,
  profile: TasteProfile,
  context: ContextInput,
  target: AudioFeatures,
  dailySalt: string
) {
  const familiarPool = uniqueTracks([...source.topTracks, ...source.recentTracks, ...source.playlistTracks]).slice(0, 50);

  if (!familiarPool.length) {
    return [] as RankedTrack[];
  }

  const familiaritySets = buildFamiliaritySets(source);
  const audioFeaturesByTrackId = await getAudioFeatures(familiarPool.map((track) => track.id));
  const safety = normalize(context.familiarity, 0, 100);

  return familiarPool
    .map((track) => {
      const features = audioFeaturesByTrackId[track.id] || DEFAULT_AUDIO_FEATURES;
      const similarity = clamp(1 - tasteDistance(target, features) / 1.5, 0, 1);
      const contextFit =
        clamp(1 - Math.abs(target.energy - features.energy), 0, 1) * 0.32 +
        clamp(1 - Math.abs(target.valence - features.valence), 0, 1) * 0.18 +
        clamp(1 - Math.abs(target.danceability - features.danceability), 0, 1) * 0.14 +
        clamp(1 - Math.abs(target.tempo - features.tempo) / 70, 0, 1) * 0.18 +
        languageFit(track, context.languagePreference) * 0.18;
      const familiarityRecall =
        (familiaritySets.topTrackIds.has(track.id) ? 0.6 : 0) +
        (familiaritySets.recentTrackIds.has(track.id) ? 0.22 : 0) +
        (familiaritySets.playlistTrackIds.has(track.id) ? 0.16 : 0) +
        clamp(normalize(track.popularity, 35, 90), 0, 1) * 0.12;
      const score =
        similarity * (0.34 + safety * 0.14) +
        contextFit * 0.22 +
        familiarityRecall * (0.26 + safety * 0.3) +
        seededValue(`${dailySalt}:safe:${track.id}`) * 0.02;

      return {
        ...track,
        score,
        similarity,
        novelty: clamp(1 - familiarityRecall, 0, 1) * 0.3,
        contextFit,
        reason: {
          headline: "Comfort-zone anchor",
          detail: `This is a highly familiar-feeling pick pulled closer to your known listening so the batch can feel safer and more immediately rewarding.`
        }
      } satisfies RankedTrack;
    })
    .sort((left, right) => right.score - left.score);
}

async function buildKnownPoolRescueTracks(
  source: ProfileSource,
  context: ContextInput,
  target: AudioFeatures,
  dailySalt: string
) {
  const familiarPool = uniqueTracks([
    ...source.topTracks,
    ...source.recentTracks,
    ...source.playlistTracks,
    ...source.friendSignalTracks
  ]).slice(0, 60);

  if (!familiarPool.length) {
    return [] as RankedTrack[];
  }

  const filteredPool = isLanguageLocked(context.languagePreference)
    ? familiarPool.filter((track) => softLanguageMatch(track, context.languagePreference))
    : familiarPool;

  if (!filteredPool.length) {
    return [] as RankedTrack[];
  }

  const audioFeaturesByTrackId = await getAudioFeatures(filteredPool.map((track) => track.id));

  return filteredPool
    .map((track) => {
      const features = audioFeaturesByTrackId[track.id] || DEFAULT_AUDIO_FEATURES;
      const similarity = clamp(1 - tasteDistance(target, features) / 1.55, 0, 1);
      const contextFit =
        clamp(1 - Math.abs(target.energy - features.energy), 0, 1) * 0.34 +
        clamp(1 - Math.abs(target.valence - features.valence), 0, 1) * 0.2 +
        clamp(1 - Math.abs(target.danceability - features.danceability), 0, 1) * 0.14 +
        clamp(1 - Math.abs(target.tempo - features.tempo) / 70, 0, 1) * 0.14 +
        languageFit(track, context.languagePreference) * 0.18;
      const familiarity = clamp(normalize(track.popularity, 25, 90), 0, 1);
      const score = similarity * 0.4 + contextFit * 0.36 + familiarity * 0.18 + seededValue(`${dailySalt}:known:${track.id}`) * 0.06;

      return {
        ...track,
        score,
        similarity,
        novelty: clamp(1 - familiarity, 0, 1) * 0.22,
        contextFit,
        reason: {
          headline: "Known-pool rescue",
          detail: "Spotify search came back too thin, so this batch falls back to stronger matches from your own broader listening pool."
        }
      } satisfies RankedTrack;
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 12);
}

async function buildContextOnlyRecommendations(context: ContextInput) {
  const dailySalt = `${new Date().toISOString().slice(0, 10)}:${context.refreshKey || "0"}`;
  const queries = contextOnlySearchQueries(context);
  const lockedTracks = await searchLanguageLockedTracks(context);
  const rescuedLockedTracks =
    isLanguageLocked(context.languagePreference) && lockedTracks.length < MIN_LANGUAGE_BATCH
      ? await searchLanguageRescueTracks(
          context,
          lockedTracks.map((track) => track.id)
        )
      : [];
  const languagePool = uniqueTracks([...lockedTracks, ...rescuedLockedTracks]);
  const searchGroups =
    isLanguageLocked(context.languagePreference) && languagePool.length
      ? [languagePool]
      : await Promise.all(queries.map((query) => swallowSpotify403(() => searchTracks(query, 10), [])));
  const candidates = enforceLanguagePreference(uniqueTracks(searchGroups.flat()), context.languagePreference).filter(
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

  if (isLanguageLocked(context.languagePreference) && finalTracks.length > 0) {
    return {
      profileSummary: {
        dominantGenres: queries.slice(0, 5),
        averageFeatures: {
          energy: target.energy,
          valence: target.valence
        }
      },
      tracks: finalTracks.slice(0, Math.max(MIN_LANGUAGE_BATCH, finalTracks.length))
    };
  }

  if (!finalTracks.length) {
    const languageRescue =
      isLanguageLocked(context.languagePreference)
        ? await searchLanguageRescueTracks(context, context.excludeTrackIds || [])
        : [];

    if (languageRescue.length) {
      return {
        profileSummary: {
          dominantGenres: queries.slice(0, 5),
          averageFeatures: {
            energy: target.energy,
            valence: target.valence
          }
        },
        tracks: languageRescue.slice(0, 12).map((track, index) => ({
          ...track,
          score: 0.38 - index * 0.001,
          similarity: 0.46,
          novelty: clamp(1 - normalize(track.popularity, 20, 90), 0, 1),
          contextFit: 0.52,
          reason: {
            headline: `${LANGUAGE_LABELS[context.languagePreference]} rescue`,
            detail: `Your selected language was kept strict, so this smaller batch pulls only from stronger ${LANGUAGE_LABELS[
              context.languagePreference
            ].toLowerCase()} matches.`
          }
        }))
      };
    }

    const widenedQueries = [
      context.mood === "calm"
        ? "ambient"
        : context.mood === "focused"
          ? "instrumental electronic"
          : context.mood === "energetic"
            ? "indie dance"
            : context.mood === "melancholic"
              ? "slowcore"
              : "indie soul",
      context.energyLevel === "high" ? "upbeat" : context.energyLevel === "low" ? "soft" : "midtempo"
    ];
    const widenedSearchGroups = await Promise.all(
      widenedQueries.map((query) => swallowSpotify403(() => searchTracks(query, 10), []))
    );
    const widenedTracks = enforceLanguagePreference(uniqueTracks(widenedSearchGroups.flat()), context.languagePreference).slice(0, 24);

    return {
      profileSummary: {
        dominantGenres: queries.slice(0, 5),
        averageFeatures: {
          energy: target.energy,
          valence: target.valence
        }
      },
      tracks: widenedTracks.map((track, index) => ({
        ...track,
        score: 0.32 - index * 0.001,
        similarity: 0.42,
        novelty: clamp(1 - normalize(track.popularity, 20, 90), 0, 1),
        contextFit: 0.44,
        reason: {
          headline: "Recovery fallback",
          detail: "Your profile was too sparse for a strong first pass, so this batch widens the search instead of failing silently."
        }
      }))
    };
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
  ]
    .filter(Boolean)
    .slice(0, isLanguageLocked(context.languagePreference) ? 4 : 6) as string[];

  const broadFallbackSearchGroups = await Promise.all(
    broadFallbackQueries.map((query) => swallowSpotify403(() => searchTracks(`${query}${decadeQuery}`, 25), []))
  );
  const languageLockedTracks = await searchLanguageLockedTracks(context);
  const rescuedLanguageLockedTracks =
    isLanguageLocked(context.languagePreference) && languageLockedTracks.length < MIN_LANGUAGE_BATCH
      ? await searchLanguageRescueTracks(
          context,
          languageLockedTracks.map((track) => track.id)
        )
      : [];
  const mergedLanguageLockedTracks = uniqueTracks([...languageLockedTracks, ...rescuedLanguageLockedTracks]);

  const candidates = enforceLanguagePreference(
    uniqueTracks([
      ...(mergedLanguageLockedTracks.length ? [] : recommendationTracks),
      ...(mergedLanguageLockedTracks.length ? [] : relatedArtistTrackGroups.flat()),
      ...(isLanguageLocked(context.languagePreference) ? [] : genreSearchGroups.flat()),
      ...(isLanguageLocked(context.languagePreference) ? [] : broadFallbackSearchGroups.flat()),
      ...mergedLanguageLockedTracks
    ]),
    context.languagePreference
  );
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
  const safeRecallTracks = safety >= 0.72 ? await buildSafeRecallTracks(source, profile, context, target, dailySalt) : [];

  const discoveryRanked: RankedTrack[] = candidates
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
    .filter((track) => (safety >= 0.72 ? track.popularity <= 92 : track.popularity <= 82))
    .sort((a, b) => b.score - a.score);

  const ranked: RankedTrack[] =
    safety >= 0.72
      ? uniqueBy([...safeRecallTracks, ...discoveryRanked], (track) => canonicalTrackKey(track)).sort((a, b) => b.score - a.score)
      : discoveryRanked;

  const artistCap = new Map<string, number>();
  const trackKeyCap = new Set<string>();
  const titleCap = new Map<string, number>();
  const finalTracks: RankedTrack[] = [];
  const artistLimit = safety >= 0.78 ? 2 : 1;
  const titleLimit = safety >= 0.9 ? 2 : 1;

  for (const track of ranked) {
    const leadArtistId = track.artists[0]?.id;
    const currentCount = leadArtistId ? artistCap.get(leadArtistId) || 0 : 0;
    const trackKey = canonicalTrackKey(track);
    const titleKey = canonicalTitleKey(track);
    const titleCount = titleCap.get(titleKey) || 0;

    if (leadArtistId && currentCount >= artistLimit) {
      continue;
    }

    if (trackKeyCap.has(trackKey)) {
      continue;
    }

    if (titleCount >= titleLimit) {
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
    const knownPoolRescue = await buildKnownPoolRescueTracks(source, context, target, dailySalt);

    if (knownPoolRescue.length) {
      return {
        profileSummary: {
          dominantGenres: profile.dominantGenres,
          averageFeatures: profile.averageFeatures
        },
        tracks: knownPoolRescue
      };
    }

    const languageRescue =
      isLanguageLocked(context.languagePreference)
        ? await searchLanguageRescueTracks(
            context,
            [...profile.excludedTrackIds]
          )
        : [];

    if (languageRescue.length) {
      const rescueTracks = languageRescue.slice(0, 12).map((track, index) => ({
        ...track,
        score: 0.4 - index * 0.001,
        similarity: 0.5,
        novelty: clamp(1 - normalize(track.popularity, 20, 90), 0, 1),
        contextFit: 0.54,
        reason: {
          headline: `${LANGUAGE_LABELS[context.languagePreference]} rescue`,
          detail: `Your selected language was kept strict, so this smaller batch prioritizes stronger ${LANGUAGE_LABELS[
            context.languagePreference
          ].toLowerCase()} matches over volume.`
        }
      }));

      return {
        profileSummary: {
          dominantGenres: profile.dominantGenres,
          averageFeatures: profile.averageFeatures
        },
        tracks: rescueTracks
      };
    }

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
    ]
      .filter(Boolean)
      .slice(0, isLanguageLocked(context.languagePreference) ? 4 : 5) as string[];

    const emergencySearchGroups = await Promise.all(
      emergencyQueries.map((query) => swallowSpotify403(() => searchTracks(query, 30), []))
    );
    const emergencyTracks = enforceLanguagePreference(uniqueTracks(emergencySearchGroups.flat()), context.languagePreference)
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



