# AI 연결 준비 상태

2026-09-20 기준. 연결 코드·화면 흐름·모의 API 테스트를 구현하고 실제 계정의 Whisper 받아쓰기·Qwen 해석·Gemini 한국어 오디오 생성을 확인했습니다.
**발음별 인식률·합성 음성의 자연스러움·모바일 실기기 검증은 별도로 필요합니다.**

## 선택한 구성

- 받아쓰기: Cloudflare Workers AI `@cf/openai/whisper-large-v3-turbo`
- 문장 해석: `@cf/qwen/qwen3-30b-a3b-fp8` (오픈 가중치 MoE 모델의 호스팅 API)
- 장소·좌표: 기존 장소 검색 API. LLM은 좌표나 장소 ID를 만들지 않음
- 준비·출발 시각: 기존 TypeScript 계산 코드. LLM이 계산하거나 실시간 버스 정보를 생성하지 않음
- 읽어주는 목소리: Google `gemini-2.5-flash-preview-tts`, 기본 Sulafat. 미연결·한도 초과·실패 시 화면 안내와 재시도 제공. 기기 TTS로 전환하지 않음

모델을 다운로드하거나 별도 GPU 서버를 띄울 필요 없이 Next.js 서버가 Cloudflare 및 Google REST API를 호출합니다.
이번 커스텀은 한국어 시스템 지시문·JSON 스키마·검증·도구 연결입니다. 파인튜닝이나 모델 학습을 했다는 의미는 아닙니다.

## 나중에 등록할 값

실제 값은 `.env`/`.env.local` 또는 배포 서비스의 **서버 환경변수**에만 등록합니다.
형식은 저장소의 [.env.example](../.env.example)을 기준으로 합니다.

| 이름 | 값 |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 대시보드의 32자리 16진수 Account ID. 이메일이나 Zone ID가 아님 |
| `CLOUDFLARE_API_TOKEN` | 해당 계정의 Workers AI 실행 권한을 가진 API Token. 임의의 예시 키를 사용하면 안 됨 |
| `CLOUDFLARE_VOICE_INTENT_MODEL` | 기본값 `@cf/qwen/qwen3-30b-a3b-fp8` |
| `VOICE_AI_ENABLED` | 기본 활성화. `false`로 설정하면 LLM 호출 중지 |
| `VOICE_TRANSCRIPTION_ENABLED` | 기본 활성화. `false`로 설정하면 Whisper 녹음 전송 중지 |
| `GEMINI_API_KEY` | Google AI Studio에서 발급한 Gemini 서버 전용 키 |
| `VOICE_TTS_ENABLED` | 기본 활성화. `false`로 설정하면 TTS 중지, 화면 안내 유지 |
| `GEMINI_TTS_VOICE` | 선택 사항. `Sulafat`(기본), `Achernar`, `Kore` 중 선택 |

Cloudflare 계정 ID와 토큰이 비어 있으면 기기 음성인식·기본 문장 해석으로 동작합니다. Gemini 키가 없으면 음성 연결 오류를 표시하고 화면으로 안내합니다. 기기 TTS로 대체하지 않습니다.
키 등록 후 개발 서버를 재시작하거나 배포를 갱신하면 녹음 모드와 AI 안내 음성이 활성화됩니다.
TTS는 별도의 Gemini 키를 사용합니다. 기존 `CLOUDFLARE_TTS_LANGUAGE`는 사용하지 않습니다. 기기 TTS 선택 UI와 자동 전환 코드는 제거했고, 저장된 `voiceOutput`·`voiceURI`는 무시합니다. 읽는 속도·이동시간 설정은 유지합니다.
홈 페이지는 서버에서 동적으로 기능 사용 가능 여부만 전달하며 토큰을 클라이언트에 전달하지 않습니다.
`NEXT_PUBLIC_` 접두사를 붙이지 마세요.

AI 자격증명은 실제 장소·버스 데이터를 제공하지 않습니다. 실서비스 이동 안내에는 기존 지도·교통 데이터 연결도 필요합니다.
무료 할당량이 무제한 사용을 의미하지 않습니다. 계정별 할당량·요금·추론 제한은 연결 시 대시보드에서 확인하세요.

## 실제 API 규격

서버의 고정 호출 주소:

```text
POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{MODEL}
Authorization: Bearer {API_TOKEN}
Content-Type: application/json
```

Cloudflare의 `{ success: true, result: ... }` 래퍼를 확인합니다. 오류 응답 본문과 토큰은 사용자에게 반환하거나 로그로 기록하지 않습니다.

### 1. 오디오 → 텍스트

