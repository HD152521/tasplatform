/**
 * 사진을 어느 슬라이드 어디에 놓을지 — 배치만 정한다.
 *
 * ## 왜 파이썬이 아니라 여기서 정하나
 *
 * lib/pptx.ts 가 반올림을 전부 TS 쪽에 두는 것과 같은 이유다. 파이썬은 받은 값을 그
 * 자리에 놓을 뿐이고, "몇 장이 생기고 어디에 놓이나" 는 여기서 정해져 단위테스트로
 * 잠긴다. 장수가 0·1·2·3·4일 때의 결과가 바뀌면 시험이 먼저 깨진다.
 *
 * ## 좌표의 출처
 *
 * **우리 템플릿 자신의 본문 영역**에서 온다 — 12장 전부 표가 left 0.613 / top 1.78 /
 * 폭 9.607 로 통일돼 있고, 좌우 여백이 0.613 으로 대칭이다. 사진도 같은 자리에 서야
 * 앞뒤 장과 줄이 맞는다.
 *
 * 이 값이 두 번 바뀌었다. 처음에는 고객 보고서에서 잰 값(좌 1.45 / 우 5.42)을 그대로
 * 썼는데 그때 우리 템플릿은 13.33in(16:9) 였고 그 문서는 10.83in(4:3) 이라, 사진이
 * 왼쪽으로 몰리고 오른쪽에 2인치가 남았다. 그래서 템플릿의 본문 영역(left 1.86)으로
 * 옮겼다. 그 뒤 **템플릿 자체를 4:3 으로 되돌려**(scripts/retarget_template_4x3.py)
 * 본문이 left 0.613 으로 내려왔고, 이 값도 따라 내려왔다.
 *
 * 교훈은 그대로다. 좌표는 다른 문서에서 옮겨 오지 않고 **쓰는 템플릿에서 잰다.**
 *
 * 높이 5.04 는 이 템플릿에서 가장 큰 표의 높이다(top 1.78 → bottom 6.82). 그보다 크면
 * 다른 장보다 아래로 삐져나온다.
 *
 * ## 상자는 꽉 채울 크기가 아니라 테두리다
 *
 * 한때 폭·높이를 그대로 넣어 사진을 상자에 맞춰 늘렸다. 두 장의 줄을 맞추려던 것인데,
 * 가로로 긴 사진이 세로로 늘어나 사람이 찌그러졌다. 지금은 파이썬이 **비율을 지켜**
 * 상자 안에 넣고 남는 자리를 가운데로 민다(scripts/build_report.py 의 fit_picture).
 * 줄은 가운데 정렬로 맞춘다.
 *
 * ## 빈 자리는 만들지 않는다
 *
 * 넣은 사진을 **순서대로** 채운다. 화면에서 두 번째 자리를 지우고 세 번째만 남겨도
 * 보고서에서는 첫 자리부터 채워진다. 빈 사진틀이 남은 보고서를 고객에게 보내는 것이
 * 가장 나쁘기 때문이다. 0장이면 슬라이드를 아예 만들지 않는다(빈 배열).
 */
import { PHOTO_SLOT_COUNT } from "./reportPhotoLimits.ts";

/** 한 슬라이드에 나란히 놓는 장수. */
export const PHOTOS_PER_SLIDE = 2;

/**
 * 템플릿 본문 영역. 12장 전부 이 자리에 표가 있다.
 *
 * 4:3(10.833in) 슬라이드에서 좌우 여백 0.613 을 뺀 나머지다. 0.613 + 9.607 = 10.220
 * 이 본문 오른쪽 끝이고, 원본 고객 보고서의 표도 정확히 거기서 끝난다.
 */
