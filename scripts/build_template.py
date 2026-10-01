# -*- coding: utf-8 -*-
"""고객 월정기보고서에서 `templates/monthly-report.pptx` 를 다시 뜬다.

    .venv/Scripts/python.exe scripts/build_template.py "<고객 월정기보고서.pptx>"

## 왜 이렇게 만드나

양식은 원래 **고객 문서가 아니었다.** 누군가 고객 보고서의 내용을 일반 PowerPoint
테마(16:9)에 붙여 만든 중간 덱이었고, 그래서 다음이 전부 조금씩 어긋났다.

* 구간 제목이 모든 장에서 "2. 이슈 및 작업 진행 사항" — 고객 문서는 장마다
  레이아웃이 달라 클라우드·라이선스는 "1. Summary", 사진 장은
  "5. 정기점검 결과 및 상세 내역" 이다
* 바닥글 글꼴이 `Rix고딕 L` — 고객 문서는 `맑은 고딕` 10.5pt
* SR 상세의 구획 번호가 `2-2` — 고객 문서는 `2-3`
* 표 폭과 열 폭, 글자 자리가 장마다 미세하게 달랐다

이 값을 하나씩 손으로 맞추는 것은 틀리기 쉽고 다음 달에 또 어긋난다. **고객 문서의
슬라이드를 그대로 가져오면** 레이아웃·마스터·열 폭·글꼴·여백이 전부 정의상 맞는다.

## 무엇을 가져오나

보고서 한 부를 만드는 데 필요한 **원형 6장**만 남긴다. 장을 번호로 고르지 않고
머리말의 제목으로 찾는다 — 달마다 SR 건수가 달라 장 번호가 움직인다.

    0 클라우드 운영 현황   (레이아웃 '본문'    → 1. Summary)
    1 라이선스 현황        (레이아웃 '본문'    → 1. Summary)
    2 SR 진행현황 요약     (레이아웃 '1_본문'  → 2. 이슈 및 작업 진행 사항)
    3 SR 상세 진행 현황    (레이아웃 '1_본문')
    4 작업 진행 현황       (레이아웃 '1_본문')
    5 정기점검 사진        (레이아웃 '4_본문'  → 5. 정기점검 결과 및 상세 내역)

이 순서는 scripts/build_report.py 의 `IDX_*` 와 짝이다. 바꾸면 그쪽도 고쳐야 한다.

## 무엇을 지우나

**이 저장소는 공개다.** 고객 문서에는 실제 케이스 번호·고객 문장·담당자 이름이
들어 있다. 생성할 때 덮어쓰는 칸은 전부 비우고, 담당자 이름 상자와 현장 사진은
도형째로 지운다.

지우지 **못하는** 것도 있다. 클라우드 운영 현황의 클러스터·호스트 수와 라이선스
현황의 계약 수량은 생성기가 덮어쓰지 않는다(그 값이 곧 보고 내용이다). 비우면
보고서가 빈 표로 나간다. 그래서 남긴다 — 양식을 새로 뜨기 전과 같은 상태다.
"""
from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

from pptx import Presentation

OUT = Path("templates/monthly-report.pptx")

PLACEHOLDER = 14
PICTURE = 13
GROUP = 6
RELS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

# 머리말의 제목 칸은 구획 번호 칸보다 훨씬 넓다. build_report.py 의 CHIP_MAX_WIDTH 와
# 같은 기준이다(그쪽은 인치, 여기는 EMU).
CHIP_MAX_WIDTH_EMU = 914400  # 1.0in

# 가져올 원형과 그 순서. (제목이 이렇게 시작하는 장, 여러 개면 몇 번째)
#
# `last` 는 마지막 장을 쓴다는 뜻이다 — 클라우드 운영 현황은 (1/2)(2/2) 두 장으로
# 나뉘고 우리가 채우는 것은 뒷장이다.
WANTED = [
    ("클라우드 운영 현황", "last"),
    ("라이선스 현황", "first"),
    ("SR 진행현황 요약", "first"),
    ("SR 상세 진행 현황", "first"),
    ("작업 진행 현황", "first"),
    ("PaaS (", "first"),          # 사진 장. 제목이 'PaaS (1/2)' 뿐이다
]

