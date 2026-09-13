import { demoPlaces, type Place } from './trip-planning.ts';
import { placeSearchQueries } from './voice-route.ts';

export type PlaceSearchResult = {
  mode: 'demo' | 'live' | 'unavailable';
  places: Place[];
  reason?: 'not_configured' | 'service_error';
};

const text = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';

export function normalizeSearchPlace(
  document: Record<string, unknown>,
  address = false,
): Place | null {
  const latitude = Number(document.y);
  const longitude = Number(document.x);
  if (
    !text(document.y) ||
    !text(document.x) ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    return null;
  const name = text(address ? document.address_name : document.place_name);
  const id = address
    ? `address:${longitude}:${latitude}:${name}`
    : `kakao:${text(document.id)}`;
  if (!name || (!address && !text(document.id))) return null;
  return {
    id,
    name,
    latitude,
    longitude,
    address: text(document.road_address_name) || text(document.address_name),
  };
}

export async function searchPlacesForQuery(
  query: string,
  options: {
    apiKey?: string;
    center?: { latitude: number; longitude: number };
    fetcher?: typeof fetch;
    signal?: AbortSignal;
  } = {},
): Promise<PlaceSearchResult> {
  const queries = placeSearchQueries(query);
  if (!options.apiKey) {
    const compact = queries.at(-1)?.toLowerCase() ?? '';
    return {
      mode: 'demo',
      reason: 'not_configured',
      places: compact
        ? demoPlaces.filter((place) =>
            `${place.name} ${place.address}`
              .replace(/\s/g, '')
              .toLowerCase()
              .includes(compact),
          )
        : [],
    };
  }
  if (!queries.length) return { mode: 'live', places: [] };
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(9_000)])
    : AbortSignal.timeout(9_000);
  const lookup = async (search: string, address: boolean) => {
    const url = new URL(
      `https://dapi.kakao.com/v2/local/search/${address ? 'address' : 'keyword'}.json`,
    );
    url.searchParams.set('query', search);
    url.searchParams.set('size', '15');
    if (!address && options.center) {
      url.searchParams.set('x', String(options.center.longitude));
      url.searchParams.set('y', String(options.center.latitude));
      url.searchParams.set('sort', 'accuracy');
    }
    const response = await (options.fetcher ?? fetch)(url, {
      headers: {
        Authorization: `KakaoAK ${options.apiKey}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
      signal,
    });
    if (!response.ok) throw new Error('place service unavailable');
    const body = await response.json();
    if (!Array.isArray(body.documents))
      throw new Error('invalid place response');
    return body.documents
      .filter(
        (item: unknown) =>
          item && typeof item === 'object' && !Array.isArray(item),
      )
      .map((item: Record<string, unknown>) =>
        normalizeSearchPlace(item, address),
      )
      .filter((place: Place | null): place is Place => place !== null)
      .filter(
        (place: Place, index: number, all: Place[]) =>
          all.findIndex((candidate) => candidate.id === place.id) === index,
      ) as Place[];
  };
  try {
    for (const search of queries) {
      const places = await lookup(search, false);
      if (places.length) return { mode: 'live', places };
    }
    return { mode: 'live', places: await lookup(queries[0], true) };
  } catch {
    if (options.signal?.aborted) throw new Error('request cancelled');
    return { mode: 'unavailable', reason: 'service_error', places: [] };
  }
}
