# -*- coding: utf-8 -*-
"""양식(templates/monthly-report.pptx)의 슬라이드 크기를 16:9 → 4:3 으로 되돌린다.

**한 번 쓰고 끝나는 스크립트다.** 보고서를 만들 때 실행되지 않는다. 결과물인
양식 파일을 저장소에 커밋했고, 이 스크립트는 그 변환이 어떻게 이루어졌는지
되짚을 수 있게 남겨 둔다. 다시 돌릴 일은 양식을 원본에서 새로 뜰 때뿐이다.

왜 되돌리나
-----------
고객이 쓰는 원본 보고서(`NH은행_프라이빗 클라우드_월정기보고서_…`)는 10.833×7.5in,
즉 4:3 이다. 우리 양식은 13.333×7.5in(16:9)이었다. 같은 문서에 섞이거나 나란히
놓이면 비율이 눈에 띄게 다르다.

무엇을 어떻게 옮기나
--------------------
두 문서를 실측해 보면 16:9 양식은 4:3 원본에서 이렇게 만들어졌다.

* **본문(표·그룹·텍스트박스·그림)** — 크기를 그대로 두고 넓어진 캔버스의 **가운데로**
  옮겼다. 표 폭이 두 문서에서 9.608in 으로 똑같고 left 만 0.613 → 1.863 으로
  정확히 1.25in(= 늘어난 폭 2.5in 의 절반) 밀려 있다.
* **머리말·바닥글 같은 장식(레이아웃·마스터, 그리고 슬라이드의 개체 틀 2개)** —
  가로로 **늘렸다.** 구획번호 칸이 0.456 → 0.561, 제목 칸이 8.861 → 10.906 이고,
  둘 다 슬라이드 폭 비율(13.333/10.833)이 그대로 곱해져 있다.

그래서 되돌리는 것도 두 규칙이다. 본문은 1.25in 왼쪽으로 **옮기고**, 장식은 X 를
슬라이드 폭 비율로 **줄인다**. 확대·축소가 아니라 원래 값으로의 복원이므로 글꼴
크기는 건드리지 않는다 — 실제로 변환 결과가 원본의 좌표와 소수 셋째 자리까지 맞는다.

Y(top·height)는 손대지 않는다. 두 문서의 높이가 둘 다 7.5in 으로 같다.

물려받는 좌표는 건드리지 않는다
-------------------------------
슬라이드의 구획번호·제목 칸은 대개 **자기 좌표가 없다.** 레이아웃 값을 그대로
물려받고, python-pptx 의 `shape.left` 는 그 물려받은 값을 읽어서 보여 준다.

그래서 읽은 값을 그대로 되쓰면 안 된다. 쓰는 순간 그 도형에 `a:xfrm` 이 새로
생기는데, 우리가 X 만 주었으므로 **top·height 가 0 으로 박힌다.** 실제로 한 번
그렇게 만들어 머리말이 슬라이드 맨 위로 올라가 납작해졌다.

그러니 자기 좌표가 없는 도형은 **건너뛴다.** 레이아웃과 마스터를 어차피 줄이므로
물려받은 값도 따라 줄어든다. 표(graphicFrame)는 `a:xfrm` 이 아니라 `p:xfrm` 을
쓰므로 한쪽만 보면 '물려받음' 으로 잘못 판정된다 — 둘 다 본다.

돌리는 법
---------
    .venv/Scripts/python.exe scripts/retarget_template_4x3.py

실패하면 아무것도 쓰지 않는다. 양식을 덮어쓰기 전에 검산부터 한다.
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

from pptx import Presentation
from pptx.util import Emu

TEMPLATE = Path("templates/monthly-report.pptx")

OLD_WIDTH = 12192000   # 13.333in — 16:9
NEW_WIDTH = 9906000    # 10.833in — 4:3, 원본 고객 보고서와 같은 값
SHIFT = (OLD_WIDTH - NEW_WIDTH) // 2   # 1143000 = 1.25in

PLACEHOLDER = 14   # MSO_SHAPE_TYPE.PLACEHOLDER

A_NS = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
P_NS = "{http://schemas.openxmlformats.org/presentationml/2006/main}"

# 변환 전 양식에서 실측한 개체 틀 좌표 (left, top, width, height). 양식이 바뀌어 이
# 값이 안 맞으면 멈춘다 — 조용히 엉뚱한 곳으로 옮기는 것보다 실패하는 편이 낫다.
#
# 네 값을 다 본다. (left, width) 만 보면 높이가 다른 딴 개체 틀이 우연히 통과해
# 머리말 크기로 늘어날 수 있고, verify() 는 슬라이드 안에 들어오기만 하면 통과시킨다.
EXPECTED_PLACEHOLDERS = {
    (689702, 916800, 513155, 360364),     # 구획번호 칸 ('01', '2-2' …)
    (689703, 916800, 513156, 360364),     # 같은 칸. 1EMU 어긋난 것이 있다(사람이 만진 흔적)
    (1530224, 916800, 9972068, 360363),   # 제목 칸
    (1530224, 919024, 9972068, 360363),   # 제목 칸. top 이 조금 다른 것이 있다
    (1530224, 919025, 9972068, 360363),
}


def scaled(value: int) -> int:
    """X 좌표를 슬라이드 폭 비율로 줄인다. 장식에 쓴다."""
    return round(value * NEW_WIDTH / OLD_WIDTH)


def own_xfrm(shape):
    """이 도형 **자신의** 변환 요소. 없으면 None (레이아웃·마스터에서 물려받는다).

    물려받는 도형은 손대면 안 된다 — 근거는 파일 앞부분 주석에 있다.

    ## 왜 iter() 로 훑지 않나

    `_element.iter()` 는 **자손 전체**를 훑는다. 그룹에 쓰면 자식 도형의 xfrm 이
    먼저 걸려 "자기 좌표가 있다" 고 늘 참이 된다 — 지금 양식에서는 우연히 맞지만
    (그룹은 실제로 자기 변환을 갖는다) 판정 근거가 엉뚱하다. 직계 자식만 본다.

    표(graphicFrame)는 `p:xfrm` 을 도형 바로 아래 두고, 나머지는 `spPr`/`grpSpPr`
    안에 `a:xfrm` 을 둔다. 한쪽만 보면 표가 '물려받음' 으로 잘못 나온다.
    """
    element = shape._element
    candidates = [element.find(P_NS + "xfrm")]
    for holder in (P_NS + "spPr", P_NS + "grpSpPr"):
        found = element.find(holder)
        if found is not None:
            candidates.append(found.find(A_NS + "xfrm"))
    for xfrm in candidates:
        if xfrm is None:
            continue
        if xfrm.find(A_NS + "off") is not None and xfrm.find(A_NS + "ext") is not None:
            return xfrm
    return None


def shrink_chrome(shapes) -> int:
    """레이아웃·마스터의 장식을 X 축으로 줄인다."""
    touched = 0
    for shape in shapes:
        if own_xfrm(shape) is None:
            continue
        shape.left = Emu(scaled(int(shape.left)))
        shape.width = Emu(scaled(int(shape.width)))
        touched += 1
    return touched


def move_body(slide) -> tuple[int, int, int]:
    """슬라이드 도형을 옮긴다. 개체 틀(장식)은 줄이고 나머지(본문)는 왼쪽으로 민다.

    그룹은 자기 오프셋만 옮기면 자식이 함께 따라온다(chOff 는 그대로 두므로
    내부 배치가 흐트러지지 않는다). 표는 graphicFrame 의 off 가 곧 위치다.
    """
    chrome = body = inherited = 0
    for shape in slide.shapes:
        if own_xfrm(shape) is None:
            inherited += 1
            continue
        if shape.shape_type == PLACEHOLDER:
            key = (int(shape.left), int(shape.top), int(shape.width), int(shape.height))
            if key not in EXPECTED_PLACEHOLDERS:
                raise ValueError(
                    f"모르는 개체 틀 좌표 {key} ({shape.name!r}). 양식이 바뀌었는지 확인할 것")
            shape.left = Emu(scaled(int(shape.left)))
            shape.width = Emu(scaled(int(shape.width)))
            chrome += 1
        else:
            shape.left = Emu(int(shape.left) - SHIFT)
            body += 1
    return chrome, body, inherited


def verify(path: Path) -> None:
    """변환 결과가 4:3 안에 들어오는지 확인한다.

    본문 영역은 원본 고객 보고서에서 잰 [0.613, 10.220]in 이다. 여기를 벗어나면
    인쇄·화면에서 잘려 나가므로 통과시키지 않는다.
    """
    prs = Presentation(str(path))
    if prs.slide_width != NEW_WIDTH:
        raise AssertionError(f"슬라이드 폭이 {prs.slide_width} (기대 {NEW_WIDTH})")

    inch = 914400.0
    limit = prs.slide_width / inch
    bad: list[str] = []
    for index, slide in enumerate(prs.slides, 1):
        for shape in slide.shapes:
            left = shape.left / inch
            right = (shape.left + shape.width) / inch
            if left < -0.01 or right > limit + 0.01:
                bad.append(f"슬라이드 {index} {shape.name!r} {left:.3f}~{right:.3f}")
            # 납작해진 도형 잡기. 물려받는 개체 틀에 X 만 써 넣으면 top·height 가 0 이
            # 되어 머리말이 맨 위로 올라간다 — 한 번 그렇게 만들었다.
            if shape.height == 0 or shape.width == 0:
                bad.append(f"슬라이드 {index} {shape.name!r} 크기가 0 "
                           f"(w={shape.width} h={shape.height})")
    for layout in prs.slide_masters[0].slide_layouts:
        for shape in layout.shapes:
            if shape.left is None:
                continue
            left = shape.left / inch
            right = (shape.left + shape.width) / inch
            if left < -0.01 or right > limit + 0.01:
                bad.append(f"레이아웃 {layout.name!r} {shape.name!r} {left:.3f}~{right:.3f}")
    if bad:
        raise AssertionError("슬라이드 밖으로 나간 도형:\n  " + "\n  ".join(bad))

    table = next(sh for sh in prs.slides[0].shapes if sh.has_table)
    print(f"  검산: 표 left={table.left / inch:.3f} "
          f"right={(table.left + table.width) / inch:.3f} (원본 0.613~10.220)")


def main() -> int:
    if not TEMPLATE.exists():
        print(f"양식이 없습니다: {TEMPLATE}", file=sys.stderr)
        return 1

    prs = Presentation(str(TEMPLATE))
    if prs.slide_width == NEW_WIDTH:
        print("이미 4:3 입니다. 할 일이 없습니다.")
        return 0
    if prs.slide_width != OLD_WIDTH:
        print(f"예상 못 한 슬라이드 폭 {prs.slide_width}. 손대지 않습니다.", file=sys.stderr)
        return 1

    chrome = body = inherited = 0
    for slide in prs.slides:
        c, b, i = move_body(slide)
        chrome += c
        body += b
        inherited += i

    master = prs.slide_masters[0]
    laid = shrink_chrome(master.shapes)
    for layout in master.slide_layouts:
        laid += shrink_chrome(layout.shapes)

    prs.slide_width = NEW_WIDTH

    # 검산이 끝난 뒤에만 양식을 갈아끼운다.
    staged = TEMPLATE.with_suffix(".4x3.tmp.pptx")
    prs.save(str(staged))
    try:
        verify(staged)
    except AssertionError:
        staged.unlink(missing_ok=True)
        raise
    shutil.move(str(staged), str(TEMPLATE))

    print(f"완료. 개체 틀 {chrome}개 축소 · 본문 {body}개 이동 · "
          f"레이아웃/마스터 도형 {laid}개 축소 · "
          f"물려받아 건드리지 않은 도형 {inherited}개")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
