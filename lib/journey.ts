export type Settings = {
  preparationMinutes: number;
  travelMinutes: number;
  safetyMinutes: number;
  automaticTravelTime: boolean;
  travelMultiplier: number;
  voiceAlerts: boolean;
  vibrationAlerts: boolean;
  voiceRate: number;
};

export const defaultSettings: Settings = {
  preparationMinutes: 3,
  travelMinutes: 7,
  safetyMinutes: 2,
  automaticTravelTime: true,
  travelMultiplier: 1.5,
  voiceAlerts: true,
  vibrationAlerts: true,
  voiceRate: 0.98,
};

export function restoreSettings(value: unknown): Settings {
  const result = { ...defaultSettings };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return result;
  const saved = value as Record<string, unknown>;
  const ranges = {
    preparationMinutes: [0, 30],
    travelMinutes: [1, 60],
    safetyMinutes: [1, 15],
    travelMultiplier: [1, 3],
    voiceRate: [0.7, 1.2],
  } as const;
  for (const key of Object.keys(ranges) as (keyof typeof ranges)[]) {
    const number = saved[key];
    if (
      typeof number === 'number' &&
      Number.isFinite(number) &&
      number >= ranges[key][0] &&
      number <= ranges[key][1] &&
      (!key.endsWith('Minutes') || Number.isInteger(number))
    )
      result[key] = number;
  }
  for (const key of [
    'automaticTravelTime',
    'voiceAlerts',
    'vibrationAlerts',
  ] as const) {
    if (typeof saved[key] === 'boolean') result[key] = saved[key];
  }
  // Ignore legacy voiceOutput/voiceURI preferences: all TTS now uses Gemini.
  return result;
}

export type BusCandidate = {
  id: string;
  route: string;
  etaMinutes: number;
  etaSeconds?: number;
  arrivalAt?: number;
  stopsAway: number;
  lowFloor: boolean;
  congestion: '여유' | '보통' | '혼잡' | '정보 없음';
};

export function stampArrivals(buses: BusCandidate[], fetchedAt: number) {
  return buses
    .filter(
      (bus) =>
        Number.isFinite(bus.etaSeconds ?? bus.etaMinutes) &&
        (bus.etaSeconds ?? bus.etaMinutes) >= 0,
    )
    .map((bus) => ({
      ...bus,
      arrivalAt: fetchedAt + (bus.etaSeconds ?? bus.etaMinutes * 60) * 1000,
    }));
}

export function remainingBus(bus: BusCandidate, now: number): BusCandidate {
  return {
    ...bus,
    etaMinutes: Math.max(0, ((bus.arrivalAt ?? now) - now) / 60_000),
  };
}

export function getRecommendation(
  buses: BusCandidate[],
  settings: Settings,
  now: number,
) {
  const requiredLead =
    settings.preparationMinutes +
    settings.travelMinutes +
    settings.safetyMinutes;
  const lowFloorBuses = buses
    .filter((bus) => bus.lowFloor && (bus.arrivalAt ?? 0) > now)
    .map((bus) => remainingBus(bus, now))
    .sort((a, b) => a.etaMinutes - b.etaMinutes);
  return {
    recommended:
      lowFloorBuses.find((bus) => bus.etaMinutes >= requiredLead) ?? null,
    excluded: lowFloorBuses.filter((bus) => bus.etaMinutes < requiredLead),
    requiredLead,
  };
}

export type AlertPlan = {
  bus: BusCandidate;
  prepareAt: number;
  departAt: number;
  settingsKey: string;
};

export function timingKey(settings: Settings) {
  return [
    settings.preparationMinutes,
    settings.travelMinutes,
    settings.safetyMinutes,
  ].join(':');
}

export function createAlertPlan(
  bus: BusCandidate,
  settings: Settings,
): AlertPlan {
  const departAt =
    (bus.arrivalAt ?? 0) -
    (settings.travelMinutes + settings.safetyMinutes) * 60_000;
  return {
    bus,
    departAt,
    prepareAt: departAt - settings.preparationMinutes * 60_000,
    settingsKey: timingKey(settings),
  };
}

export function dueAlert(
  plan: AlertPlan,
  now: number,
  sent: { prepare: boolean; depart: boolean },
) {
  if (sent.depart) return null;
  if (now > plan.departAt + 30_000) return 'expired';
  if (now >= plan.departAt) return 'depart';
  if (!sent.prepare && now >= plan.prepareAt) return 'prepare';
  return null;
}

export function travelMinutesForRoute(
  settings: Settings,
  routeMinutes?: number,
) {
  return settings.automaticTravelTime && routeMinutes && routeMinutes > 0
    ? Math.max(1, Math.ceil(routeMinutes * settings.travelMultiplier))
    : settings.travelMinutes;
}