const CONTENT_LEFT = 0.613;
const CONTENT_WIDTH = 9.607;
/**
 * 두 장 사이 틈은 **없다.**
 *
 * 실제 고객 보고서의 사진 장은 큰 그림 한 장이 본문 폭을 거의 채운다(8.07×5.43in).
 * 두 장을 나란히 놓되 가운데를 맞붙이면 그 한 장처럼 보인다 — 틈이 있으면 "두 장을
 * 억지로 넣었구나" 가 먼저 보인다.
 *
 * 비율을 지키느라 남는 자리는 **바깥쪽**으로 민다(왼쪽 사진은 오른쪽 끝에, 오른쪽
 * 사진은 왼쪽 끝에 붙인다). 가운데로 밀면 둘 사이가 벌어져 붙인 뜻이 없어진다.
 */
const GAP = 0;

/** 왼쪽·오른쪽 사진의 left (인치). */
export const PHOTO_LEFT = [
  CONTENT_LEFT,
  CONTENT_LEFT + (CONTENT_WIDTH + GAP) / 2,
] as const;

/** 두 자리가 공유하는 top·폭·높이 (인치). */
export const PHOTO_TOP = 1.78;
export const PHOTO_WIDTH = (CONTENT_WIDTH - GAP) / 2;
export const PHOTO_HEIGHT = 5.04;

/** 사진 슬라이드의 구획 번호와 제목. 실제 고객 보고서가 "04" / "PaaS (1/2)" 였다. */
export const PHOTO_CHIP = "04";
export const PHOTO_TITLE = "PaaS";

export interface PhotoPlacement {
  /** 몇 번째 사진인가 (0-based, 넣은 순서). 호출부가 이 순번으로 사진을 찾는다. */
  readonly index: number;
  /** 인치. 파이썬이 Inches() 로 감싸 add_picture 에 넘긴다. */
  readonly left: number;
  /**
   * 상자 안에서 어느 쪽에 붙일 것인가. 비율을 지키면 남는 자리가 생기는데,
   * 가운데 솔기를 없애려면 왼쪽 사진은 오른쪽에, 오른쪽 사진은 왼쪽에 붙어야 한다.
   */
  readonly align: "left" | "right";
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface PhotoSlideLayout {
  /** 1-based. 제목의 "(1/2)" 에 쓴다. */
  readonly page: number;
  readonly total: number;
  readonly items: readonly PhotoPlacement[];
}

/**
 * 사진 장수를 슬라이드 배치로 옮긴다.
 *
 * 상한을 넘겨 받은 장수는 잘라낸다 — 자리가 넷뿐이라 다섯 번째를 놓을 곳이 없다.
 * 조용히 버리는 것이 아니라, 애초에 화면과 라우트가 자리 번호로 막는다
 * (lib/reportPhotoLimits.ts 의 isPhotoSlot). 여기 방어는 마지막 선이다.
 */
export function layoutPhotoSlides(count: number): PhotoSlideLayout[] {
  if (!Number.isInteger(count) || count <= 0) return [];
  const usable = Math.min(count, PHOTO_SLOT_COUNT);
  const total = Math.ceil(usable / PHOTOS_PER_SLIDE);

  const slides: PhotoSlideLayout[] = [];
  for (let page = 1; page <= total; page += 1) {
    const from = (page - 1) * PHOTOS_PER_SLIDE;
    const items: PhotoPlacement[] = [];
    for (let seat = 0; seat < PHOTOS_PER_SLIDE; seat += 1) {
      const index = from + seat;
      if (index >= usable) break;
      items.push({
        index,
        left: PHOTO_LEFT[seat] ?? PHOTO_LEFT[0],
        align: seat === 0 ? "right" : "left",
        top: PHOTO_TOP,
        width: PHOTO_WIDTH,
        height: PHOTO_HEIGHT,
      });
    }
    slides.push({ page, total, items });
  }
  return slides;
}

/** 사진 자리마다 "슬라이드 1 · 왼쪽" 처럼 어디에 들어가는지 알려주는 이름. */
export function photoSeatLabel(index: number): string {
  const page = Math.floor(index / PHOTOS_PER_SLIDE) + 1;
  const side = index % PHOTOS_PER_SLIDE === 0 ? "왼쪽" : "오른쪽";
  return `슬라이드 ${page} · ${side}`;
}
