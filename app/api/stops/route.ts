import { NextResponse } from 'next/server';

import { demoStops, type TransitStop } from '@/lib/demo-stops';

function toList(value: unknown): Record<string, unknown>[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value as Record<string, unknown>];
}

function toText(value: unknown) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

function distanceInMeters(
  firstLatitude: number,
  firstLongitude: number,
  secondLatitude: number,
  secondLongitude: number,
) {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const earthRadius = 6_371_000;
  const latitudeDistance = radians(secondLatitude - firstLatitude);
  const longitudeDistance = radians(secondLongitude - firstLongitude);
  const value =
    Math.sin(latitudeDistance / 2) ** 2 +
    Math.cos(radians(firstLatitude)) *
      Math.cos(radians(secondLatitude)) *
      Math.sin(longitudeDistance / 2) ** 2;
  return Math.round(
    earthRadius * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value)),
  );
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const query =
    requestUrl.searchParams.get('query')?.trim().toLowerCase() ?? '';
  const latitude = Number(requestUrl.searchParams.get('lat'));
  const longitude = Number(requestUrl.searchParams.get('lng'));
  const hasCoordinates =
    requestUrl.searchParams.has('lat') &&
    requestUrl.searchParams.has('lng') &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180;
  const apiKey = process.env.TAGO_BUS_API_KEY;

  if (apiKey && hasCoordinates) {
    try {
      const apiUrl = new URL(
        'https://apis.data.go.kr/1613000/BusSttnInfoInqireService/getCrdntPrxmtSttnList',
      );
      apiUrl.searchParams.set('serviceKey', apiKey);
      apiUrl.searchParams.set('gpsLati', String(latitude));
      apiUrl.searchParams.set('gpsLong', String(longitude));
      apiUrl.searchParams.set('_type', 'json');
      apiUrl.searchParams.set('numOfRows', '30');
      apiUrl.searchParams.set('pageNo', '1');

      const response = await fetch(apiUrl, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(7_000),
      });
      if (!response.ok) throw new Error('TAGO stop request failed');
      const payload = (await response.json()) as {
        response?: { body?: { items?: { item?: unknown } } };
      };
      const stops = toList(payload.response?.body?.items?.item)
        .map((item): TransitStop | null => {
          const name = toText(item.nodenm);
          const id = toText(item.nodeid);
          const stopLatitude = Number(item.gpslati);
          const stopLongitude = Number(item.gpslong);
          if (!name || !id) return null;
          return {
            id,
            name,
            direction: '현재 위치 주변 정류장',
            route: '',
            cityCode: toText(item.citycode),
            distanceMeters:
              Number.isFinite(stopLatitude) && Number.isFinite(stopLongitude)
                ? distanceInMeters(
                    latitude,
                    longitude,
                    stopLatitude,
                    stopLongitude,
                  )
                : undefined,
          };
        })
        .filter((stop): stop is TransitStop => stop !== null)
        .filter((stop) => !query || stop.name.toLowerCase().includes(query))
        .sort(
          (a, b) => (a.distanceMeters ?? 9999) - (b.distanceMeters ?? 9999),
        );

      if (stops.length > 0) {
        return NextResponse.json({ mode: 'live', radiusMeters: 500, stops });
      }
    } catch {
      // Fall through to a useful demo list when the public API is unavailable.
    }
  }

  const stops = demoStops.filter(
    (stop) =>
      !query ||
      stop.name.toLowerCase().includes(query) ||
      stop.route.toLowerCase().includes(query),
  );
  return hasCoordinates
    ? NextResponse.json({
        mode: 'unavailable',
        radiusMeters: 500,
        stops: [],
        notice: '현재 위치 주변 정류장을 확인하지 못했어요.',
      })
    : NextResponse.json({ mode: 'demo', radiusMeters: 500, stops });
}
