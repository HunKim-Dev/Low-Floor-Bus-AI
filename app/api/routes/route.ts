import { NextResponse } from 'next/server';

import {
  createDemoTrip,
  demoPlaces,
  type Place,
  type TripPlan,
  type TripStop,
} from '@/lib/trip-planning';

type KakaoStop = { name?: unknown };
type KakaoVehicle = { name?: unknown; type?: unknown };
type KakaoStep = {
  properties?: {
    guidance?: unknown;
    type?: unknown;
    time?: unknown;
    stops?: KakaoStop[];
    vehicles?: KakaoVehicle[];
  };
  path?: { points?: unknown };
};
type KakaoRoute = {
  properties?: {
    type?: unknown;
    totalTime?: unknown;
    transfers?: unknown;
  };
  steps?: KakaoStep[];
};
type KakaoTransitResponse = {
  status?: unknown;
  properties?: { landingURL?: unknown; landingUrl?: unknown };
  routes?: KakaoRoute[];
};

type TagoStop = {
  id: string;
  name: string;
  cityCode: string;
  latitude: number;
  longitude: number;
};

function toText(value: unknown) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';
}

function toList(value: unknown): Record<string, unknown>[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value as Record<string, unknown>];
}

function firstNumber(searchParams: URLSearchParams, names: string[]) {
  for (const name of names) {
    const value = searchParams.get(name);
    if (value === null || value.trim() === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function firstText(searchParams: URLSearchParams, names: string[]) {
  for (const name of names) {
    const value = searchParams.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

function isWgs84(latitude: number | undefined, longitude: number | undefined) {
  return (
    latitude !== undefined &&
    longitude !== undefined &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

function placeFromRequest(
  searchParams: URLSearchParams,
  type: 'origin' | 'destination',
): Place | null {
  const isOrigin = type === 'origin';
  const latitude = firstNumber(
    searchParams,
    isOrigin
      ? ['originLat', 'startLat', 'startY', 'sy']
      : ['destinationLat', 'endLat', 'endY', 'ey'],
  );
  const longitude = firstNumber(
    searchParams,
    isOrigin
      ? ['originLng', 'startLng', 'startX', 'sx']
      : ['destinationLng', 'endLng', 'endX', 'ex'],
  );
  if (!isWgs84(latitude, longitude)) return null;

  const fallbackName = isOrigin ? '출발지' : '도착지';
  const name =
    firstText(
      searchParams,
      isOrigin
        ? ['originName', 'startName', 'sName']
        : ['destinationName', 'endName', 'eName'],
    ) ?? fallbackName;
  const id =
    firstText(
      searchParams,
      isOrigin ? ['originId', 'startId'] : ['destinationId', 'endId'],
    ) ?? `${type}:${latitude}:${longitude}`;

  return {
    id,
    name,
    address: '',
    latitude: latitude as number,
    longitude: longitude as number,
  };
}

function normalizeStopName(name: string) {
  return name.normalize('NFKC').replace(/[\s.,·()[\]{}\-_/]/g, '');
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

function firstPoint(step: KakaoStep): [number, number] | null {
  const points = step.path?.points;
  if (!Array.isArray(points) || !Array.isArray(points[0])) return null;
  const longitude = Number(points[0][0]);
  const latitude = Number(points[0][1]);
  return isWgs84(latitude, longitude) ? [longitude, latitude] : null;
}

async function findTagoBoardingStop(
  stopName: string,
  point: [number, number] | null,
): Promise<TripStop | null> {
  const apiKey = process.env.TAGO_BUS_API_KEY;
  if (!apiKey || !point) return null;

  try {
    const [longitude, latitude] = point;
    const apiUrl = new URL(
      'https://apis.data.go.kr/1613000/BusSttnInfoInqireService/getCrdntPrxmtSttnList',
    );
    apiUrl.searchParams.set('serviceKey', apiKey);
    apiUrl.searchParams.set('gpsLati', String(latitude));
    apiUrl.searchParams.set('gpsLong', String(longitude));
    apiUrl.searchParams.set('_type', 'json');
    apiUrl.searchParams.set('numOfRows', '20');
    apiUrl.searchParams.set('pageNo', '1');

    const response = await fetch(apiUrl, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(7_000),
    });
    if (!response.ok) return null;

    const payload = (await response.json()) as {
      response?: { body?: { items?: { item?: unknown } } };
    };
    const normalizedTarget = normalizeStopName(stopName);
    const candidates = toList(payload.response?.body?.items?.item)
      .map((item): TagoStop | null => {
        const id = toText(item.nodeid);
        const name = toText(item.nodenm);
        const cityCode = toText(item.citycode);
        const stopLatitude = Number(item.gpslati);
        const stopLongitude = Number(item.gpslong);
        if (
          !id ||
          !name ||
          !cityCode ||
          !Number.isFinite(stopLatitude) ||
          !Number.isFinite(stopLongitude) ||
          normalizeStopName(name) !== normalizedTarget
        ) {
          return null;
        }
        return {
          id,
          name,
          cityCode,
          latitude: stopLatitude,
          longitude: stopLongitude,
        };
      })
      .filter((stop): stop is TagoStop => stop !== null)
      .map((stop) => ({
        stop,
        distance: distanceInMeters(
          latitude,
          longitude,
          stop.latitude,
          stop.longitude,
        ),
      }))
      .sort((first, second) => first.distance - second.distance);

    const best = candidates[0];
    const runnerUp = candidates[1];
    const isCloseEnough = best && best.distance <= 120;
    const isUnambiguous = !runnerUp || runnerUp.distance > 120;
    if (!best || !isCloseEnough || !isUnambiguous) return null;

    return {
      id: best.stop.id,
      name: stopName,
      cityCode: best.stop.cityCode,
    };
  } catch {
    return null;
  }
}

function routeName(step: KakaoStep) {
  const vehicleName = toText(step.properties?.vehicles?.[0]?.name);
  if (vehicleName) return vehicleName;

  const guidance = toText(step.properties?.guidance);
  return guidance.match(/^\S+\s+([^()]+)/)?.[1]?.trim() ?? '';
}

function createKakaoFallbackStopId(
  name: string,
  point: [number, number] | null,
) {
  const location = point ? `${point[1].toFixed(6)}:${point[0].toFixed(6)}` : '';
  return `kakao:${normalizeStopName(name)}:${location}`;
}

async function normalizeDirectBusTrip(
  payload: KakaoTransitResponse,
  routeIndex = 0,
): Promise<TripPlan | null> {
  if (toText(payload.status) !== 'OK') return null;

  const directRoutes = (payload.routes ?? [])
    .map((route) => {
      const steps = route.steps ?? [];
      const busSteps = steps.filter(
        (step) => toText(step.properties?.type) === 'BUS',
      );
      const totalTime = Number(route.properties?.totalTime);
      const transfers = Number(route.properties?.transfers);
      const isDirectBus =
        toText(route.properties?.type) === 'BUS' &&
        transfers === 0 &&
        busSteps.length === 1;
      if (!isDirectBus || !Number.isFinite(totalTime) || totalTime <= 0) {
        return null;
      }
      return { route, steps, busStep: busSteps[0], totalTime, transfers };
    })
    .filter((route): route is NonNullable<typeof route> => route !== null)
    .sort((first, second) => first.totalTime - second.totalTime);

  const selected = directRoutes[routeIndex];
  if (!selected) return null;

  const stops = selected.busStep.properties?.stops ?? [];
  const boardingStopName = toText(stops[0]?.name);
  const alightingStopName = toText(stops.at(-1)?.name);
  const busRouteName = routeName(selected.busStep);
  if (!boardingStopName || !alightingStopName || !busRouteName) return null;

  const busStepIndex = selected.steps.indexOf(selected.busStep);
  const walkToStopSeconds = selected.steps
    .slice(0, busStepIndex)
    .filter((step) => toText(step.properties?.type) === 'WALKING')
    .reduce((total, step) => total + Number(step.properties?.time || 0), 0);
  const boardingPoint = firstPoint(selected.busStep);
  const tagoStop = await findTagoBoardingStop(boardingStopName, boardingPoint);

  return {
    id: `kakao:${busRouteName}:${boardingStopName}:${alightingStopName}`,
    route: busRouteName,
    direction: `${alightingStopName} 방향`,
    totalMinutes: Math.max(1, Math.ceil(selected.totalTime / 60)),
    walkToStopMinutes:
      walkToStopSeconds > 0 ? Math.ceil(walkToStopSeconds / 60) : 0,
    transfers: selected.transfers,
    boardingStop: tagoStop ?? {
      id: createKakaoFallbackStopId(boardingStopName, boardingPoint),
      name: boardingStopName,
    },
    alightingStop: { name: alightingStopName },
    landingUrl:
      toText(payload.properties?.landingURL) ||
      toText(payload.properties?.landingUrl) ||
      undefined,
    arrivalLookupAvailable: Boolean(tagoStop),
  };
}

function demoResponse(origin: Place | null, destination: Place | null) {
  const fallbackOrigin = origin ?? demoPlaces[0];
  const fallbackDestination = destination ?? demoPlaces[1];
  return NextResponse.json({
    mode: 'demo',
    trip: createDemoTrip(fallbackOrigin, fallbackDestination),
  });
}

function unavailableResponse(notice: string) {
  return NextResponse.json({
    mode: 'unavailable',
    trip: null,
    notice,
  });
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const origin = placeFromRequest(requestUrl.searchParams, 'origin');
  const destination = placeFromRequest(requestUrl.searchParams, 'destination');
  const apiKey = process.env.KAKAO_REST_API_KEY;

  if (!origin || !destination) {
    return NextResponse.json(
      {
        mode: 'unavailable',
        trip: null,
        notice: '출발지와 도착지를 확인해 주세요.',
      },
      { status: 400 },
    );
  }

  if (
    origin.latitude === destination.latitude &&
    origin.longitude === destination.longitude
  ) {
    return unavailableResponse(
      '출발지와 도착지가 같아요. 다른 도착지를 골라 주세요.',
    );
  }

  if (!apiKey) {
    const demoOrigin = demoPlaces[0];
    const supportedDemo =
      requestUrl.searchParams.get('demo') === '1' &&
      origin.latitude === demoOrigin.latitude &&
      origin.longitude === demoOrigin.longitude &&
      demoPlaces.some(
        (place) =>
          place.latitude === destination.latitude &&
          place.longitude === destination.longitude,
      );
    return supportedDemo
      ? demoResponse(origin, destination)
      : unavailableResponse(
          '실제 경로 조회가 아직 연결되지 않았어요. 현재 위치로 이동 안내를 제공할 수 없어요.',
        );
  }

  try {
    const apiUrl = new URL('https://dapi.kakao.com/v2/routing/publictraffic');
    apiUrl.searchParams.set('start_x', String(origin.longitude));
    apiUrl.searchParams.set('start_y', String(origin.latitude));
    apiUrl.searchParams.set('s_name', origin.name);
    apiUrl.searchParams.set('end_x', String(destination.longitude));
    apiUrl.searchParams.set('end_y', String(destination.latitude));
    apiUrl.searchParams.set('e_name', destination.name);
    apiUrl.searchParams.set('input_coord', 'WGS84');
    apiUrl.searchParams.set('output_coord', 'WGS84');

    const response = await fetch(apiUrl, {
      headers: {
        Accept: 'application/json',
        Authorization: `KakaoAK ${apiKey}`,
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(7_000),
    });
    if (!response.ok) throw new Error('Kakao public transit request failed');

    const payload = (await response.json()) as KakaoTransitResponse;
    const trips = (
      await Promise.all(
        [0, 1, 2].map((index) => normalizeDirectBusTrip(payload, index)),
      )
    )
      .filter((trip): trip is TripPlan => trip !== null)
      .filter(
        (trip, index, all) =>
          all.findIndex((candidate) => candidate.id === trip.id) === index,
      );
    const trip =
      trips.find((candidate) => candidate.arrivalLookupAvailable) ?? trips[0];
    if (!trip) {
      return unavailableResponse(
        '이 구간에는 환승 없는 버스 경로가 없어요. 현재 버전은 직행 버스부터 안내해요.',
      );
    }

    return NextResponse.json({
      mode: 'live',
      trip,
      alternatives: trips.filter((candidate) => candidate.id !== trip.id),
    });
  } catch {
    return unavailableResponse(
      '경로 정보를 불러오지 못했어요. 잠시 후 다시 확인해 주세요.',
    );
  }
}
