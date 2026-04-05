"use client";

import Image from "next/image";
import { useEffect, useMemo, useState, useTransition } from "react";
import type { ReactNode } from "react";
import { formatDateLabel } from "@/lib/utils";
import type { BootstrapResponse, ContextInput, RankedTrack } from "@/types";

const defaultContext: ContextInput = {
  mood: "focused",
  energyLevel: "medium",
  languagePreference: "any",
  familiarity: 38,
  playlistIds: [],
  friendPlaylistInputs: []
};

const moods = ["calm", "focused", "energetic", "melancholic", "social"] as const;
const energyLevels = ["low", "medium", "high"] as const;

export function Dashboard() {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [context, setContext] = useState<ContextInput>(defaultContext);
  const [tracks, setTracks] = useState<RankedTrack[]>([]);
  const [profileSummary, setProfileSummary] = useState<{
    dominantGenres: string[];
    averageFeatures: { energy: number; valence: number };
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playlistState, setPlaylistState] = useState<{ saving: boolean; url?: string }>({
    saving: false
  });
  const [isBootstrapping, startBootstrap] = useTransition();
  const [isLoading, startLoading] = useTransition();
  const [refreshCount, setRefreshCount] = useState(0);
  const [lastRunContextKey, setLastRunContextKey] = useState<string | null>(null);

  useEffect(() => {
    startBootstrap(async () => {
      const response = await fetch("/api/recommendations", { method: "GET" });
      const data = (await response.json()) as BootstrapResponse;
      setBootstrap(data);
      if (data.restricted && data.restrictionReason) {
        setError(data.restrictionReason);
      }
    });
  }, []);

  const selectedPlaylistNames = useMemo(() => {
    if (!bootstrap?.playlists) {
      return [];
    }

    return bootstrap.playlists
      .filter((playlist) => context.playlistIds.includes(playlist.id))
      .map((playlist) => playlist.name);
  }, [bootstrap?.playlists, context.playlistIds]);
  const friendSignalsSummary = context.friendPlaylistInputs.filter(Boolean).length;

  async function runRecommendations(nextRefreshCount = refreshCount) {
    setError(null);
    setPlaylistState({ saving: false });
    const contextKey = JSON.stringify(context);
    const contextChanged = lastRunContextKey !== contextKey;

    startLoading(async () => {
      const response = await fetch("/api/recommendations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ...context,
          excludeTrackIds: tracks.map((track) => track.id),
          refreshKey: String(nextRefreshCount)
        })
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "We could not generate a fresh batch right now.");
        return;
      }

      if (!data.tracks?.length) {
        setTracks([]);
        setProfileSummary(data.profileSummary || null);
        setError("We couldn't build a strong batch from this profile yet, so try another vibe or add a playlist signal.");
        return;
      }

      setTracks(data.tracks);
      setProfileSummary(data.profileSummary);
      setLastRunContextKey(contextKey);
      if (contextChanged) {
        setRefreshCount(nextRefreshCount + 1);
      }
    });
  }

  async function savePlaylist() {
    setPlaylistState({ saving: true });

    const response = await fetch("/api/playlists", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        context,
        trackUris: tracks.map((track) => track.uri)
      })
    });

    const data = await response.json();

    if (!response.ok) {
      setPlaylistState({
        saving: false
      });
      setError(data.error || "Playlist save failed.");
      return;
    }

    setPlaylistState({
      saving: false,
      url: data.playlistUrl
    });
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-7xl flex-col px-5 pb-12 pt-6 md:px-8">
      <section className="relative overflow-hidden rounded-[2rem] border border-white/60 bg-white/55 px-6 py-7 shadow-halo md:px-10 md:py-10">
        <div className="absolute inset-y-0 right-0 hidden w-1/3 bg-gradient-to-l from-gold/10 to-transparent md:block" />
        <div className="relative flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.28em] text-dusk/65">
              Daily Music Ritual
            </p>
            <h1 className="max-w-xl text-5xl leading-none text-dusk md:text-7xl">
              Fresh Spotify picks for the exact mood you are in.
            </h1>
            <p className="mt-4 max-w-xl text-sm leading-6 text-ink/72 md:text-base">
              We blend your top tracks, recent listening, favorite artists, and optional playlists into a daily
              recommendation batch that leans fresh, non-obvious, and context-aware.
            </p>
          </div>
          <div className="glass rounded-[1.5rem] border border-white/70 px-5 py-4 text-sm text-ink/70">
            <div className="text-xs uppercase tracking-[0.24em] text-dusk/60">{formatDateLabel()}</div>
              <div className="mt-2 text-2xl font-semibold text-dusk">
              {bootstrap?.restricted ? "Spotify account access blocked" : bootstrap?.authenticated ? "Ready to generate" : "Connect Spotify first"}
              </div>
              <div className="mt-2 max-w-sm leading-6">
              {bootstrap?.restricted
                ? "This Spotify account signed in, but Spotify did not grant this app enough API access yet."
                : "Keep the controls light, then pull a batch you can actually use right now."}
              </div>
            </div>
        </div>
      </section>

      {!bootstrap?.authenticated && !isBootstrapping ? (
        <section className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="glass rounded-[2rem] border border-white/70 p-7">
            <h2 className="text-3xl text-dusk">Connect your Spotify taste profile</h2>
            <p className="mt-3 max-w-xl text-sm leading-6 text-ink/70">
              The app reads your top tracks, top artists, recently played songs, and any playlists you choose. It then
              looks for deeper cuts and context-fit discoveries instead of replaying your obvious favorites.
            </p>
            <a
              href="/api/spotify/auth"
              className="mt-6 inline-flex items-center rounded-full bg-dusk px-5 py-3 text-sm font-semibold text-white transition hover:bg-dusk/90"
            >
              Log in with Spotify
            </a>
          </div>
          <div className="rounded-[2rem] border border-dusk/10 bg-dusk p-7 text-rosewater shadow-halo">
            <div className="text-xs uppercase tracking-[0.24em] text-rosewater/70">How it feels</div>
            <ul className="mt-4 space-y-3 text-sm leading-6 text-rosewater/88">
              <li>Lean controls instead of a crowded dashboard</li>
              <li>Novelty bias that avoids your top and recent history</li>
              <li>Playlist save for the batch that actually lands</li>
            </ul>
          </div>
        </section>
      ) : null}

      {bootstrap?.authenticated ? (
        <section className="mt-8 grid gap-6 xl:grid-cols-[350px_minmax(0,1fr)]">
          <aside className="glass h-fit rounded-[2rem] border border-white/70 p-6">
            <div className="flex items-center gap-4">
              {bootstrap.profile?.images?.[0]?.url ? (
                <Image
                  src={bootstrap.profile.images[0].url}
                  alt={bootstrap.profile.display_name || "Spotify profile"}
                  width={68}
                  height={68}
                  className="h-16 w-16 rounded-2xl object-cover"
                />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-dusk text-lg font-semibold text-white">
                  {(bootstrap.profile?.display_name || "S").slice(0, 1)}
                </div>
              )}
              <div>
                <div className="text-xs uppercase tracking-[0.2em] text-dusk/55">Connected listener</div>
                <div className="mt-1 text-2xl font-semibold text-dusk">{bootstrap.profile?.display_name}</div>
                <div className="text-sm text-ink/60">{bootstrap.profile?.country || "Spotify account"}</div>
              </div>
            </div>

            <div className="mt-7 space-y-5">
              <ControlGroup label="Mood">
                <SegmentedRow
                  value={context.mood}
                  options={moods}
                  onChange={(mood) => setContext((current) => ({ ...current, mood }))}
                />
              </ControlGroup>

              <ControlGroup label="Energy">
                <SegmentedRow
                  value={context.energyLevel}
                  options={energyLevels}
                  onChange={(energyLevel) => setContext((current) => ({ ...current, energyLevel }))}
                />
              </ControlGroup>

              <ControlGroup label="Familiarity">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={context.familiarity}
                  onChange={(event) =>
                    setContext((current) => ({
                      ...current,
                      familiarity: Number(event.target.value)
                    }))
                  }
                  className="w-full accent-ember"
                />
                <div className="mt-2 flex justify-between text-xs uppercase tracking-[0.18em] text-ink/45">
                  <span>Exploratory</span>
                  <span>Safe</span>
                </div>
              </ControlGroup>

              <ControlGroup label="Playlist signals">
                <div className="max-h-52 space-y-2 overflow-auto pr-1">
                  {bootstrap.playlists?.slice(0, 8).map((playlist) => {
                    const selected = context.playlistIds.includes(playlist.id);
                    return (
                      <button
                        key={playlist.id}
                        type="button"
                        onClick={() =>
                          setContext((current) => ({
                            ...current,
                            playlistIds: selected
                              ? current.playlistIds.filter((id) => id !== playlist.id)
                              : [...current.playlistIds, playlist.id]
                          }))
                        }
                        className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                          selected
                            ? "border-pine bg-pine text-white"
                            : "border-dusk/12 bg-white/75 text-ink/75 hover:border-dusk/25"
                        }`}
                      >
                        <div className="text-sm font-semibold">{playlist.name}</div>
                        <div className={`mt-1 text-xs ${selected ? "text-white/75" : "text-ink/50"}`}>
                          {playlist.tracksTotal} tracks
                        </div>
                      </button>
                    );
                  })}
                </div>
              </ControlGroup>

              <ControlGroup label="Channel friends' signals">
                <textarea
                  value={context.friendPlaylistInputs.join("\n")}
                  onChange={(event) =>
                    setContext((current) => ({
                      ...current,
                      friendPlaylistInputs: event.target.value
                        .split(/\r?\n|,/)
                        .map((value) => value.trim())
                        .filter(Boolean)
                    }))
                  }
                  rows={4}
                  placeholder="Paste public Spotify playlist links from friends, one per line."
                  className="w-full rounded-[1.4rem] border border-dusk/12 bg-white/75 px-4 py-3 text-sm leading-6 text-ink/78 outline-none transition placeholder:text-ink/38 focus:border-dusk/28"
                />
                <p className="mt-2 text-xs leading-5 text-ink/52">
                  Public playlist links or playlist IDs both work. We use them as extra vibe signals, not as exact copies.
                </p>
              </ControlGroup>
            </div>
          </aside>

          <section className="space-y-6">
            <div className="glass rounded-[2rem] border border-white/70 p-6">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <div className="text-xs uppercase tracking-[0.24em] text-dusk/55">Today&apos;s batch</div>
                  <h2 className="mt-1 text-3xl text-dusk">Build a focused set of deep cuts</h2>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-ink/68">
                    Current profile: {context.mood}, {context.energyLevel} energy
                    {selectedPlaylistNames.length ? `, seeded with ${selectedPlaylistNames.join(", ")}` : ""}
                    {friendSignalsSummary
                      ? `, plus ${friendSignalsSummary} friend vibe ${friendSignalsSummary === 1 ? "signal" : "signals"}`
                      : ""}.
                  </p>
                </div>
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      const next = refreshCount + 1;
                      setRefreshCount(next);
                      void runRecommendations(next);
                    }}
                    disabled={isLoading || Boolean(bootstrap?.restricted)}
                    className="rounded-full bg-dusk px-5 py-3 text-sm font-semibold text-white transition hover:bg-dusk/90 disabled:opacity-60"
                  >
                    {isLoading ? "Generating..." : tracks.length ? "New batch" : "Generate recommendations"}
                  </button>
                  <button
                    type="button"
                    onClick={savePlaylist}
                    disabled={playlistState.saving || !tracks.length}
                    className="rounded-full border border-ember/20 bg-ember/10 px-5 py-3 text-sm font-semibold text-ember transition hover:bg-ember/15 disabled:opacity-50"
                  >
                    {playlistState.saving ? "Saving..." : "Save as Spotify playlist"}
                  </button>
                </div>
              </div>

              {profileSummary ? (
                <div className="mt-5 flex flex-wrap gap-3">
                  {profileSummary.dominantGenres.slice(0, 5).map((genre) => (
                    <span
                      key={genre}
                      className="rounded-full border border-dusk/10 bg-white/70 px-3 py-1 text-xs uppercase tracking-[0.16em] text-dusk/72"
                    >
                      {genre}
                    </span>
                  ))}
                </div>
              ) : null}

              {playlistState.url ? (
                <a
                  href={playlistState.url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-4 inline-flex text-sm font-semibold text-pine underline decoration-pine/35 underline-offset-4"
                >
                  Open saved playlist in Spotify
                </a>
              ) : null}

              {error ? <div className="mt-4 rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
            </div>

            <div className="grid gap-4">
              {tracks.length ? (
                tracks.map((track, index) => <TrackCard key={track.id} track={track} index={index} />)
              ) : (
                <div className="glass rounded-[2rem] border border-white/70 p-8 text-center text-sm leading-6 text-ink/62">
                  Pull a batch to get 20 to 24 recommendations.
                </div>
              )}
            </div>
          </section>
        </section>
      ) : null}
    </main>
  );
}

function ControlGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-3 text-xs uppercase tracking-[0.2em] text-dusk/55">{label}</div>
      {children}
    </div>
  );
}

function SegmentedRow<T extends string>({
  value,
  options,
  onChange
}: {
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={`rounded-2xl border px-3 py-2 text-sm capitalize transition ${
            option === value
              ? "border-dusk bg-dusk text-white"
              : "border-dusk/12 bg-white/70 text-ink/68 hover:border-dusk/25"
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function TrackCard({ track, index }: { track: RankedTrack; index: number }) {
  return (
    <article className="glass relative rounded-[1.8rem] border border-white/70 p-4 md:p-5">
      <div className="absolute left-4 top-4 z-10 flex h-10 w-10 items-center justify-center rounded-2xl bg-dusk text-sm font-semibold text-white">
        {index + 1}
      </div>
      <div className="overflow-hidden rounded-[1.5rem] border border-dusk/10 bg-white pl-12">
          <iframe
            title={`${track.name} preview`}
            src={`https://open.spotify.com/embed/track/${track.id}?utm_source=generator`}
            width="100%"
            height="152"
            loading="lazy"
            allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
          />
      </div>
    </article>
  );
}
