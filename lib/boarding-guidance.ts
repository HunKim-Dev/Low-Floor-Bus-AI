import type { TripPlan, TripStop } from './trip-planning.ts';

// Some cities include a hyphen; preserve leading zeroes. Never derive this
// public identifier from nodeid or nodeord, which identify different things.
export function publicStopNumber(value: unknown): string | undefined {
  const number =
    typeof value === 'string' || typeof value === 'number'
      ? String(value).trim()
      : '';
  return /^(?=.{1,12}$)\d+(?:-\d+)?$/.test(number) && /[1-9]/.test(number)
    ? number
    : undefined;
}

const digits = ['공', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
export function spokenStopNumber(value: string): string {
  return value
    .split('')
    .map((char) => (char === '-' ? '다시' : digits[Number(char)]))
    .join(' ');
}

export function boardingMapUrl(stop: TripStop): string | null {
  if (
    stop.id.startsWith('demo-') ||
    typeof stop.latitude !== 'number' ||
    !Number.isFinite(stop.latitude) ||
    Math.abs(stop.latitude) > 90 ||
    typeof stop.longitude !== 'number' ||
    !Number.isFinite(stop.longitude) ||
    Math.abs(stop.longitude) > 180
  )
    return null;
  // Kakao's documented coordinates-only map link needs no JavaScript API key.
  return `https://map.kakao.com/link/map/${encodeURIComponent(stop.name)},${stop.latitude},${stop.longitude}`;
}

export function boardingGuidance(
  trip: TripPlan,
  lowFloorConfirmed = false,
): string {
  const number = publicStopNumber(trip.boardingStop.number);
  return (
    `타는 곳은 ${trip.boardingStop.name} 정류장이에요. ` +
    (number ? `정류장 번호는 ${spokenStopNumber(number)}예요. ` : '') +
    `${trip.direction} ${trip.route}번 ${lowFloorConfirmed ? '저상버스를 타세요.' : '버스를 이용하는 경로예요.'} ` +
    (trip.nextStopName
      ? `이 버스의 다음 정류장은 ${trip.nextStopName}예요. `
      : '') +
    `${trip.alightingStop.name}에서 내려요. `
  );
}

export function boardingHelpQuestion(trip: TripPlan, spoken = false): string {
  const number = publicStopNumber(trip.boardingStop.number);
  return (
    `${trip.boardingStop.name} 정류장에서 ${trip.direction} ${trip.route}번 버스를 타려고 해요. ` +
    (number
      ? `정류장 번호는 ${spoken ? spokenStopNumber(number) : number}이고, `
      : '') +
    (trip.nextStopName
      ? `이 버스의 다음 정류장은 ${trip.nextStopName}예요. `
      : number
        ? '그 번호의 정류장을 찾고 있어요. '
        : '') +
    '타는 곳이 어디인지 알려주실 수 있나요?'
  );
}
