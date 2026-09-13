export type Place = {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  placeUrl?: string;
};

export type TripStop = {
  id: string;
  name: string;
  cityCode?: string;
};

export type TripPlan = {
  id: string;
  route: string;
  direction: string;
  totalMinutes: number;
  walkToStopMinutes: number;
  transfers: number;
  boardingStop: TripStop;
  alightingStop: Pick<TripStop, 'name'>;
  landingUrl?: string;
  arrivalLookupAvailable?: boolean;
};

export const demoPlaces: Place[] = [
  {
    id: 'demo-yonsei-main-gate',
    name: '연세대학교 정문',
    address: '서울 서대문구 연세로 50',
    latitude: 37.56001,
    longitude: 126.93686,
  },
  {
    id: 'demo-hongik-university-station',
    name: '홍대입구역',
    address: '서울 마포구 양화로 160',
    latitude: 37.5569,
    longitude: 126.92375,
  },
  {
    id: 'demo-severance-hospital',
    name: '세브란스병원',
    address: '서울 서대문구 연세로 50-1',
    latitude: 37.56228,
    longitude: 126.94004,
  },
  {
    id: 'demo-seoul-station',
    name: '서울역',
    address: '서울 용산구 한강대로 405',
    latitude: 37.55465,
    longitude: 126.97072,
  },
  {
    id: 'demo-seoul-city-hall',
    name: '서울시청',
    address: '서울 중구 세종대로 110',
    latitude: 37.5663,
    longitude: 126.97794,
  },
  {
    id: 'demo-gwanghwamun',
    name: '광화문광장',
    address: '서울 종로구 세종대로 175',
    latitude: 37.57239,
    longitude: 126.9769,
  },
  {
    id: 'demo-gangnam-station',
    name: '강남역',
    address: '서울 강남구 강남대로 396',
    latitude: 37.49795,
    longitude: 127.02762,
  },
];

type DemoRoutePreset = {
  keywords: string[];
  route: string;
  direction: string;
  boardingStop: string;
  alightingStop: string;
  totalMinutes: number;
  walkToStopMinutes: number;
};

const demoRoutePresets: DemoRoutePreset[] = [
  {
    keywords: ['홍대', '합정'],
    route: '271',
    direction: '홍대입구 방향',
    boardingStop: '신촌로터리',
    alightingStop: '홍대입구역',
    totalMinutes: 18,
    walkToStopMinutes: 5,
  },
  {
    keywords: ['서울역'],
    route: '701',
    direction: '서울역 방향',
    boardingStop: '신촌로터리',
    alightingStop: '서울역버스환승센터',
    totalMinutes: 31,
    walkToStopMinutes: 5,
  },
  {
    keywords: ['시청', '광화문'],
    route: '271',
    direction: '종로 방향',
    boardingStop: '신촌로터리',
    alightingStop: '종로2가',
    totalMinutes: 36,
    walkToStopMinutes: 5,
  },
  {
    keywords: ['강남'],
    route: '740',
    direction: '강남역 방향',
    boardingStop: '신촌로터리',
    alightingStop: '강남역',
    totalMinutes: 58,
    walkToStopMinutes: 5,
  },
  {
    keywords: ['세브란스', '연세'],
    route: '7017',
    direction: '신촌 방향',
    boardingStop: '신촌로터리',
    alightingStop: '세브란스병원앞',
    totalMinutes: 14,
    walkToStopMinutes: 5,
  },
];

const defaultDemoRoute: DemoRoutePreset = {
  keywords: [],
  route: '271',
  direction: '홍대입구 방향',
  boardingStop: '신촌로터리',
  alightingStop: '홍대입구역',
  totalMinutes: 24,
  walkToStopMinutes: 5,
};

function createKakaoTransitLandingUrl(origin: Place, destination: Place) {
  const originPath = `${encodeURIComponent(origin.name)},${origin.latitude},${origin.longitude}`;
  const destinationPath = `${encodeURIComponent(destination.name)},${destination.latitude},${destination.longitude}`;
  return `https://map.kakao.com/link/by/traffic/${originPath}/${destinationPath}`;
}

export function createDemoTrip(origin: Place, destination: Place): TripPlan {
  const destinationText = `${destination.name} ${destination.address}`;
  const preset =
    demoRoutePresets.find((candidate) =>
      candidate.keywords.some((keyword) => destinationText.includes(keyword)),
    ) ?? defaultDemoRoute;

  return {
    id: `demo:${origin.id}:${destination.id}:${preset.route}`,
    route: preset.route,
    direction: preset.direction,
    totalMinutes: preset.totalMinutes,
    walkToStopMinutes: preset.walkToStopMinutes,
    transfers: 0,
    boardingStop: {
      id: 'demo-sinchon',
      name: preset.boardingStop,
    },
    alightingStop: { name: preset.alightingStop },
    landingUrl: createKakaoTransitLandingUrl(origin, destination),
    arrivalLookupAvailable: false,
  };
}