사용자가 누른 동안 최대 15초 녹음합니다. 한 번 눌러 시작·종료하는 접근성 모드도 유지합니다.
권한을 기다리는 중 손을 떼면 요청을 취소하고, 나중에 권한이 허용돼도 마이크를 바로 닫습니다.

브라우저가 완성된 WebM/MP4 녹음을 디코딩하고 **16kHz / 모노 / PCM16 WAV**로 변환합니다.
서버의 `POST /api/transcribe`는 `Content-Type: audio/wav`의 바이너리를 받습니다.
최대 크기는 480,044바이트로, Vercel 요청 제한보다 작습니다. 서버가 실제 WAV 샘플 수와 헤더를 검사합니다.

Whisper 요청:

```json
{
  "audio": "<WAV 파일의 base64 문자열>",
  "task": "transcribe",
  "language": "ko",
  "vad_filter": true,
  "condition_on_previous_text": false,
  "initial_prompt": "한국어 버스 이동 요청. 출발지, 도착지, 현재 위치, 정류장, 저상버스, 준비 시간, 이동 시간, 여유 시간."
}
```

`result.text`를 정리한 후 앱에 `{ text, reason, mode: "cloudflare" }`로 반환합니다.
무음은 모델 호출 전에 걸러냅니다. 빈 결과·무음 확률이 높은 결과·300자 초과 결과를 경로로 자동 적용하지 않습니다.
아주 작은 목소리나 비전형적 발화는 실제 사용자 발음으로 VAD와 무음 기준을 평가해야 합니다.

### 2. 텍스트 → 검증된 명령

`POST /api/voice-intent` 요청:

```json
{ "message": "현재 위치에서 서울역까지, 준비는 5분", "pendingSlot": null }
```

LLM에는 이 두 필드만 전달합니다. GPS 좌표·장소 후보·사용자 프로필은 전달하지 않습니다.
Cloudflare의 `response_format: { type: "json_schema", json_schema: ... }`와 비스트리밍 응답을 사용합니다.
Qwen의 `choices[0].message.content`와 Cloudflare의 `response` 객체/문자열 응답을 지원합니다.
거절, 잘린 응답, 스키마 위반, 범위를 벗어난 시간, 사용자가 말하지 않은 분 값은 적용하지 않습니다.

앱에 반환되는 예:

```json
{
  "action": "route",
  "originQuery": "현재 위치",
  "destinationQuery": "서울역",
  "settingsPatch": { "preparationMinutes": 5 },
  "clarification": null,
  "clarificationSlot": null,
  "mode": "model",
  "reason": null
}
```

`action`: `route | settings | departure | cancel | unknown`.
모델 스키마에서 언급하지 않은 시간은 `null`이며 서버가 제거합니다.
준비 0~30분, 이동 1~60분, 여유 1~15분만 허용합니다.
계정/모델 오류나 지연 시 기본 해석 결과와 `mode: "local"`을 반환합니다.
모델 이름 변경은 동일한 Workers AI JSON 요청·응답 규격을 지원하는 모델에 한해 가능합니다.

### 3. 장소 확인 → 출발 시각 안내

- “현재 위치”는 브라우저 위치 권한으로 얻습니다.
- 검색어가 정확히 하나의 장소 이름과 일치할 때만 자동 선택합니다.
- 중복/부분 일치이면 주소를 보여주고 선택받습니다. 후속 발화와 함께 말한 시간 변경을 유지합니다.
- 경로 확인 뒤 도착정보를 기다려 출발 시간을 계산합니다.
- 오래된 실시간 정보, 조회 실패, 미확정 경로에서는 출발 시각을 만들지 않습니다.
- “몇 분 뒤에 출발해?”는 새 장소 검색 없이 현재 경로의 최신 상태로 답합니다.
- 취소/창 닫기 시 진행 중인 처리를 취소하며, 늦게 도착한 응답이 경로를 덮어쓰지 않습니다.

### 4. 안내 문장 → 합성 음성

클라이언트의 `POST /api/tts` 요청은 `{ "text": "3분 뒤 출발하세요." }`입니다.
서버가 고정 모델 `gemini-2.5-flash-preview-tts`의 `generateContent` 엔드포인트를 호출합니다.
인증은 `x-goog-api-key` 헤더를 사용하며, 키를 URL이나 클라이언트에 포함하지 않습니다.

```json
{
  "contents": [{ "parts": [{ "text": "한국어 읽기 지시문 + 안내 문장" }] }],
  "generationConfig": {
    "responseModalities": ["AUDIO"],
    "speechConfig": { "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": "Sulafat" } } }
  }
}
```

