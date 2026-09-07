import { NextResponse } from 'next/server';

type StopSummary = {
  id: string;
  name: string;
  direction: string;
  route: string;
};

type AssistantRequest = {
  message?: string;
  currentStop?: StopSummary;
  availableStops?: StopSummary[];
  settings?: {
    preparationMinutes?: number;
    travelMinutes?: number;
    safetyMinutes?: number;
  };
};

function extractMinutes(message: string, keyword: string) {
  const expression = new RegExp(
    keyword + '(?:은|는|이|가|을|를)?\\s*(?:약\\s*)?(\\d{1,2})\\s*분',
  );
  const reversedExpression = new RegExp(
    '(\\d{1,2})\\s*분(?:으로|쯤)?\\s*' + keyword,
  );
  const match = message.match(expression) ?? message.match(reversedExpression);
  if (!match) return null;
  const minutes = Number(match[1]);
  return Number.isInteger(minutes) ? minutes : null;
}

export async function POST(request: Request) {
  let payload: AssistantRequest;
  try {
    payload = (await request.json()) as AssistantRequest;
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
  const matchedStop = stops.find(
    (stop) =>
      message.includes(stop.name) || message.includes(stop.route + '번'),
  );
  const travelMinutes = extractMinutes(message, '이동(?:시간)?');
  const preparationMinutes = extractMinutes(message, '준비(?:시간)?');
  const safetyMinutes = extractMinutes(message, '(?:안전|여유)(?:시간)?');
  const changes: Record<string, string | number> = {};

  if (matchedStop) changes.stopId = matchedStop.id;
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
  if (matchedStop) understood.push(matchedStop.name + ' 정류장');
  if (travelMinutes !== null) understood.push('이동 ' + travelMinutes + '분');
  if (preparationMinutes !== null)
    understood.push('준비 ' + preparationMinutes + '분');
  if (safetyMinutes !== null)
    understood.push('안전 여유 ' + safetyMinutes + '분');

  const needsClarification =
    /어디|근처|가까운/.test(message) && !matchedStop && stops.length > 1;
  const responseText = needsClarification
    ? '어느 정류장을 이용할지 한 번만 더 알려주세요. 정류장 이름이나 버스 번호로 말할 수 있어요.'
    : understood.length > 0
      ? understood.join(', ') +
        ' 조건을 반영해 탑승 가능한 저상버스를 다시 계산할게요.'
      : (targetStop?.name ?? '현재 정류장') +
        '의 저상버스 도착정보와 내 이동시간을 대조해 가장 안전한 출발 시각을 안내할게요.';

  return NextResponse.json({
    mode: 'local-agent',
    intent: needsClarification ? 'clarify_stop' : 'recommend_accessible_bus',
    changes,
    responseText,
    needsClarification,
    trace: [
      {
        label: '요청 이해',
        detail:
          understood.length > 0
            ? understood.join(' · ')
            : '저상버스 도착·출발 추천',
        status: needsClarification ? 'attention' : 'complete',
      },
      {
        label: '정보 조회',
        detail: (targetStop?.name ?? '현재 정류장') + ' 저상버스 도착정보 사용',
        status: needsClarification ? 'waiting' : 'complete',
      },
      {
        label: '안전 계산',
        detail: '준비 + 이동 + 여유시간을 코드로 검증',
        status: needsClarification ? 'waiting' : 'complete',
      },
      {
        label: '맞춤 안내',
        detail: needsClarification
          ? '정류장 확인 후 생성'
          : '출발 시각과 제외 이유 설명',
        status: needsClarification ? 'waiting' : 'complete',
      },
    ],
  });
}
