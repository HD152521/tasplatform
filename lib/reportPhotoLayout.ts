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
 * 실제 고객 보고서의 사진 페이지를 python-pptx 로 열어 잰 값이다. 그 양식에는 두 배치가
 * 있었다 — 전면 1장(8.5×5.43in)과 나란히 2장(3.9×5.5in, 좌 1.45 / 우 5.42). 우리는
 * 4장을 받으므로 **나란히 2장** 쪽을 쓴다.
 *
 * ## 왜 종횡비를 지키지 않고 상자를 고정하나
 *
 * 한 슬라이드에 두 장이 나란히 선다. 각 사진의 비율에 맞춰 상자를 줄이면 두 사진의
 * 크기가 서로 달라져 한쪽이 떠 보이고 아래 여백이 들쭉날쭉해진다. 실제 고객 보고서도
 * 두 장을 같은 상자에 맞춰 놓았다 — 줄을 맞추는 쪽을 택한다.
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

/** 왼쪽·오른쪽 사진의 left (인치). */
export const PHOTO_LEFT = [1.45, 5.42] as const;

/** 두 자리가 공유하는 top·폭·높이 (인치). */
export const PHOTO_TOP = 1.5;
export const PHOTO_WIDTH = 3.9;
export const PHOTO_HEIGHT = 5.5;

/** 사진 슬라이드의 구획 번호와 제목. 실제 고객 보고서가 "04" / "PaaS (1/2)" 였다. */
export const PHOTO_CHIP = "04";
export const PHOTO_TITLE = "PaaS";

export interface PhotoPlacement {
  /** 몇 번째 사진인가 (0-based, 넣은 순서). 호출부가 이 순번으로 사진을 찾는다. */
  readonly index: number;
  /** 인치. 파이썬이 Inches() 로 감싸 add_picture 에 넘긴다. */
  readonly left: number;
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