완료 상태 `STOP`인 단일 후보의 `inlineData`를 검증합니다. Base64 PCM16(24kHz·모노·little-endian)에 WAV 헤더를 붙여 반환합니다.
잘린 결과·거절·잘못된 형식·표본 수·과대 응답은 재생하지 않습니다. 오류가 나도 다른 유료 모델로 재시도하지 않습니다.
클라이언트가 공급자 주소·모델을 바꿀 수 없으며, 문장 600자·요청 4KB·응답 오디오 2MB로 제한합니다.
서버 요청은 최대 18초, 일반 안내의 브라우저 대기는 최대 20초이며 실패하면 화면에 오류와 재시도 안내를 표시합니다. 기기 TTS로 전환하지 않으며 대기 중 취소할 수 있습니다.
안내 문장에 포함된 정류장·버스 번호도 합성을 위해 Google에 전송됩니다. 좌표나 API 키를 클라이언트 요청에 추가하지 않습니다.
Google 무료 등급에서는 입력·출력이 제품 개선에 사용될 수 있으므로 민감한 주소·정보를 입력하지 마세요. 앱의 결제 설정을 자동으로 변경하지 않으며 실제 프로젝트의 무료 등급·할당량은 운영자가 확인해야 합니다.

- 정상 추천·도착정보 없음·오류·준비/출발 알림까지 Gemini만 사용합니다. 설정에서 읽는 속도 조절, 미리 듣기와 중지가 가능합니다.
- 재생 중이거나 생성 대기 중 마이크를 켜면 음성을 멈추고, 늦은 응답도 재생하지 않습니다.
- 같은 문장의 오디오는 브라우저 메모리에만 최대 5분·8개·총 8MB 보관합니다. 새로고침하면 사라집니다.
- 페이지를 여는 것만으로 합성하지 않습니다. 사용자가 듣기를 누르거나 출발 알림을 켰을 때 요청합니다.
- 예약된 준비·출발 안내 두 문장은 미리 생성합니다. 알림 시각에 오디오가 없으면 음성 오류를 표시하고 화면·알림·진동을 유지합니다. 사용자는 안내 듣기로 최신 상태를 확인할 수 있습니다. 시간에 민감한 출발 명령을 늦게 재생하거나 다른 목소리로 대체하지 않습니다.
- 자동 재생 차단 시 다시 듣도록 안내합니다. 앱 종료·백그라운드에서도 음성이 재생된다는 보장은 없습니다.
- 경로 안내에는 승차 정류장 이름·공개 번호(숫자별 발음)·진행 방향·검증된 다음 정류장·하차 정류장을 포함합니다. 도착정보 조회 실패 시에도 확인된 탑승 위치를 설명하지만 저상 차량이나 출발 시각을 확정하지 않습니다. ‘주변에 물어볼 때’의 질문도 같은 Gemini 경로를 사용합니다.

**한국어 지원 확인:** 실제 Gemini 계정에서 Sulafat 목소리로 한국어 오디오 생성 성공을 확인했습니다.
정류장 이름·노선 번호·분 단위의 실제 발음과 자연스러움은 별도로 청취해야 합니다.
현재 TTS 공급자는 Gemini이며 Cloudflare MeloTTS 호출 코드는 제거했습니다. `/api/tts` 응답의 `X-TTS-Provider: gemini`로 공급자를 확인할 수 있습니다.

## 검증 및 연결 후 확인

```bash
npm test
npm run build
```

자동 테스트: 녹음 15초·중복 종료·권한 대기 취소·트랙 해제, WAV 형식/크기/무음,
서버 인증 요청, 키 미등록, 출처 제한, 오류/할당량, JSON 검증, 설정 유지,
모의 음성 → 모델 → 장소 → 출발 계산 흐름, TTS 요청·오디오 검증·취소·캐시·오류 시 기기 음성 전환 방지를 검증합니다.
이 테스트들은 외부 AI를 실제 호출하지 않습니다.

