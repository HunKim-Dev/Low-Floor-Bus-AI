export function uniquePlaceMatch<T extends { name: string }>(
  query: string,
  places: T[],
): T | null {
  const normalize = (name: string) => name.replace(/\s/g, '').toLowerCase();
  const exact = places.filter(
    (place) => normalize(place.name) === normalize(query),
  );
  // Even a single partial result can be a different branch or a nearby shop.
  return exact.length === 1 ? exact[0] : null;
}

function cleanSpokenPlaceQuery(value: string) {
  const preferredAlternative =
    value.split(/\s*(?:말고|아니고)\s*/).at(-1) ?? value;
  return preferredAlternative
    .replace(/[,.!?，]/g, ' ')
    .replace(/^\s*(?:나는|저는|제가|지금(?!\s*있는\s*곳))\s+/, '')
    .replace(/^\s*출발(?:해서|하고|해)?\s*/, '')
    .replace(/^\s*(?:출발(?:지)?|도착(?:지)?|목적지)(?:는|은|이|가|:)?\s*/, '')
    .replace(
      /\s+(?:그리고\s+)?(?:준비|이동|여유)(?:\s*시간)?(?:은|는|도)?\s*\d{1,2}\s*분.*$/,
      '',
    )
    .replace(
      /\s*(?:까지|으로|로|에)?\s*(?:가고\s*싶.*|갈래.*|갈게.*|가자.*|가\s*줘.*|가려고.*|안내.*|도착.*|해\s*줘.*)$/,
      '',
    )
    .replace(
      /\s*(?:(?:이고요|이구요|이고|이야|이에요|예요|입니다|그리고)\s*)+$/,
      '',
    )
    .replace(/\s*(?:에서|부터|까지)\s*$/, '')
    .trim();
}

export function parseSpokenRouteQueries(message: string) {
  if (
    /^(?:준비|이동|정류장까지|안전|여유)(?:\s*시간)?\s*(?:은|는)?\s*(?:\d+|[영일이삼사오육칠팔구십한두세네다섯여섯일곱여덟아홉열]+)\s*분/.test(
      message.trim(),
    )
  ) {
    return { originQuery: '', destinationQuery: '' };
  }
  const normalized = message
    .normalize('NFC')
    .replace(/^\s*여기서\s*/, '현재 위치에서 ')
    .replace(/^내가\s+있는\s+곳에서\s*/, '현재 위치에서 ')
    .replace(/^지금\s+있는\s+곳에서\s*/, '현재 위치에서 ')
    .replace(/\s+/g, ' ')
    .replace(/출발\s+지/g, '출발지')
    .replace(/도착\s+지/g, '도착지')
    .trim();

  const postfixRoute =
    /^(.+?)\s+출발(?:해서|하고)?\s+(.+?)\s+도착(?:.*)?$/.exec(normalized);
  if (postfixRoute) {
    return {
      originQuery: cleanSpokenPlaceQuery(postfixRoute[1]),
      destinationQuery: cleanSpokenPlaceQuery(postfixRoute[2]),
    };
  }

  const labelledSlots = { originQuery: '', destinationQuery: '' };
  const labels = [
    ...normalized.matchAll(
      /(?:출발지|도착지|목적지)(?:는|은|이|가)?\s*[:：]?|(?:출발|도착|목적)(?:은|는)\s*[:：]?|(?:출발|도착|목적)\s*[:：]|(?:출발|도착)\s+(?=\S)/g,
    ),
  ];
  for (const [index, label] of labels.entries()) {
    const start = (label.index ?? 0) + label[0].length;
    const end = labels[index + 1]?.index ?? normalized.length;
    const value = cleanSpokenPlaceQuery(normalized.slice(start, end));
    if (label[0].startsWith('출발')) labelledSlots.originQuery = value;
    else labelledSlots.destinationQuery = value;
  }
  if (labelledSlots.originQuery || labelledSlots.destinationQuery) {
    return labelledSlots;
  }

  const originOnly = /^(.+?)(?:에서|부터)\s*출발(?:할래|할게|해|합니다)?$/.exec(
    normalized,
  );
  if (originOnly) {
    return {
      originQuery: cleanSpokenPlaceQuery(originOnly[1]),
      destinationQuery: '',
    };
  }

  const fromTo =
    /^(.+?)(?:에서|부터)\s*(?:출발(?:해서|하고|해)?\s*)?(.+)$/.exec(normalized);
  if (fromTo) {
    return {
      originQuery: cleanSpokenPlaceQuery(fromTo[1]),
      destinationQuery: cleanSpokenPlaceQuery(fromTo[2]),
    };
  }

  const destinationOnly =
    /^(.+?)(?:까지|으로|로|에)?\s*(?:가고\s*싶.*|갈래.*|갈게.*|가자.*|가\s*줘.*|가려고.*|안내.*|도착.*|해\s*줘.*)$/.exec(
      normalized,
    );
  if (destinationOnly) {
    return {
      originQuery: '',
      destinationQuery: cleanSpokenPlaceQuery(destinationOnly[1]),
    };
  }

  return /(?:알림|준비\s*시간|이동\s*시간|여유\s*시간|취소|고마워)|^(?:버스|시간)(?:\s|$)/.test(
    normalized,
  )
    ? { originQuery: '', destinationQuery: '' }
    : {
        originQuery: '',
        destinationQuery: cleanSpokenPlaceQuery(
          normalized.replace(/(?:으로|까지)$/, ''),
        ),
      };
}

export type VoiceSlot = 'origin' | 'destination';
export type RouteQueries = { originQuery: string; destinationQuery: string };

export function parseRouteFollowUp(
  message: string,
  pendingSlot: VoiceSlot | null,
): RouteQueries {
  const parsed = parseSpokenRouteQueries(message);
  const hasRouteMarkers = /출발|도착|목적지|에서|부터|까지|가고|갈래|갈게/.test(
    message,
  );
  if (pendingSlot === 'origin' && !hasRouteMarkers && !parsed.originQuery) {
    return { originQuery: parsed.destinationQuery, destinationQuery: '' };
  }
  return parsed;
}

export function placeSearchQueries(query: string) {
  const spaced = query.normalize('NFC').replace(/\s+/g, ' ').trim();
  // Retry spacing only, never guess a similar-sounding geographic name.
  return [...new Set([spaced, spaced.replace(/\s/g, '')])].filter(Boolean);
}

export function placeSearchFailure(
  mode: 'demo' | 'live' | 'unavailable',
  query: string,
  slot: VoiceSlot,
) {
  if (mode === 'demo')
    return '실제 장소 검색이 아직 연결되지 않았어요. 말한 내용은 정확해도 체험 장소 외에는 찾을 수 없어요.';
  if (mode === 'unavailable')
    return '장소 검색 서비스에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.';
  return `“${query}” 검색 결과가 없어요. ${slot === 'origin' ? '출발지' : '도착지'}의 지역이나 주소를 알려주세요.`;
}
