import type { Place } from './trip-planning.ts';

type LocationCode =
  | 'permission'
  | 'unavailable'
  | 'timeout'
  | 'unsupported'
  | 'insecure'
  | 'cancelled';

export class LocationError extends Error {
  readonly code: LocationCode;
  constructor(code: LocationCode) {
    super(code);
    this.code = code;
  }
}

export function locationErrorMessage(error: unknown) {
  const code = error instanceof LocationError ? error.code : 'unavailable';
  switch (code) {
    case 'permission':
      return '위치 접근이 차단되어 있어요. 브라우저의 이 사이트 위치 권한과 기기의 위치 서비스를 허용한 뒤 다시 눌러 주세요.';
    case 'timeout':
      return '위치를 찾는 데 시간이 오래 걸려요. 다시 시도하거나 출발지 이름을 직접 검색해 주세요.';
    case 'unsupported':
      return '이 브라우저에서는 위치를 가져올 수 없어요. Chrome 또는 Safari에서 열거나 출발지를 직접 검색해 주세요.';
    case 'insecure':
      return '현재 위치는 보안 연결(HTTPS)에서 사용할 수 있어요. HTTPS 주소로 열거나 출발지를 직접 검색해 주세요.';
    case 'cancelled':
      return '위치 조회를 취소했어요.';
    default:
      return '기기에서 위치를 가져오지 못했어요. 기기의 위치 서비스와 네트워크를 확인해 주세요. 앱 안 브라우저라면 Chrome 또는 Safari에서 다시 시도하거나 출발지를 직접 검색해 주세요.';
  }
}

export function getCurrentLocation(options: {
  geolocation?: Pick<Geolocation, 'getCurrentPosition'>;
  secureContext: boolean;
  signal?: AbortSignal;
}): Promise<Place> {
  return new Promise((resolve, reject) => {
    if (!options.secureContext) {
      reject(new LocationError('insecure'));
      return;
    }
    if (!options.geolocation) {
      reject(new LocationError('unsupported'));
      return;
    }
    if (options.signal?.aborted) {
      reject(new LocationError('cancelled'));
      return;
    }
    let settled = false;
    let attempt = 0;
    const finish = (error: LocationError | null, place?: Place) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(place!);
    };
    const abort = () => finish(new LocationError('cancelled'));
    options.signal?.addEventListener('abort', abort, { once: true });
    // Some embedded browsers never invoke either callback, so bound the wait.
    const timer = setTimeout(() => finish(new LocationError('timeout')), 18_000);
    const locate = (precise: boolean) => {
      const id = ++attempt;
      const fail = (code: number) => {
        if (settled || id !== attempt) return;
        if (code !== 1 && precise) {
          locate(false);
          return;
        }
        finish(
          new LocationError(
            code === 1 ? 'permission' : code === 3 ? 'timeout' : 'unavailable',
          ),
        );
      };
      try {
        options.geolocation!.getCurrentPosition(
          (position) => {
            if (settled || id !== attempt) return;
            const { latitude, longitude, accuracy } = position.coords;
            if (
              !Number.isFinite(latitude) ||
              !Number.isFinite(longitude) ||
              Math.abs(latitude) > 90 ||
              Math.abs(longitude) > 180
            ) {
              fail(2);
              return;
            }
            finish(null, {
              id: `current-${latitude.toFixed(5)}-${longitude.toFixed(5)}`,
              name: '현재 위치',
              address: Number.isFinite(accuracy)
                ? `기기에서 확인한 위치 · 오차 약 ${Math.ceil(accuracy)}m`
                : '기기에서 확인한 위치',
              latitude,
              longitude,
            });
          },
          (error) => fail(error.code),
          {
            enableHighAccuracy: precise,
            timeout: precise ? 7_000 : 8_000,
            maximumAge: precise ? 0 : 60_000,
          },
        );
      } catch {
        fail(2);
      }
    };
    locate(true);
  });
}
