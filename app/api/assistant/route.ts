import { NextResponse } from 'next/server';
import { extractMinutes } from '@/lib/voice-numbers';

type StopSummary = {
  id: string;
  name: string;
  direction: string;
  route: string;
};

type PlaceSummary = {
  id: string;
  name: string;
};

type AssistantRequest = {
  message?: string;
  currentStop?: StopSummary;
  availableStops?: StopSummary[];
  currentOrigin?: PlaceSummary;
  currentDestination?: PlaceSummary | null;
  availablePlaces?: PlaceSummary[];
  spokenOriginPlaceId?: string;
  spokenDestinationPlaceId?: string;
  settings?: {
    preparationMinutes?: number;
    travelMinutes?: number;
    safetyMinutes?: number;
  };
};

function isSummary(value: unknown): value is PlaceSummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    item.id.length <= 500 &&
    typeof item.name === 'string' &&
    item.name.length > 0 &&
    item.name.length <= 200
  );
}

function validPayload(value: unknown): value is AssistantRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (typeof body.message !== 'string' || body.message.length > 300)
    return false;
  for (const key of ['availablePlaces', 'availableStops']) {
    if (
      body[key] !== undefined &&
      (!Array.isArray(body[key]) ||
        body[key].length > 50 ||
        !body[key].every(isSummary))
    )
      return false;
  }
  for (const key of ['currentOrigin', 'currentDestination', 'currentStop']) {
    if (body[key] != null && !isSummary(body[key])) return false;
  }
  if (
    Array.isArray(body.availableStops) &&
    !body.availableStops.every(
      (stop) =>
        typeof stop.route === 'string' && typeof stop.direction === 'string',
    )
  )
    return false;
  return true;
}

function escapeExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function POST(request: Request) {
  let payload: AssistantRequest;
  try {
    const text = await request.text();
    if (text.length > 30_000) throw new Error('request too large');
    const body: unknown = JSON.parse(text);
    if (!validPayload(body)) throw new Error('invalid request');
    payload = body;
  } catch {
    return NextResponse.json(
      { error: '요청 형식을 확인해 주세요.' },
      { status: 400 },
    );
  }

  const message = payload.message?.trim().slice(0, 300) ?? '';
  if (!message) {
    return NextResponse.json(
      { error: '질문을 입력해 주세요.' },
      { status: 400 },
    );
  }

  const stops = payload.availableStops ?? [];
  const places = payload.availablePlaces ?? [];
  const matchedStop = stops.find(
    (stop) =>
      message.includes(stop.name) || message.includes(stop.route + '번'),
  );
  const travelMinutes = extractMinutes(
    message,
    '(?:이동|정류장까지)(?:\\s*시간)?',
  );
  const preparationMinutes = extractMinutes(message, '준비(?:\\s*시간)?');
  const safetyMinutes = extractMinutes(message, '(?:안전|여유)(?:\\s*시간)?');
  const invalidTime = [
    [preparationMinutes, 0, 30, '준비 시간은 0~30분'],
    [travelMinutes, 1, 60, '이동 시간은 1~60분'],
    [safetyMinutes, 1, 15, '여유 시간은 1~15분'],
  ].find(
    ([value, min, max]) =>
      typeof value === 'number' && (value < Number(min) || value > Number(max)),
  );
  if (invalidTime)
    return NextResponse.json({
      mode: 'local-agent',
      intent: 'recommend_accessible_bus',
      changes: {},
      needsClarification: true,
      trace: [],
      responseText: `${invalidTime[3]}으로 정할 수 있어요. 시간을 다시 알려주세요.`,
    });
  const changes: Record<string, string | number> = {};

  const matchedOrigin =
    places.find((place) => place.id === payload.spokenOriginPlaceId) ??
    places.find(
      (place) =>
        new RegExp(
          '(?:출발(?:지)?(?:는|은|이|가|:)?\\s*)' +
            escapeExpression(place.name),
        ).test(message) ||
        new RegExp(
          escapeExpression(place.name) + '\\s*(?:에서|부터|출발)',
        ).test(message),
    );
  const matchedDestination =
    places.find((place) => place.id === payload.spokenDestinationPlaceId) ??
    places.find(
      (place) =>
        place.id !== matchedOrigin?.id &&
        (new RegExp(
          '(?:(?:도착(?:지)?|목적지)(?:는|은|이|가|:)?\\s*)' +
            escapeExpression(place.name),
        ).test(message) ||
          new RegExp(
            escapeExpression(place.name) +
              '\\s*(?:까지|으로|로|에)?\\s*(?:가|갈|도착)',
          ).test(message)),
    ) ??
    places.find(
      (place) => place.id !== matchedOrigin?.id && message.includes(place.name),
    );

  if (matchedStop) changes.stopId = matchedStop.id;
  if (matchedOrigin) changes.originPlaceId = matchedOrigin.id;
  if (matchedDestination) changes.destinationPlaceId = matchedDestination.id;
  if (travelMinutes !== null && travelMinutes >= 1 && travelMinutes <= 60) {
    changes.travelMinutes = travelMinutes;
  }
  if (
    preparationMinutes !== null &&
    preparationMinutes >= 0 &&
    preparationMinutes <= 30
  ) {
    changes.preparationMinutes = preparationMinutes;
  }
  if (safetyMinutes !== null && safetyMinutes >= 1 && safetyMinutes <= 15) {
    changes.safetyMinutes = safetyMinutes;
  }

  const targetStop = matchedStop ?? payload.currentStop;
  const understood: string[] = [];
  if (matchedOrigin) understood.push('출발 ' + matchedOrigin.name);
  if (matchedDestination) understood.push('도착 ' + matchedDestination.name);
  if (matchedStop) understood.push(matchedStop.name + ' 정류장');
  if (travelMinutes !== null) understood.push('이동 ' + travelMinutes + '분');
  if (preparationMinutes !== null)
    understood.push('준비 ' + preparationMinutes + '분');
  if (safetyMinutes !== null)
    understood.push('안전 여유 ' + safetyMinutes + '분');

  const asksForDestination = /가고|갈래|갈게|목적지|도착|까지/.test(message);
  const needsDestinationClarification =
    asksForDestination && !matchedDestination && places.length > 1;
  const needsStopClarification =
    /어디|근처|가까운/.test(message) &&
    !asksForDestination &&
    !matchedStop &&
    stops.length > 1;
  const needsClarification =
    needsDestinationClarification || needsStopClarification;
  let confirmation = '';
  if (matchedOrigin && matchedDestination) {
    confirmation = `${matchedOrigin.name}에서 ${matchedDestination.name}까지 가는 걸로 들었어요. `;
  } else if (matchedDestination) {
    confirmation = `${matchedDestination.name}까지 가는 걸로 들었어요. `;
  } else if (matchedOrigin) {
    confirmation = `${matchedOrigin.name}에서 출발하는 걸로 들었어요. `;
  }

  const timeChanges = [
    travelMinutes !== null ? `이동 ${travelMinutes}분` : '',
    preparationMinutes !== null ? `준비 ${preparationMinutes}분` : '',
    safetyMinutes !== null ? `여유 ${safetyMinutes}분` : '',
  ].filter(Boolean);
  const timeConfirmation =
    timeChanges.length > 0 ? `${timeChanges.join(', ')}으로 바꿨어요. ` : '';

  const responseText = needsClarification
    ? needsDestinationClarification
      ? '도착지 이름을 한 번만 더 알려주세요. 예를 들어 “서울역 가고 싶어”라고 말할 수 있어요.'
      : '어느 정류장을 이용할지 한 번만 더 알려주세요. 정류장 이름이나 버스 번호로 말할 수 있어요.'
    : understood.length > 0
      ? confirmation +
        timeConfirmation +
        (matchedOrigin || matchedDestination
          ? '가는 방향의 버스를 확인할게요.'
          : '출발 시간을 다시 계산할게요.')
      : (targetStop?.name ?? '현재 정류장') +
        '의 저상버스 도착정보와 내 이동시간을 대조해 가장 안전한 출발 시각을 안내할게요.';

  return NextResponse.json({
    mode: 'local-agent',
    intent: needsDestinationClarification
      ? 'clarify_destination'
      : needsStopClarification
        ? 'clarify_stop'
        : 'recommend_accessible_bus',
    changes,
    responseText,
    needsClarification,
    trace: [
      {
        label: '요청 이해',
        detail:
          understood.length > 0
            ? understood.join(' · ')
            : `${payload.currentOrigin?.name ?? '출발지'} → ${payload.currentDestination?.name ?? '도착지'} 저상버스 추천`,
        status: needsClarification ? 'attention' : 'complete',
      },
      {
        label: '정보 조회',
        detail:
          (matchedDestination?.name ??
            payload.currentDestination?.name ??
            '도착지') + ' 방향의 저상버스 도착정보 사용',
        status: 'waiting',
      },
      {
        label: '안전 계산',
        detail: '준비 + 이동 + 여유시간을 코드로 검증',
        status: 'waiting',
      },
      {
        label: '맞춤 안내',
        detail: needsClarification
          ? '정류장 확인 후 생성'
          : '출발 시각과 제외 이유 설명',
        status: 'waiting',
      },
    ],
  });
}
