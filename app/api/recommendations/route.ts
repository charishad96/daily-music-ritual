import { NextResponse } from "next/server";
import { generateDailyRecommendations } from "@/lib/recommendations";
import { getCurrentUserPlaylists, getCurrentUserProfile } from "@/lib/spotify";
import { getValidSpotifyAccessToken } from "@/lib/spotify-auth";
import type { ContextInput } from "@/types";

export async function GET() {
  const accessToken = await getValidSpotifyAccessToken();

  if (!accessToken) {
    return NextResponse.json({
      authenticated: false
    });
  }

  try {
    const [profile, playlists] = await Promise.all([getCurrentUserProfile(), getCurrentUserPlaylists()]);

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
  } catch {
    return NextResponse.json({
      authenticated: false
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
