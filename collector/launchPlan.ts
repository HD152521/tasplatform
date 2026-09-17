/**
 * 브라우저 실행 방식 선택 — 순수 함수.
 *
 * 컨테이너(cflinuxfs4)엔 브라우저 바이너리도, Chromium 이 필요로 하는 공유 라이브러리(.so)도
 * 없다. 그래서 컨테이너에서는 @sparticuz/chromium 이 번들한 바이너리를 쓰고(headless 고정),
 * 로컬(PC)에서는 Playwright 가 설치한 실제 브라우저를 쓴다 — 사람이 OTP 를 넣는 최초 로그인은
 * headed 창이 필요하기 때문이다.
 *
 * 실제 실행(playwright-core·@sparticuz/chromium 로드)과 이 판정을 분리해 둔다. 그래야
 * 브라우저를 띄우지 않고도 "어느 경로를 고르는가"만 순수하게 단위 테스트할 수 있다.
 */

/** 켜짐/꺼짐으로 읽히는 문자열. 그 외 값은 명시 설정으로 보지 않는다. */
const TRUTHY: ReadonlySet<string> = new Set(["1", "true", "yes", "on"]);
const FALSY: ReadonlySet<string> = new Set(["0", "false", "no", "off"]);

export interface LaunchPlan {
  /** true 면 @sparticuz/chromium 번들 바이너리로 띄운다(컨테이너 경로). */
  readonly bundled: boolean;
  /** 실제로 적용할 headless 여부. 번들 경로는 화면이 없으므로 항상 headless. */
  readonly headless: boolean;
}

/**
 * Cloud Foundry(TAS) 런타임인지.
 * CF 는 앱 컨테이너에 VCAP_APPLICATION 을 주입한다. 이게 있으면 컨테이너로 본다.
 */
export function isCloudFoundry(env: NodeJS.ProcessEnv): boolean {
  const vcap = env.VCAP_APPLICATION?.trim();
  return vcap !== undefined && vcap !== "";
}

/**
 * 번들 Chromium(@sparticuz)을 써야 하는가.
 *
 *  - SR_HEADLESS 가 켜짐/꺼짐으로 명시되면 그 값을 절대 기준으로 삼는다
 *    (로컬에서 강제로 켜거나, 컨테이너에서 강제로 끄는 탈출구).
 *  - 명시가 없으면(또는 알 수 없는 값이면) CF 컨테이너인지로 판단한다. 워커·웹 등이
 *    별도 env 없이도 컨테이너에서 무인 재로그인이 되도록 하기 위함이다.
 */
export function shouldUseBundledChromium(env: NodeJS.ProcessEnv): boolean {
  const flag = env.SR_HEADLESS?.trim().toLowerCase();
  if (flag !== undefined && flag !== "") {
    if (TRUTHY.has(flag)) return true;
    if (FALSY.has(flag)) return false;
    // 알 수 없는 값은 무시하고 컨테이너 판정으로 넘어간다(오설정에 안전).
  }
  return isCloudFoundry(env);
}

/** 요청한 headless 와 환경을 합쳐 최종 실행 계획을 만든다. */
export function planBrowserLaunch(
  requestedHeadless: boolean,
  env: NodeJS.ProcessEnv,
): LaunchPlan {
  const bundled = shouldUseBundledChromium(env);
  return { bundled, headless: bundled ? true : requestedHeadless };
}

/**
 * @sparticuz/chromium 이 컨테이너에서 시스템 공유 라이브러리(libnspr4.so 등)를 풀고
 * LD_LIBRARY_PATH 를 잡도록 강제한다.
 *
 * 근본 원인: @sparticuz/chromium 140 은 자신이 AL2023(AWS Lambda) 위에서 돈다고 판단할
 * 때에만 al2023.tar.br(시스템 .so 묶음)를 /tmp 로 풀고 LD_LIBRARY_PATH 를 설정한다.
 * cflinuxfs4 는 Ubuntu 라 그 판정이 false → 라이브러리가 안 풀려 chromium 이
 * "libnspr4.so: cannot open shared object file" 로 죽는다. apt-buildpack 이 없어 시스템에
 * .so 를 깔 수도 없다.
 *
 * 그 판정(isRunningInAmazonLinux2023)은 AWS_LAMBDA_JS_RUNTIME/AWS_EXECUTION_ENV 에
 * "20.x"·"22.x" 가 들어 있으면 참이 된다. 그래서 여기서 그 값을 심어 라이브러리 추출을
 * 켠다. AL2023(glibc 2.34) 바이너리·라이브러리는 cflinuxfs4(glibc 2.35, 상위호환)에서 돈다.
 *
 * ⚠ 반드시 `import("@sparticuz/chromium")` 앞에서 불러야 한다 — 모듈 로드 시점에 환경
 *   셋업 코드가 이 값을 읽기 때문이다. 이미 설정돼 있으면(진짜 Lambda 등) 덮지 않는다.
 */
export function enableSparticuzSystemLibs(env: NodeJS.ProcessEnv): void {
  const alreadyAl2023 =
    /2[02]\.x/.test(env.AWS_LAMBDA_JS_RUNTIME ?? "") ||
    /2[02]\.x/.test(env.AWS_EXECUTION_ENV ?? "");
  if (!alreadyAl2023) env.AWS_LAMBDA_JS_RUNTIME = "nodejs20.x";
}