현재 자동 테스트 104개, 수정 파일 정적 검사, 프로덕션 빌드가 통과했습니다.
실제 Gemini 응답으로 브라우저 WAV 디코딩·재생을 확인했습니다. “3분 뒤 출발하세요. 대전역에서 707번 저상버스를 타세요.”를 합성한 뒤 Whisper로 다시 받아썼을 때 문장이 일치했습니다. 이는 한 문장의 내용 확인이며 모든 발음이나 자연스러움을 보장하지 않습니다.
별도의 Chrome 브라우저 검사에서도 390×844 화면에서 실제 MediaRecorder와 WAV 변환을 사용해
6개 시나리오(전체 연결, 시간 변경·출발 질문, 15초 자동 종료, 권한 대기 취소, 오류 복구, 녹음 중 창 닫기)를 통과했습니다.
이 브라우저 검사는 합성 마이크 입력과 모의 AI 응답을 사용하므로 실제 발화 인식률 검증은 아닙니다.
추가 TTS 브라우저 검사 8개도 통과했습니다. 오디오 디코딩·중지·재사용, 기존 기기 음성 설정 마이그레이션, API 오류 후 Gemini 재시도,
생성 대기 취소, 마이크 시작 시 대기·재생 중단, 도착정보 없음 화면 안내, 도착정보가 없는 상태의 음성 도우미 응답, 정류장 번호·지도·주변에 물어볼 질문 읽기를 확인합니다. 모의 WAV를 사용해 재생 흐름을 확인한 것으로 한국어 음질 평가와는 다릅니다.

추가 브라우저 검사는 Playwright와 Chrome이 설치된 환경에서 실행할 수 있습니다.
Playwright가 프로젝트 밖에 있으면 `PLAYWRIGHT_MODULE`에 해당 패키지의 `index.mjs` 경로를 지정합니다.
검사 스크립트는 별도 임시 포트의 서버를 띄우고 종료하며, 실제 AI를 호출하지 않습니다.

```bash
npm run build
node --experimental-strip-types tests/voice-ui.smoke.mjs
node --experimental-strip-types tests/tts-ui.smoke.mjs
```

연결 후 Chrome(Android)과 Safari(iOS)에서 다음을 확인하세요.

1. “현재 위치에서 서울역까지, 준비는 5분” → 받아쓰기·두 장소·5분 반영.
2. “몇 분 뒤에 나가면 돼?” → 화면 경로를 유지하고 실제 도착정보로 답변.
3. “출발지는 중앙병원” → 동명이인 주소 선택 후 원래 도착지·시간 유지.
4. 권한 거부, 권한 팝업 중 손 떼기, 창 닫기 → 마이크가 남아 켜지지 않음.
5. 길게 말하기 → 최대 15초에 한 번만 전송. 녹음 중 설명 길이가 달라도 버튼 위치 고정.
6. 네트워크 끊김·할당량 초과 → 오류 안내 후 글로 입력/기기 음성인식 이용 가능.
7. Cloudflare가 실제 받아쓰기와 의도 추출을 각각 처리했는지 확인. 화면의 “기본 문장 해석”을 모델 호출 성공으로 혼동하지 말 것.
8. 설정 → 안내 음성 · Gemini → 미리 듣기: 한국어 합성 여부, 정류장·노선 번호 발음과 지연 확인. 오류 시 기기 음성으로 바뀌지 않고 화면 안내를 표시하는지, 다시 누르면 Gemini로 재시도하는지 확인.
9. 음성 준비 취소·재생 중지·마이크 시작 → 이전 안내가 뒤늦게 재생되지 않음.
10. Android/iOS에서 첫 사용자 터치 뒤 재생, 자동 알림, 읽는 속도를 확인. 앱을 닫은 상태의 알림은 별도 미구현 기능.

## 보안·운영 제한

녹음·인식 텍스트는 요청 처리 메모리에서 사용합니다. 합성 음성은 위 제한 안에서 브라우저 메모리에 잠시 캐시합니다.
앱 DB·로컬 저장소에 이 오디오나 대화 내용을 저장하지 않습니다. 음성 종류·속도 같은 사용자 설정은 기존 설정 저장소에 보관합니다.
단, 외부 서비스의 데이터 처리 정책은 별도 확인 대상입니다.
같은 출처 요청 검사·본문 크기 제한·시간 제한·인스턴스당 분당 30회 제한을 적용했습니다.
현재 요청 제한은 분산된 모든 서버를 합산하지 않고 사용자별로 구분하지도 않습니다.
공개 운영 규모에서는 호스팅 방화벽/공유 저장소를 통한 남용 방지와 비용 모니터링을 추가해야 합니다.

## 확인한 공식 문서

- [Cloudflare REST API 시작하기](https://developers.cloudflare.com/workers-ai/get-started/rest-api/)
- [Whisper large-v3-turbo 요청·응답](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/)
- [Qwen3-30B-A3B FP8 요청·응답](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/)
- [Cloudflare JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/)
- [Gemini TTS 요청·응답](https://ai.google.dev/gemini-api/docs/generate-content/speech-generation)
- [Gemini 무료 등급·가격](https://ai.google.dev/gemini-api/docs/pricing#gemini-2.5-flash-preview-tts)
- [Vercel Functions 제한](https://vercel.com/docs/functions/limitations)