# 담당자 이름 상자. "3.PaaS – 홍길동 선임" 처럼 직급이 붙어 있다.
#
# 이름이 들어가므로 **도형째로 지운다.** 생성기가 채울 값이 아니고, 지금 쓰는
# 양식에도 없다(중간 덱을 만든 사람이 이미 뺐다).
#
# 직급 목록은 **넉넉하게** 둔다. 빠뜨리면 그 직급을 쓰는 이름이 공개 저장소로
# 그대로 들어간다 — 틀리는 방향이 한쪽으로 쏠려 있으므로 넓게 잡는 편이 맞다.
# 반대로 "운영 책임" 같은 일반 문구를 잘못 지울 수도 있는데, 그건 verify() 가
# 표 밖 글자를 전부 훑어 걸러 준다(아래 ALLOWED_TEXTS).
STAFF_PATTERN = re.compile(
    r"[가-힣]{2,4}\s*"
    r"(선임|수석|책임|전임|팀장|실장|센터장|본부장|과장|부장|차장|대리|사원|주임|매니저|연구원|프로)")

# 표 밖에 남아도 되는 글자. **이 목록에 없는 글자가 남으면 verify() 가 멈춘다.**
#
# 직급 목록에 없는 직급을 쓴 이름 상자를 잡기 위한 **독립된** 그물이다. STAFF_PATTERN
# 으로 또 확인하면 같은 구멍을 두 번 들여다보는 셈이라 의미가 없다.
#
# 실제로 이 그물이 첫 실행에서 'HPP 라이센스' 를 잡았다 — **그룹 안에** 있어서
# 그때까지의 점검에 한 번도 걸리지 않던 글자다.
#
# 다음 달 문서에 새 소제목이 생기면 여기서 멈춘다. 그게 의도다 — 사람이 그 글자가
# 공개해도 되는 것인지 보고 목록에 넣어야 한다.
ALLOWED_TEXT_PATTERNS = [
    # 머리말 구획 번호 '01' '2-1' '2-3'. 생성기가 갈아끼운다
    re.compile(r"^\d+(-\d+)?$"),
    # 기준일. set_as_of 가 보고월 말일로 갈아끼운다
    re.compile(r"^\d{4}\.\d{2}\.\d{2}\s*기준$"),
    # 머리말 제목. 생성기가 갈아끼운다
    re.compile(r"^(클라우드 운영 현황|라이선스 현황|SR 진행현황 요약|"
               r"SR 상세 진행 현황|작업 진행 현황|PaaS \()"),
    # 표 위에 붙는 고정 소제목. 대부분 그룹 안에 있다
    re.compile(r"^(PaaS|PaaS 운영 현황|HPP 라이센스|구독 라이센스)$"),
]


def title_of(slide) -> str:
    """머리말 제목 칸의 글자. 없으면 빈 문자열."""
    for shape in slide.shapes:
        if shape.shape_type != PLACEHOLDER or not shape.has_text_frame:
            continue
        if shape.width is not None and shape.width > CHIP_MAX_WIDTH_EMU:
            return shape.text_frame.text.strip()
    return ""


def pick_slides(prs) -> list:
    """WANTED 순서대로 원형 슬라이드를 고른다. 하나라도 못 찾으면 멈춘다."""
    picked = []
    for prefix, which in WANTED:
        matches = [s for s in prs.slides if title_of(s).startswith(prefix)]
        if not matches:
            raise LookupError(f"'{prefix}' 로 시작하는 장을 찾지 못했습니다")
        chosen = matches[-1] if which == "last" else matches[0]
        print(f"  고름: {prefix!r} ({which}, {len(matches)}장 중) → "
              f"{title_of(chosen)!r} / 레이아웃 {chosen.slide_layout.name!r}")
        picked.append(chosen)
    return picked


def blank_cells(table, cells) -> int:
    """지정한 칸의 글자를 비운다. 서식(글꼴·정렬·여백)은 그대로 남는다."""
    wiped = 0
    for row, col in cells:
        if row >= len(table.rows) or col >= len(table.columns):
            continue
        frame = table.cell(row, col).text_frame
        for paragraph in frame.paragraphs:
            for run in paragraph.runs:
                if run.text != "":
                    run.text = ""
                    wiped += 1
    return wiped


def walk(shapes):
    """그룹 안까지 훑는다.

    이 고객 덱은 **그룹 안에 내용을 넣는다.** 기준일 텍스트 상자가 맨 위에도 있고
    그룹 안에도 하나 더 있다(build_report.py 의 walk_shapes 가 같은 이유로 있다).
    맨 위만 보면 그룹 안의 이름 상자나 사진을 놓친 채 "깨끗하다" 고 판정한다.
    """
    for shape in shapes:
        yield shape
        if shape.shape_type == GROUP:
            yield from walk(shape.shapes)


