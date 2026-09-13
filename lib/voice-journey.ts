import type { Place } from './trip-planning.ts';
import { locationErrorMessage } from './current-location.ts';
import type { PlaceSearchResult } from './place-search.ts';
import {
  uniquePlaceMatch,
  placeSearchFailure,
  type VoiceSlot,
  type RouteQueries,
} from './voice-route.ts';

export type VoiceDraft = RouteQueries & {
  origin: Place | null;
  destination: Place | null;
  pendingSlot: VoiceSlot | null;
};

export function mergeVoiceDraft(
  previous: VoiceDraft | null,
  queries: RouteQueries,
  origin: Place | null,
  destination: Place | null,
): VoiceDraft {
  const draft = previous
    ? { ...previous }
    : {
        originQuery: '',
        destinationQuery: '',
        origin,
        destination,
        pendingSlot: null,
      };
  if (queries.originQuery) {
    draft.originQuery = queries.originQuery;
    draft.origin = null;
  }
  if (queries.destinationQuery) {
    draft.destinationQuery = queries.destinationQuery;
    draft.destination = null;
  }
  return draft;
}

export function candidateFromSpeech(
  message: string,
  places: Place[],
): Place | null {
  const ordinal =
    /^(1|2|3|4|5|6|7|8|9|10|첫|첫째|두|둘째|세|셋째|네|넷째|다섯)(?:\s*번째|\s*번)?(?:\s*(?:장소|곳))?(?:으로|로)?(?:\s*(?:할게|해줘|해주세요|가줘|선택))?[.!?]*$/.exec(
      message.trim(),
    );
  if (ordinal) {
    const words: Record<string, number> = {
      첫: 1,
      첫째: 1,
      두: 2,
      둘째: 2,
      세: 3,
      셋째: 3,
      네: 4,
      넷째: 4,
      다섯: 5,
    };
    return places[(words[ordinal[1]] ?? Number(ordinal[1])) - 1] ?? null;
  }
  return uniquePlaceMatch(message, places);
}

type Resolution =
  | { kind: 'complete'; draft: VoiceDraft; origin: Place; destination: Place }
  | {
      kind: 'choose';
      draft: VoiceDraft;
      slot: VoiceSlot;
      places: Place[];
      message: string;
    }
  | { kind: 'retry'; draft: VoiceDraft; slot: VoiceSlot; message: string };

export async function resolveVoiceDraft(
  draft: VoiceDraft,
  dependencies: {
    search: (query: string, center: Place | null) => Promise<PlaceSearchResult>;
    locate: () => Promise<Place>;
  },
): Promise<Resolution> {
  const next = { ...draft };
  for (const slot of ['origin', 'destination'] as const) {
    if (next[slot]) continue;
    const query = slot === 'origin' ? next.originQuery : next.destinationQuery;
    next.pendingSlot = slot;
    if (!query)
      return {
        kind: 'retry',
        draft: next,
        slot,
        message:
          slot === 'origin'
            ? '어디서 출발하나요? 현재 위치라고 말해도 돼요.'
            : '어디로 갈까요? 도착지만 말해 주세요.',
      };
    if (/^(우리\s*)?(집|회사|거기|저기|병원)$/.test(query))
      return {
        kind: 'retry',
        draft: next,
        slot,
        message: `${slot === 'origin' ? '출발지' : '도착지'}의 장소 이름이나 주소를 알려주세요. 아직 저장된 주소가 없어요.`,
      };
    if (
      /^(현재위치|내위치|여기|지금있는곳|내가있는곳)$/.test(
        query.replace(/\s/g, ''),
      )
    ) {
      try {
        next[slot] = await dependencies.locate();
        continue;
      } catch (error) {
        return {
          kind: 'retry',
          draft: next,
          slot,
          message: locationErrorMessage(error),
        };
      }
    }
    const result = await dependencies.search(query, next.origin);
    const match = uniquePlaceMatch(query, result.places);
    if (match) {
      next[slot] = match;
      continue;
    }
    if (result.places.length)
      return {
        kind: 'choose',
        draft: next,
        slot,
        places: result.places,
        message: `“${query}” 검색 결과예요. 주소를 확인하고 골라 주세요.`,
      };
    return {
      kind: 'retry',
      draft: next,
      slot,
      message: placeSearchFailure(result.mode, query, slot),
    };
  }
  if (!next.origin || !next.destination) throw new Error('incomplete route');
  if (
    next.origin.id === next.destination.id ||
    (Math.abs(next.origin.latitude - next.destination.latitude) < 0.00001 &&
      Math.abs(next.origin.longitude - next.destination.longitude) < 0.00001)
  ) {
    next.destination = null;
    next.destinationQuery = '';
    next.pendingSlot = 'destination';
    return {
      kind: 'retry',
      draft: next,
      slot: 'destination',
      message: '출발지와 도착지가 같아요. 다른 도착지만 말해 주세요.',
    };
  }
  next.pendingSlot = null;
  return {
    kind: 'complete',
    draft: next,
    origin: next.origin,
    destination: next.destination,
  };
}
