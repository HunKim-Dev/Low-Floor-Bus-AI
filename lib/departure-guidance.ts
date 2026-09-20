import {
  createAlertPlan,
  getRecommendation,
  travelMinutesForRoute,
  timingKey,
  type AlertPlan,
  type BusCandidate,
  type Settings,
} from './journey.ts';
import type { Place, TripPlan } from './trip-planning.ts';
import { boardingGuidance } from './boarding-guidance.ts';

export type DepartureSnapshot = {
  origin: Place;
  destination: Place | null;
  trip: TripPlan | null;
  tripBusy: boolean;
  busesBusy: boolean;
  tripError: string | null;
  buses: BusCandidate[];
  settings: Settings;
  tripMode: 'demo' | 'live' | 'unavailable';
  dataMode: 'demo' | 'live' | 'unavailable';
  lastUpdatedAt: number | null;
  alertPlan?: AlertPlan | null;
};

// No LLM arithmetic. Evaluate arrival timestamps again at the moment of reply.
export function departureGuidance(
  state: DepartureSnapshot,
  now = Date.now(),
): string {
  if (state.origin.id === 'unset')
    return '출발지를 먼저 알려주세요. 현재 위치라고 말해도 돼요.';
  if (!state.destination) return '어디로 갈까요? 도착지를 알려주세요.';
  if (state.tripBusy)
    return '경로와 버스 도착 시간을 확인하고 있어요. 잠시 후 다시 확인해 주세요.';
  if (!state.trip || state.tripMode === 'unavailable')
    return (
      state.tripError ||
      '이 경로의 직행 저상버스를 확인하지 못했어요. 출발 시간을 안내할 수 없어요.'
    );
  const demoNotice =
    state.tripMode === 'demo'
      ? '체험용 안내예요. 실제 이동에 사용하지 마세요. '
      : '';
  const routeGuidance = demoNotice + boardingGuidance(state.trip);
  if (state.busesBusy)
    return (
      routeGuidance +
      '버스 도착 시간을 확인하고 있어요. 잠시 후 다시 확인해 주세요.'
    );
  if (
    state.dataMode === 'unavailable' ||
    state.lastUpdatedAt === null ||
    (state.dataMode === 'live' &&
      (now - state.lastUpdatedAt > 90_000 || state.lastUpdatedAt > now + 5_000))
  )
    return (
      routeGuidance +
      '최신 버스 도착 정보가 없어 출발 시간을 안내할 수 없어요. 도착 정보를 다시 확인해 주세요.'
    );
  if (state.tripMode !== state.dataMode)
    return (
      routeGuidance +
      '경로와 도착 정보를 확인하고 있어요. 잠시 후 다시 확인해 주세요.'
    );
  const settings = {
    ...state.settings,
    travelMinutes: travelMinutesForRoute(
      state.settings,
      state.trip.walkToStopMinutes,
    ),
  };
  const trackedPlan =
    state.alertPlan?.settingsKey === timingKey(settings) &&
    state.alertPlan.departAt >= now &&
    (state.alertPlan.bus.arrivalAt ?? 0) > now &&
    state.buses.some(
      (bus) =>
        bus.id === state.alertPlan?.bus.id &&
        bus.lowFloor &&
        bus.arrivalAt === state.alertPlan.bus.arrivalAt,
    )
      ? state.alertPlan
      : null;
  const recommended =
    trackedPlan?.bus ??
    getRecommendation(state.buses, settings, now).recommended;
  if (!recommended)
    return (
      routeGuidance +
      '준비와 이동 시간을 고려하면 여유 있게 탈 수 있는 저상버스가 아직 없어요. 다음 도착 정보를 확인해 주세요.'
    );
  const plan = trackedPlan ?? createAlertPlan(recommended, settings);
  // Round down so spoken instructions never delay departure beyond the plan.
  const departMinutes = Math.max(0, Math.floor((plan.departAt - now) / 60_000));
  const prepareMinutes = Math.max(
    0,
    Math.floor((plan.prepareAt - now) / 60_000),
  );
  const time = new Intl.DateTimeFormat('ko-KR', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Seoul',
  }).format(plan.departAt);
  return (
    demoNotice +
    (prepareMinutes
      ? `${prepareMinutes}분 뒤 준비하고, `
      : trackedPlan && plan.prepareAt < now
        ? '준비를 마치고 '
        : '지금 준비해서 ') +
    (departMinutes
      ? `${departMinutes}분 뒤(${time}) 출발하세요. `
      : '지금 출발하세요. ') +
    boardingGuidance(state.trip, true) +
    `준비 ${settings.preparationMinutes}분, 이동 ${settings.travelMinutes}분, 여유 ${settings.safetyMinutes}분을 반영했어요. 버스 도착 시간은 바뀔 수 있어요.`
  );
}