def rel_ids_of(element) -> set:
    """이 XML 조각이 참조하는 관계 id 전부."""
    found = set()
    for node in element.iter():
        for key, value in node.attrib.items():
            if key.startswith(RELS):
                found.add(value)
    return found


def drop_shape(slide, shape) -> None:
    """도형을 지우고, **그 도형만 쓰던** 관계를 끊는다.

    관계를 남기면 그림 파일이 패키지에 그대로 남는다. 현장 사진 하나가 3.3MB 여서
    도형만 지웠을 때 양식이 5MB 가 됐다. 저장소에 들어가는 파일이라 그냥 둘 수 없다.

    ## 왜 drop_rel 에 맡기지 않나

    python-pptx 의 `drop_rel` 은 그 관계를 쓰는 곳이 남았는지 세어 보고 지운다. 그런데
    세는 것이 `r:id` 뿐이다. **그림은 `r:embed` 를 쓴다.** 그래서 같은 그림을 두
    도형이 나눠 쓰고 있어도 0개로 세고 지워 버려, 남은 도형의 그림이 깨진다. 이
    양식의 작은 PaaS 아이콘이 실제로 한 장에서 두 번(`r:embed="rId2"`) 쓰이고 있다.

    그래서 **지울 도형을 뺀 나머지**가 그 관계를 쓰는지 직접 확인한다.
    """
    doomed = rel_ids_of(shape._element)
    shape._element.getparent().remove(shape._element)

    still_used = set()
    for other in slide.shapes:
        still_used |= rel_ids_of(other._element)

    for rel_id in doomed - still_used:
        if rel_id in slide.part.rels:
            slide.part.drop_rel(rel_id)


def scrub(slide, role: str) -> tuple[int, int]:
    """공개해서는 안 되는 내용을 걷어낸다. (지운 도형 수, 비운 run 수)"""
    dropped = wiped = 0

    # 그룹 안까지 훑는다(walk 주석). 지우면서 돌면 안 되므로 먼저 목록으로 굳힌다.
    for shape in list(walk(slide.shapes)):
        if shape._element.getparent() is None:
            continue   # 그룹째로 이미 지워진 자식
        # 담당자 이름 상자
        if shape.has_text_frame and STAFF_PATTERN.search(shape.text_frame.text):
            drop_shape(slide, shape)
            dropped += 1
            continue
        # 사진 장의 현장 사진. 양식에는 빈 자리만 있으면 된다.
        if role == "photo" and shape.shape_type == PICTURE:
            drop_shape(slide, shape)
            dropped += 1

    tables = [sh.table for sh in slide.shapes if sh.has_table]
    if role == "sr_summary" and tables:
        table = tables[0]
        # 헤더(0행)를 빼고, 생성기가 쓰는 뒤 5칸을 비운다. 앞의 플랫폼·제품 칸은
        # 고정 라벨(PaaS/TAS)이라 남긴다 — 생성기가 채우지 않는다.
        cols = len(table.columns)
        wiped += blank_cells(table, [(r, c) for r in range(1, len(table.rows))
                                     for c in range(cols - 5, cols)])
    elif role == "sr_detail" and tables:
        table = tables[0]
        # 라벨 칸(0열·2열·4열)은 남기고 값 칸만 비운다.
        wiped += blank_cells(table, [(0, 1), (0, 3), (0, 5),
                                     (1, 1), (1, 3), (1, 5),
                                     (2, 1), (3, 1), (4, 1), (5, 1)])
    elif role == "work" and tables:
        table = tables[0]
        wiped += blank_cells(table, [(r, c) for r in range(1, len(table.rows))
                                     for c in range(len(table.columns))])

    return dropped, wiped


ROLES = ["cloud", "license", "sr_summary", "sr_detail", "work", "photo"]


def keep_only(prs, picked) -> None:
    """고른 장만 남기고 picked 순서대로 다시 배열한다.

    `sldIdLst` 의 순서가 곧 슬라이드 순서다. 빼는 장은 관계(rel)까지 끊어야 패키지에
    남지 않는다 — build_report.py 의 drop_slide 와 같은 방식이다.
    """
    keep_ids = [slide.slide_id for slide in picked]
    if len(set(keep_ids)) != len(keep_ids):
        raise LookupError(f"같은 장이 두 번 골렸습니다: {keep_ids}")

    lst = prs.slides._sldIdLst
    for element in list(lst):
        if int(element.get("id")) not in keep_ids:
            prs.part.drop_rel(element.get(RELS + "id"))
            lst.remove(element)

    remaining = {int(e.get("id")): e for e in list(lst)}
    for element in list(lst):
        lst.remove(element)
    for slide_id in keep_ids:
        lst.append(remaining[slide_id])


