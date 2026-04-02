# Daily Music Ritual

A lightweight Spotify-powered web app that turns a listener's taste plus a small amount of context into a daily batch of fresh recommendations.

## What it does

- Connects to Spotify with OAuth.
- Reads top tracks, top artists, recently played songs, optional playlists, and optional public friend-playlist links.
- Accepts lightweight context controls including mood, time of day, energy, familiarity, and language bias.
- Builds a simple taste profile from dominant genres, artist neighborhoods, and average audio features.
- Generates 20 to 24 recommendations that bias toward novelty, lower-popularity cuts, and context fit.
- Lets the user save any generated batch as a private Spotify playlist.

## Stack

- Next.js App Router
- React
- Tailwind CSS
- Spotify Web API

## Setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env.local`.
3. Create a Spotify app in the Spotify developer dashboard.
4. Add this redirect URI to the Spotify app:

```text
http://localhost:3000/api/spotify/callback
```

5. Fill in these environment variables:

```env
SPOTIFY_CLIENT_ID=...
SPOTIFY_CLIENT_SECRET=...
SPOTIFY_REDIRECT_URI=http://localhost:3000/api/spotify/callback
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

6. Install dependencies and run the app:

```bash
npm install
npm run dev
```

7. Open [http://localhost:3000](http://localhost:3000).

## Deploying to Vercel

1. Import the repo into Vercel.
2. Add the same Spotify environment variables in the Vercel project settings.
3. Add the production callback URL to your Spotify app:

```text
https://your-domain.com/api/spotify/callback
```

4. Update `SPOTIFY_REDIRECT_URI` and `NEXT_PUBLIC_APP_URL` to match the deployed domain.

## Recommendation logic

The recommendation pipeline is heuristic-based on purpose:

1. Taste profile
   - Pull the user's short and medium-term top tracks.
   - Pull top artists and recently played tracks.
   - Optionally blend in tracks from selected playlists and public playlists shared by friends.
   - Average Spotify audio features across the combined seed tracks.
   - Extract dominant genres from the user's top artists plus any friend-playlist artist overlap.

2. Expansion
   - Ask Spotify for recommendations using seed artists, seed tracks, seed genres, and target audio features.
   - Expand outward through related artists and their top tracks.
   - Add a small genre search layer for broader discovery.
   - Add heuristic language-biased search hints for English, Greek, Spanish, and Portuguese.

3. Filtering
   - Remove tracks already present in top, recent, or selected playlist history.
   - Avoid duplicates and cap artists to keep the batch varied.
   - Penalize high-popularity tracks so the list leans less obvious.

4. Ranking
   - Score each candidate on similarity to the user's taste profile.
   - Add novelty weight based on popularity and release-era fit.
   - Add context fit using mood, time of day, energy level, decade preference, and familiarity slider.
   - Keep the final playlist balanced between relevance and discovery.

## Notes

- The app uses a simple server-managed Spotify authorization flow and stores the Spotify session in secure HTTP-only cookies.
- Audio-feature requests are used when available and fall back gracefully if Spotify does not return the feature batch.
- Language selection is heuristic rather than strict because Spotify does not expose a reliable per-track language field across the catalog.
- The machine used to author this code did not have `node` or `npm` available on PATH, so the app structure and code were completed but not executed locally here.
