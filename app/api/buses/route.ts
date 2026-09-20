import {
  createTagoClient,
  tagoText as toText,
} from '../../../lib/tago-client.ts';

type NormalizedBus = {
  id: string;
  route: string;
  etaMinutes: number;
  etaSeconds?: number;
  stopsAway: number;
  lowFloor: true;
  congestion: '여유' | '보통' | '혼잡' | '정보 없음';
};

function createDemoBuses(route: string): NormalizedBus[] {
  return [
    {
      id: route + '-low-1',
      route,
      etaMinutes: 8,
      stopsAway: 3,
      lowFloor: true,
      congestion: '여유',
    },
    {
      id: route + '-low-2',
      route,
      etaMinutes: 18,
      stopsAway: 4,
      lowFloor: true,
      congestion: '여유',
    },
    {
      id: route + '-low-3',
      route,
      etaMinutes: 30,
      stopsAway: 8,
      lowFloor: true,
      congestion: '정보 없음',
    },
  ];
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const requestedRoute = requestUrl.searchParams.has('route')
    ? (requestUrl.searchParams.get('route') ?? '')
    : '271';
  const requestedNode = requestUrl.searchParams.get('nodeId') || '';
  const requestedRouteId = requestUrl.searchParams.get('routeId')?.trim() || '';
  const demoRequested = requestUrl.searchParams.get('demo') === '1';
  const apiKey = process.env.TAGO_BUS_API_KEY;
  const cityCode =
    requestUrl.searchParams.get('cityCode') || process.env.TAGO_CITY_CODE;
  const configuredNode = requestedNode || process.env.TAGO_NODE_ID;

  if (demoRequested || configuredNode?.startsWith('demo-')) {
    return Response.json({
      mode: 'demo',
      refreshedAt: new Date().toISOString(),
      buses: createDemoBuses(requestedRoute || '271'),
    });
  }

  if (
    !apiKey ||
    !cityCode ||
    !configuredNode ||
    configuredNode.startsWith('kakao:')
  ) {
    return Response.json({
      mode: 'unavailable',
      refreshedAt: new Date().toISOString(),
      notice: '실시간 저상버스 도착정보를 확인할 수 없습니다.',
      buses: [],
    });
  }

  try {
    const tago = createTagoClient({
      apiKey,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(7_000)]),
    });
    const items = await tago.list('arrivals', {
      cityCode,
      nodeId: configuredNode,
    });
    const buses = items
      .map((item, index): NormalizedBus | null => {
        // TAGO has no vehicle-type request filter. Only return confirmed low-floor
        // vehicles; substring matching would also accept labels such as '비저상버스'.
        if (toText(item.vehicletp).replace(/\s+/g, '') !== '저상버스')
          return null;
        const route = toText(item.routeno);
        if (requestedRoute && route !== requestedRoute) return null;
        if (requestedRouteId && toText(item.routeid) !== requestedRouteId)
          return null;
        if (toText(item.nodeid) && toText(item.nodeid) !== configuredNode)
          return null;
        if (!toText(item.arrtime)) return null;
        const etaSeconds = Number(item.arrtime);
        if (!Number.isFinite(etaSeconds) || etaSeconds < 0) return null;
        return {
          id: (toText(item.routeid) || route) + '-' + index,
          route,
          etaMinutes: etaSeconds / 60,
          etaSeconds,
          stopsAway: Math.max(0, Number(item.arrprevstationcnt) || 0),
          lowFloor: true,
          congestion: '정보 없음',
        };
      })
      .filter((bus): bus is NormalizedBus => bus !== null);

    if (buses.length === 0)
      return Response.json({
        mode: 'unavailable',
        refreshedAt: new Date().toISOString(),
        notice: '이 노선의 실시간 저상버스 도착정보가 없습니다.',
        buses: [],
      });

    return Response.json({
      mode: 'live',
      refreshedAt: new Date().toISOString(),
      buses,
    });
  } catch {
    return Response.json({
      mode: 'unavailable',
      refreshedAt: new Date().toISOString(),
      notice: '실시간 저상버스 도착정보를 불러오지 못했습니다.',
      buses: [],
    });
  }
}
