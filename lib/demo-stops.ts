export type TransitStop = {
  id: string;
  name: string;
  direction: string;
  route: string;
  cityCode?: string;
  distanceMeters?: number;
};

export const demoStops: TransitStop[] = [
  {
    id: 'demo-sinchon',
    name: '신촌로터리',
    direction: '홍대입구 방향',
    route: '271',
    distanceMeters: 180,
  },
  {
    id: 'demo-seoul',
    name: '서울역버스환승센터',
    direction: '만리동 방향',
    route: '701',
    distanceMeters: 260,
  },
  {
    id: 'demo-gangnam',
    name: '강남역',
    direction: '양재 방향',
    route: '3412',
    distanceMeters: 310,
  },
  {
    id: 'demo-hongdae',
    name: '홍대입구역',
    direction: '연희동 방향',
    route: '7612',
    distanceMeters: 340,
  },
  {
    id: 'demo-cityhall',
    name: '시청앞',
    direction: '광화문 방향',
    route: '402',
    distanceMeters: 370,
  },
  {
    id: 'demo-jongno',
    name: '종로2가',
    direction: '동대문 방향',
    route: '260',
    distanceMeters: 410,
  },
  {
    id: 'demo-jamsil',
    name: '잠실역',
    direction: '송파구청 방향',
    route: '3315',
    distanceMeters: 430,
  },
  {
    id: 'demo-yeouido',
    name: '여의도환승센터',
    direction: '마포대교 방향',
    route: '162',
    distanceMeters: 450,
  },
  {
    id: 'demo-konkuk',
    name: '건대입구역',
    direction: '성수사거리 방향',
    route: '240',
    distanceMeters: 470,
  },
  {
    id: 'demo-sadang',
    name: '사당역',
    direction: '이수역 방향',
    route: '350',
    distanceMeters: 490,
  },
];
