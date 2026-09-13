import { searchPlacesForQuery } from '@/lib/place-search';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get('query')?.trim() ?? '';
  const lat = url.searchParams.get('lat');
  const lng = url.searchParams.get('lng');
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (
    query.length > 120 ||
    ((lat !== null || lng !== null) &&
      (!lat?.trim() ||
        !lng?.trim() ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180))
  ) {
    return Response.json(
      {
        mode: 'unavailable',
        places: [],
        notice: '검색어나 위치를 확인해 주세요.',
      },
      { status: 400 },
    );
  }
  try {
    const result = await searchPlacesForQuery(query, {
      apiKey: process.env.KAKAO_REST_API_KEY,
      center:
        lat !== null && lng !== null ? { latitude, longitude } : undefined,
      signal: request.signal,
    });
    return Response.json(result, {
      status: result.mode === 'unavailable' ? 503 : 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json({ mode: 'unavailable', places: [] }, { status: 408 });
  }
}
