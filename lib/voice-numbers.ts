export function normalizeMinuteWords(message: string) {
  const digits: Record<string, number> = {
    영: 0,
    공: 0,
    일: 1,
    이: 2,
    삼: 3,
    사: 4,
    오: 5,
    육: 6,
    칠: 7,
    팔: 8,
    구: 9,
    한: 1,
    두: 2,
    세: 3,
    네: 4,
    다섯: 5,
    여섯: 6,
    일곱: 7,
    여덟: 8,
    아홉: 9,
    열: 10,
  };
  return message.replace(
    /([영공일이삼사오육칠팔구십한두세네다섯여섯일곱여덟아홉열]+)\s*분/g,
    (original, word: string) => {
      if (digits[word] !== undefined) return `${digits[word]}분`;
      const tens = /^([일이삼사오육칠팔구]?)십([일이삼사오육칠팔구]?)$/.exec(
        word,
      );
      return tens
        ? `${(digits[tens[1]] ?? 1) * 10 + (digits[tens[2]] ?? 0)}분`
        : original;
    },
  );
}

export function extractMinutes(message: string, keyword: string) {
  const value = normalizeMinuteWords(message);
  const match =
    value.match(
      new RegExp(keyword + '(?:은|는|이|가|을|를)?\\s*(?:약\\s*)?(\\d+)\\s*분'),
    ) ?? value.match(new RegExp('(\\d+)\\s*분(?:으로|쯤)?\\s*' + keyword));
  return match ? Number(match[1]) : null;
}
