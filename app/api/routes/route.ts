import {
  createDemoTrip,
  demoPlaces,
  type Place,
  type TripPlan,
} from '../../../lib/trip-planning.ts';
import { createTagoClient, type TagoClient } from '../../../lib/tago-client.ts';
import {
  findTagoRouteMatch,
  normalizeStopName,
} from '../../../lib/tago-route-match.ts';

export const maxDuration = 30;

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

function toText(value: unknown) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';
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

function stepPoint(step: KakaoStep, index: number): [number, number] | null {
  const points = step.path?.points;
  if (!Array.isArray(points)) return null;
  const point = points.at(index);
  if (
    !Array.isArray(point) ||
    point.length < 2 ||
    point.some((value) => value === null || value === '')
  )
    return null;
  const longitude = Number(point[0]);
  const latitude = Number(point[1]);
  return isWgs84(latitude, longitude) ? [longitude, latitude] : null;
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
  tago: TagoClient | null,
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
  const boardingPoint = stepPoint(selected.busStep, 0);
  const alightingPoint = stepPoint(selected.busStep, -1);
  const tagoMatch =
    tago && boardingPoint && alightingPoint
      ? await findTagoRouteMatch(tago, {
          route: busRouteName,
          stopNames: stops.map((stop) => toText(stop.name)),
          boardingPoint,
          alightingPoint,
        })
      : null;

  return {
    id: `kakao:${busRouteName}:${boardingStopName}:${alightingStopName}:${tagoMatch?.boardingStop.id ?? ''}`,
    route: busRouteName,
    routeId: tagoMatch?.routeId,
    direction: `${alightingStopName} 방향`,
    nextStopName: tagoMatch?.nextStopName,
    totalMinutes: Math.max(1, Math.ceil(selected.totalTime / 60)),
    walkToStopMinutes:
      walkToStopSeconds > 0 ? Math.ceil(walkToStopSeconds / 60) : 0,
    transfers: selected.transfers,
    boardingStop: tagoMatch?.boardingStop ?? {
      id: createKakaoFallbackStopId(boardingStopName, boardingPoint),
      name: boardingStopName,
      ...(boardingPoint
        ? { longitude: boardingPoint[0], latitude: boardingPoint[1] }
        : {}),
    },
    alightingStop: { name: alightingStopName },
    landingUrl:
      toText(payload.properties?.landingURL) ||
      toText(payload.properties?.landingUrl) ||
      undefined,
    arrivalLookupAvailable: Boolean(tagoMatch),
  };
}

function demoResponse(origin: Place | null, destination: Place | null) {
  const fallbackOrigin = origin ?? demoPlaces[0];
  const fallbackDestination = destination ?? demoPlaces[1];
  return Response.json({
    mode: 'demo',
    trip: createDemoTrip(fallbackOrigin, fallbackDestination),
  });
}

function unavailableResponse(notice: string) {
  return Response.json({
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
    return Response.json(
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
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(7_000)]),
    });
    if (!response.ok) throw new Error('Kakao public transit request failed');

    const payload = (await response.json()) as KakaoTransitResponse;
    const tago = process.env.TAGO_BUS_API_KEY
      ? createTagoClient({
          apiKey: process.env.TAGO_BUS_API_KEY,
          signal: AbortSignal.any([
            request.signal,
            AbortSignal.timeout(15_000),
          ]),
        })
      : null;
    const trips = (
      await Promise.all(
        [0, 1, 2].map((index) => normalizeDirectBusTrip(payload, tago, index)),
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

    return Response.json({
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
