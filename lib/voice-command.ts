import { parseRouteFollowUp, type VoiceSlot } from './voice-route.ts';
import { extractMinutes, normalizeMinuteWords } from './voice-numbers.ts';
import type { Settings } from './journey.ts';

export type TimingPatch = Partial<
  Pick<Settings, 'preparationMinutes' | 'travelMinutes' | 'safetyMinutes'>
>;
export type VoiceCommand = {
  action: 'route' | 'settings' | 'departure' | 'cancel' | 'unknown';
  originQuery: string;
  destinationQuery: string;
  settingsPatch: TimingPatch;
  clarification: string | null;
  clarificationSlot: VoiceSlot | null;
};

const timingRanges = {
  preparationMinutes: [0, 30],
  travelMinutes: [1, 60],
  safetyMinutes: [1, 15],
} as const;

export function validateTimingPatch(value: unknown): TimingPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid settings');
  const patch: TimingPatch = {};
  for (const [key, minutes] of Object.entries(value)) {
    if (!Object.hasOwn(timingRanges, key)) throw new Error('unknown setting');
    if (minutes === null) continue;
    const [min, max] = timingRanges[key as keyof TimingPatch];
    if (
      typeof minutes !== 'number' ||
      !Number.isInteger(minutes) ||
      minutes < min ||
      minutes > max
    )
      throw new Error('invalid minutes');
    patch[key as keyof TimingPatch] = minutes;
  }
  return patch;
}

export function validateVoiceCommand(value: unknown): VoiceCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid command');
  const item = value as Record<string, unknown>;
  const fields = [
    'action',
    'originQuery',
    'destinationQuery',
    'settingsPatch',
    'clarification',
    'clarificationSlot',
  ];
  if (
    Object.keys(item).some((key) => !fields.includes(key)) ||
    fields.some((key) => !(key in item))
  )
    throw new Error('unexpected command fields');
  if (
    !['route', 'settings', 'departure', 'cancel', 'unknown'].includes(
      String(item.action),
    )
  )
    throw new Error('invalid action');
  for (const key of ['originQuery', 'destinationQuery']) {
    if (typeof item[key] !== 'string' || item[key].length > 120)
      throw new Error('invalid place query');
  }
  if (
    item.clarification !== null &&
    (typeof item.clarification !== 'string' ||
      !item.clarification.trim() ||
      item.clarification.length > 200)
  )
    throw new Error('invalid clarification');
  if (
    item.clarificationSlot !== null &&
    item.clarificationSlot !== 'origin' &&
    item.clarificationSlot !== 'destination'
  )
    throw new Error('invalid pending slot');
  const command: VoiceCommand = {
    action: item.action as VoiceCommand['action'],
    originQuery: (item.originQuery as string).trim(),
    destinationQuery: (item.destinationQuery as string).trim(),
    settingsPatch: validateTimingPatch(item.settingsPatch),
    clarification: item.clarification as string | null,
    clarificationSlot: item.clarificationSlot as VoiceSlot | null,
  };
  if (
    command.action !== 'route' &&
    (command.originQuery || command.destinationQuery)
  )
    throw new Error('conflicting route action');
  if (
    ['cancel', 'unknown'].includes(command.action) &&
    Object.keys(command.settingsPatch).length
  )
    throw new Error('conflicting settings');
  return command;
}

