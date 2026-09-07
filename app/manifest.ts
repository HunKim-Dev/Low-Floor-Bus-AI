import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: '버스마중 AI',
    short_name: '버스마중',
    description:
      '내 이동속도에 맞춰 탈 수 있는 저상버스와 출발 시점을 안내합니다.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f7f9fb',
    theme_color: '#10233f',
    lang: 'ko-KR',
    categories: ['navigation', 'utilities', 'accessibility'],
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'maskable',
      },
    ],
  };
}
