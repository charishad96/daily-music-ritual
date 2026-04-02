import { NextResponse } from "next/server";
import { generateDailyRecommendations } from "@/lib/recommendations";
import { SpotifyApiError } from "@/lib/spotify";
import { getCurrentUserPlaylists, getCurrentUserProfile } from "@/lib/spotify";
import { getValidSpotifyAccessToken } from "@/lib/spotify-auth";
import type { ContextInput } from "@/types";

async function fallbackOnSpotifyReadError<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SpotifyApiError && (error.status === 401 || error.status === 403)) {
      return fallback;
    }

    throw error;
  }
}

export async function GET() {
  try {
    const accessToken = await getValidSpotifyAccessToken();

    if (!accessToken) {
      return NextResponse.json({
        authenticated: false,
        debug: "missing_access_token"
      });
    }

    const profile = await fallbackOnSpotifyReadError(() => getCurrentUserProfile(), null);
    const playlists = await fallbackOnSpotifyReadError(() => getCurrentUserPlaylists(), []);

    return NextResponse.json({
      authenticated: true,
      profile,
      playlists: playlists.map((playlist) => ({
        id: playlist.id,
        name: playlist.name,
        description: playlist.description,
        images: playlist.images,
        tracksTotal: playlist.tracks.total
      }))
    });
  } catch (error) {
    return NextResponse.json({
      authenticated: false,
      debug: error instanceof Error ? error.message : "unknown_error"
    });
  }
}

export async function POST(request: Request) {
  const accessToken = await getValidSpotifyAccessToken();

  if (!accessToken) {
    return NextResponse.json(
      {
        error: "Spotify authentication required."
      },
      {
        status: 401
      }
    );
  }

  try {
    const context = (await request.json()) as ContextInput;
    const data = await generateDailyRecommendations(context);
    return NextResponse.json(data);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Recommendation generation failed."
      },
      {
        status: 500
      }
    );
  }
}