export function localVoiceCommand(
  message: string,
  pendingSlot: VoiceSlot | null,
): VoiceCommand {
  const empty: VoiceCommand = {
    action: 'unknown',
    originQuery: '',
    destinationQuery: '',
    settingsPatch: {},
    clarification: null,
    clarificationSlot: null,
  };
  const normalized = normalizeMinuteWords(message.normalize('NFC')).trim();
  if (/^(?:취소|그만|됐어|그만할래|취소해\s*줘)[.!?]*$/.test(normalized))
    return { ...empty, action: 'cancel' };
  const timeText = normalized
    .replace(/준비(?:하는\s*데|하는데|에)/g, '준비 ')
    .replace(/이동(?:하는\s*데|하는데|에)/g, '이동 ');
  const settingsPatch: TimingPatch = {};
  for (const [key, keyword] of [
    ['preparationMinutes', '준비(?:\\s*시간)?'],
    ['travelMinutes', '(?:이동|정류장까지)(?:\\s*시간)?'],
    ['safetyMinutes', '(?:안전|여유)(?:\\s*시간)?'],
  ] as const) {
    const minutes = extractMinutes(timeText, keyword);
    if (minutes !== null) {
      const [min, max] = timingRanges[key];
      if (minutes < min || minutes > max)
        return {
          ...empty,
          clarification: `시간은 ${min}~${max}분 사이로 다시 알려주세요.`,
        };
      settingsPatch[key] = minutes;
    }
  }
  const asksDeparture =
    /언제.*(?:나가|출발|준비)|몇\s*(?:분|시).*?(?:나가|출발|준비)|출발\s*(?:시각|시간).*(?:알려|언제|몇)|지금\s*(?:나가|출발).*돼/.test(
      normalized,
    );
  // Strip only a recognized time-setting clause. Preserve place names such as 분당.
  const routeText = timeText
    .replace(
      /(?:준비|이동|여유|안전|정류장까지)(?:\s*시간)?(?:은|는|이|가|을|를)?\s*(?:약\s*)?\d+\s*분(?:으로|쯤)?(?:\s*(?:정도로|정도|걸려요|걸려|걸리고|필요해요|필요해|이고|이야|이구요|으로|으로요))?(?:\s*(?:바꿔\s*줘|설정해\s*줘|해\s*줘))?/g,
      ' ',
    )
    .replace(/^[\s,，.!?]+|[\s,，.!?]+$/g, '')
    .replace(/^(?:그리고|하고)\s+|\s+(?:그리고|하고)$/g, '')
    .trim();
  const explicitRoute = /에서|부터|까지|출발지|도착지|목적지/.test(routeText);
  if (asksDeparture && !explicitRoute)
    return { ...empty, action: 'departure', settingsPatch };
  if (Object.keys(settingsPatch).length && !routeText)
    return { ...empty, action: 'settings', settingsPatch };
  if (/^(?:고마워|안녕|몇\s*번|도움말)/.test(routeText)) return empty;
  const queries = parseRouteFollowUp(routeText, pendingSlot);
  if (!queries.originQuery && !queries.destinationQuery)
    return {
      ...empty,
      action: Object.keys(settingsPatch).length ? 'settings' : 'unknown',
      settingsPatch,
    };
  return { ...empty, ...queries, action: 'route', settingsPatch };
}

export function applyTimingPatch(
  settings: Settings,
  patch: TimingPatch,
): Settings {
  const validated = validateTimingPatch(patch);
  return {
    ...settings,
    ...validated,
    ...(validated.travelMinutes !== undefined
      ? { automaticTravelTime: false }
      : {}),
  };
}

export function assertMentionedMinutes(command: VoiceCommand, message: string) {
  const normalized = normalizeMinuteWords(message);
  const mentioned = new Set(
    [...normalized.matchAll(/(?:^|[^\d.])(\d+)\s*분/g)].map((match) =>
      Number(match[1]),
    ),
  );
  if (
    Object.values(command.settingsPatch).some((value) => !mentioned.has(value))
  )
    throw new Error('model invented minutes');
  return command;
}

export function timingPatchText(patch: TimingPatch) {
  return (
    [
      ['preparationMinutes', '준비'],
      ['travelMinutes', '이동'],
      ['safetyMinutes', '여유'],
    ] as const
  )
    .filter(([key]) => patch[key] !== undefined)
    .map(([key, label]) => `${label} ${patch[key]}분`)
    .join(', ');
}

export const voiceCommandSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['route', 'settings', 'departure', 'cancel', 'unknown'],
    },
    originQuery: { type: 'string', maxLength: 120 },
    destinationQuery: { type: 'string', maxLength: 120 },
    settingsPatch: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        Object.entries(timingRanges).map(([key, [minimum, maximum]]) => [
          key,
          { type: ['integer', 'null'], minimum, maximum },
        ]),
      ),
      required: Object.keys(timingRanges),
    },
    clarification: { type: ['string', 'null'] },
    clarificationSlot: {
      type: ['string', 'null'],
      enum: ['origin', 'destination', null],
    },
  },
  required: [
    'action',
    'originQuery',
    'destinationQuery',
    'settingsPatch',
    'clarification',
    'clarificationSlot',
  ],
};
