import { NextResponse } from 'next/server';

type NormalizedBus = {
  id: string;
  route: string;
  etaMinutes: number;
  stopsAway: number;
  lowFloor: boolean;
  congestion: '여유' | '보통' | '혼잡' | '정보 없음';
};

function createDemoBuses(route: string): NormalizedBus[] {
  return [
    {
      id: route + '-general-1',
      route,
      etaMinutes: 5,
      stopsAway: 2,
      lowFloor: false,
      congestion: '보통',
    },
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

function toList(value: unknown): Record<string, unknown>[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value as Record<string, unknown>];
}

function toText(value: unknown) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : '';
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const requestedRoute = requestUrl.searchParams.has('route')
    ? (requestUrl.searchParams.get('route') ?? '')
    : '271';
  const requestedNode = requestUrl.searchParams.get('nodeId') || '';
  const apiKey = process.env.TAGO_BUS_API_KEY;
  const cityCode =
    requestUrl.searchParams.get('cityCode') || process.env.TAGO_CITY_CODE;
  const configuredNode = requestedNode || process.env.TAGO_NODE_ID;

  if (
    !apiKey ||
    !cityCode ||
    !configuredNode ||
    configuredNode.startsWith('demo-')
  ) {
    return NextResponse.json({
      mode: 'demo',
      refreshedAt: new Date().toISOString(),
      buses: createDemoBuses(requestedRoute || '271'),
    });
  }

  try {
    const apiUrl = new URL(
      'https://apis.data.go.kr/1613000/ArvlInfoInqireService/getSttnAcctoArvlPrearngeInfoList',
    );
    apiUrl.searchParams.set('serviceKey', apiKey);
    apiUrl.searchParams.set('cityCode', cityCode);
    apiUrl.searchParams.set('nodeId', configuredNode);
    apiUrl.searchParams.set('_type', 'json');
    apiUrl.searchParams.set('numOfRows', '30');
    apiUrl.searchParams.set('pageNo', '1');

    const response = await fetch(apiUrl, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('TAGO request failed');
    const payload = (await response.json()) as {
      response?: {
        body?: {
          items?: { item?: unknown };
        };
      };
    };
    const items = toList(payload.response?.body?.items?.item);
    const buses = items
      .map((item, index): NormalizedBus | null => {
        const route = toText(item.routeno);
        if (requestedRoute && route !== requestedRoute) return null;
        const etaSeconds = Number(item.arrtime);
        if (!Number.isFinite(etaSeconds) || etaSeconds < 0) return null;
        return {
          id: (toText(item.routeid) || route) + '-' + index,
          route,
          etaMinutes: Math.max(1, Math.ceil(etaSeconds / 60)),
          stopsAway: Math.max(0, Number(item.arrprevstationcnt) || 0),
          lowFloor: toText(item.vehicletp).includes('저상'),
          congestion: '정보 없음',
        };
      })
      .filter((bus): bus is NormalizedBus => bus !== null);

    if (buses.length === 0) {
      throw new Error('No matching bus data');
    }

    return NextResponse.json({
      mode: 'live',
      refreshedAt: new Date().toISOString(),
      buses,
    });
  } catch {
    return NextResponse.json({
      mode: 'demo',
      refreshedAt: new Date().toISOString(),
      notice: '실시간 데이터를 불러오지 못해 시연 데이터로 전환했습니다.',
      buses: createDemoBuses(requestedRoute || '271'),
    });
  }
}
