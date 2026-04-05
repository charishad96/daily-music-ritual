import { NextResponse } from "next/server";
import { generateDailyRecommendations } from "@/lib/recommendations";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const data = await generateDailyRecommendations({
      mood: "focused",
      energyLevel: "medium",
      languagePreference: "any",
      familiarity: 38,
      playlistIds: [],
      friendPlaylistInputs: [],
      excludeTrackIds: [],
      refreshKey: "debug"
    });

    return NextResponse.json({
      ok: true,
      trackCount: data.tracks.length,
      sample: data.tracks.slice(0, 3).map((track) => ({
        id: track.id,
        name: track.name,
        artists: track.artists.map((artist) => artist.name)
      }))
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "unknown_error"
      },
      {
        status: 500
      }
    );
  }
}
