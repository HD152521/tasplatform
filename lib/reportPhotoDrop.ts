/**
 * 끌어다 놓은 사진을 어느 자리에 넣을지 — 판단만 한다.
 *
 * ## 왜 화면에서 떼어 두나
 *
 * lib/reportPhotoLayout.ts 가 배치를 떼어 둔 것과 같은 이유다. 이 판단이 틀려도
 * **화면은 멀쩡해 보인다** — 네 장을 놓았는데 셋만 들어가거나, 자리를 집어 놓았는데
 * 엉뚱한 칸이 바뀌어도 그 자리에서는 그럴듯하다. 틀린 것은 보고서가 나온 뒤에
 * 드러난다. 그래서 규칙을 여기 두고 단위시험으로 잠근다.
 *
 * DOM 을 모른다. File 대신 이름과 형식만 보므로 브라우저 없이 시험할 수 있다.
 */
import { PHOTO_MIMES } from "./reportPhotoLimits.ts";

/** 자리 하나의 상태. 화면의 Seat 에서 판단에 필요한 것만 추린 것. */
export interface SeatState {
  readonly slot: number;
  readonly filled: boolean;
}

/** 형식을 가릴 때 보는 것. File 이 이 모양을 만족한다. */
export interface NamedFile {
  readonly name: string;
  readonly type: string;
}

/**
 * 받을 수 있는 것과 아닌 것을 가른다. 못 받는 것은 **이름**으로 돌려준다.
 *
 * 파일 고르기 창은 accept 로 걸러 주지만 **끌어다 놓기에는 그 장치가 없다.**
 * JPEG·PNG 만 받는 이유는 reportPhotoLimits.ts 의 PHOTO_MIMES 주석에 있다 —
 * 입구에서 거르지 않으면 보고서를 만드는 **며칠 뒤** 다른 사람 앞에서 터진다.
 *
 * 돌려주는 left 는 이름이다. 무엇이 빠졌는지 사람에게 말해 주려는 것이고,
 * 말해 주지 않으면 그 한 장은 보고서가 나온 뒤에야 비어 있는 것이 보인다.
 */
export function splitByPhotoMime<T extends NamedFile>(
  files: readonly T[],
): { taken: T[]; left: string[] } {
  const taken: T[] = [];
  const left: string[] = [];
  for (const file of files) {
    if ((PHOTO_MIMES as readonly string[]).includes(file.type)) taken.push(file);
    else left.push(file.name);
  }
  return { taken, left };
}

/**
 * 사진 여러 장을 받을 자리를, 받는 순서대로.
 *
 * 규칙이 둘이다.
 *   칸 바깥에 놓으면  → **빈 자리만** 앞에서부터. 들어 있는 사진을 건드리지 않는다.
 *   자리 위에 놓으면  → 그 자리부터 아래로. 이미 든 사진도 바꿔치운다 —
 *                       자리를 집어 놓은 것은 "여기에 이걸" 이라는 뜻이다.
 *
 * 놓은 장수가 남은 자리보다 많으면 **들어가는 만큼만** 돌려준다. 몇 장이 남았는지는
 * 부른 쪽이 길이를 비교해 알아내고 사람에게 말한다.
 */
export function dropTargetSlots(
  seats: readonly SeatState[],
  count: number,
  firstSlot?: number,
): number[] {
  const picked = firstSlot === undefined
    ? seats.filter((s) => !s.filled)
    : seats.filter((s) => s.slot >= firstSlot);
  return picked.slice(0, Math.max(0, count)).map((s) => s.slot);
}
