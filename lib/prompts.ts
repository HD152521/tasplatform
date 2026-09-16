/**
 * 시스템 프롬프트 환경변수 오버라이드.
 *
 * 요약·리포트·답변요약의 시스템 지침을 코드 수정 없이 튜닝할 수 있게, 지정한 환경변수가
 * 채워져 있으면 그 값을 쓰고 없으면 기존 기본값을 그대로 쓴다.
 *
 * 각 프롬프트는 상수 대신 getter 함수로 노출해 "호출 시점"에 env 를 읽는다. 상수로 두면
 * 모듈 로드 시점에 한 번만 평가되어, loadEnv() 보다 먼저 import 될 경우 오버라이드가
 * 먹지 않을 수 있다. getter 는 이 순서 의존을 없앤다.
 *
 * server-only 를 붙이지 않는다. 수집기(Node)에서도 부른다.
 */

/** env[envKey] 에 공백 아닌 값이 있으면 그 값(트림), 없으면 fallback. */
export function promptOverride(envKey: string, fallback: string): string {
  const override = process.env[envKey]?.trim();
  return override !== undefined && override !== "" ? override : fallback;
}