def drop_unused_layouts(prs) -> list[str]:
    """쓰지 않는 레이아웃을 뺀다. 지운 이름을 돌려준다.

    표지·간지 레이아웃이 각각 1MB 가 넘는 배경 그림을 들고 있다. 쓰지도 않는
    레이아웃 때문에 양식이 2MB 더 무거워진다.

    남기는 것은 **살아남은 장이 실제로 쓰는 레이아웃**뿐이다. 생성기는 원형 슬라이드를
    복제하므로(clone_slide) 다른 레이아웃을 새로 쓰는 일이 없다.
    """
    used = {slide.slide_layout.name for slide in prs.slides}
    removed = []
    for master in prs.slide_masters:
        for layout in list(master.slide_layouts):
            if layout.name not in used:
                master.slide_layouts.remove(layout)
                removed.append(layout.name)
    return removed


def verify(path: Path) -> None:
    """다시 뜬 양식이 생성기의 기대와 맞나."""
    prs = Presentation(str(path))
    problems: list[str] = []

    if prs.slide_width != 9906000 or prs.slide_height != 6858000:
        problems.append(f"슬라이드 크기 {prs.slide_width}x{prs.slide_height} (4:3 이 아니다)")
    if len(prs.slides) != len(ROLES):
        problems.append(f"장수 {len(prs.slides)} (기대 {len(ROLES)})")

    for index, (slide, role) in enumerate(zip(prs.slides, ROLES)):
        shapes = list(walk(slide.shapes))

        if role == "photo":
            if any(sh.shape_type == PICTURE for sh in shapes):
                problems.append(f"{index} {role}: 사진이 남았다")
            # 사진 장은 머리말 두 칸만 있어야 한다(set_section 이 폭으로 가른다).
            texted = [sh for sh in shapes if sh.has_text_frame]
            if len(texted) != 2:
                problems.append(f"{index} {role}: 글자 있는 도형이 {len(texted)}개 (기대 2)")
        else:
            if not any(sh.has_table for sh in shapes):
                problems.append(f"{index} {role}: 표가 없다")

        # 표 밖에 남은 글자를 **전부** 훑어 아는 것만 통과시킨다.
        #
        # STAFF_PATTERN 으로 또 확인하면 scrub 과 같은 구멍을 두 번 들여다보는 셈이다.
        # 직급 목록에 없는 직급을 쓴 이름 상자는 여기서 "모르는 글자" 로 걸린다.
        for shape in shapes:
            if not shape.has_text_frame:
                continue
            text = shape.text_frame.text.strip()
            if text == "":
                continue
            if not any(p.search(text) for p in ALLOWED_TEXT_PATTERNS):
                problems.append(f"{index} {role}: 모르는 글자가 남았다 {text[:40]!r}")

    # 케이스 번호 모양(8자리 숫자)이 남아 있으면 안 된다.
    leaked = []
    for index, slide in enumerate(prs.slides):
        for shape in walk(slide.shapes):
            if not shape.has_table:
                continue
            table = shape.table
            for r in range(len(table.rows)):
                for c in range(len(table.columns)):
                    if re.fullmatch(r"\d{8}", table.cell(r, c).text.strip()):
                        leaked.append(f"{index} r{r}c{c}")
    if leaked:
        problems.append("케이스 번호가 남았다: " + ", ".join(leaked))

    if problems:
        raise AssertionError("양식 검산 실패:\n  " + "\n  ".join(problems))

    print(f"  검산 통과: {len(prs.slides)}장 · "
          f"레이아웃 {[s.slide_layout.name for s in prs.slides]}")


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 1
    source = Path(argv[1])
    if not source.exists():
        print(f"원본이 없습니다: {source}", file=sys.stderr)
        return 1

    prs = Presentation(str(source))
    picked = pick_slides(prs)
    keep_only(prs, picked)

    dropped = wiped = 0
    for slide, role in zip(prs.slides, ROLES):
        d, w = scrub(slide, role)
        dropped += d
        wiped += w

    gone = drop_unused_layouts(prs)
    print(f"  레이아웃 {len(gone)}개 제거: {gone}")

    staged = OUT.with_suffix(".new.tmp.pptx")
    staged.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(staged))
    try:
        verify(staged)
    except AssertionError:
        staged.unlink(missing_ok=True)
        raise
    shutil.move(str(staged), str(OUT))

    size = OUT.stat().st_size / 1024
    print(f"완료: {OUT} ({size:.0f}KB) · 도형 {dropped}개 삭제 · 글자 {wiped}곳 비움")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
