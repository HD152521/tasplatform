"""정기점검 보고서 PPTX 생성.

회사에서 쓰던 양식(templates/monthly-report.pptx)을 그대로 열어 값만 갈아끼운다.
디자인·서식·마스터는 손대지 않는다.

  python scripts/build_report.py <입력.json> <출력.pptx>

입력 JSON 구조는 lib/pptx.ts 의 ReportPayload 와 같다.

왜 파이썬인가:
  PowerPoint 는 한 칸의 글을 여러 run 으로 잘게 쪼개 저장한다. 실제 양식에서
  "분석 및 진행 상황" 칸 하나가 48조각이었다. 문자열 치환으로는 못 찾는다.
  python-pptx 는 그 구조를 다루므로 첫 run 의 서식을 지키면서 안전하게 바꿀 수 있다.
"""
import base64
import copy
import io
import json
import sys
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.util import Inches

RELS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

# 보고월 기준 미종료 SR 의 "완료 여부" 강조색.
RED = RGBColor(0xFF, 0x00, 0x00)

# 템플릿에서 각 구획이 시작하는 위치 (0-based)
IDX_CLOUD = 0        # 01 클라우드 운영 현황
IDX_LICENSE = 1      # 2-1 라이선스 현황 — TAS App Service 실 운영 현황 3칸만 갱신
IDX_SR_SUMMARY = 2   # 01 SR 진행현황 요약
IDX_SR_DETAIL = 3    # 2-2 SR 상세 (원본 1장)
IDX_WORK = 9         # 3-3 작업 진행 현황 (원본 1장)

WORK_ROWS_PER_SLIDE = 8   # 실제 양식이 한 장에 8행까지 담고 있다

# 사진 슬라이드를 **어떻게 만들지** — 작업 슬라이드를 복제해 표만 걷어낸다.
#
# 우리 양식(templates/monthly-report.pptx)에는 사진 슬라이드가 없다. 만드는 길이 둘이었다.
#
#   (1) 레이아웃에서 새 슬라이드를 추가한다 → 머리말(구획 번호 칸·제목 칸·그 아래
#       `• PaaS` 그룹)이 따라오지 않는다. 양식의 다른 장과 머리말이 다른 장이 끼어
#       티가 난다. 마스터의 '그림 및 캡션' 레이아웃도 우리 양식의 머리말과 모양이 다르다.
#   (2) 기존 장을 복제해 내용(표)만 걷어낸다 → 머리말·밑줄·글꼴이 그대로 남는다.
#
# 그래서 (2)를 쓴다. 복제 원본은 **작업 슬라이드**다. SR 상세 장에는 "2026.08.31 기준"
# 같은 날짜 텍스트 상자가 따로 붙어 있어 걷어낼 것이 하나 더 늘고, 작업 장에는 그게 없다.
IDX_PHOTO_PROTO = IDX_WORK

# 구획 번호 칸을 제목 칸과 구별하는 기준.
# 양식의 두 칸은 각각 0.56인치와 10.91인치라 폭 하나로 확실히 갈린다.
# 텍스트("3-3")로 찾으면 양식에서 그 글자가 바뀌는 순간 조용히 어긋난다.
CHIP_MAX_WIDTH = Inches(1)


# --------------------------------------------------------------------------
# 슬라이드 조작
# --------------------------------------------------------------------------

def rewire_rels(src, dst):
    """복제한 도형이 가리키는 관계(그림 등)를 새 슬라이드에도 걸어 준다.

    ## 왜 필요한가 — 실측으로 확인한 것

    도형 XML 안의 그림은 `r:embed="rId2"` 처럼 **그 슬라이드의 관계 번호**로 그림을
    가리킨다. XML 만 복사하면 번호는 따라오지만 관계는 안 따라온다. 새 슬라이드에는
    rId1(레이아웃)뿐이라 rId2 가 허공을 가리킨다.

    양식의 SR 상세·작업 슬라이드에는 "그림이 없다" 고 적혀 있었지만, 머리말의 작은
    그룹(`• PaaS`) 안에 0.21인치짜리 아이콘 그림이 들어 있었다. 실제로 만든 파일을
    풀어 보니 복제된 장마다 rId2 가 **없는 관계**를 가리키고 있었다.

    사진 슬라이드에서는 이게 더 나빠진다. add_picture 가 rId2 를 새로 만들어 쓰므로,
    아이콘 자리에 **사진 1번이 0.21인치로 쪼그라들어** 박힌다. 그래서 복제 직후,
    사진을 붙이기 전에 관계를 옮겨 붙인다.
    """
    moved = {}
    for element in dst.shapes._spTree.iter():
        for attr in (RELS + "embed", RELS + "link", RELS + "id"):
            old = element.get(attr)
            if old is None:
                continue
            if old not in moved:
                rel = src.part.rels[old]
                moved[old] = (
                    dst.part.relate_to(rel.target_ref, rel.reltype, is_external=True)
                    if rel.is_external
                    else dst.part.relate_to(rel.target_part, rel.reltype)
                )
            element.set(attr, moved[old])


def clone_slide(prs, src):
    """슬라이드를 통째로 복제해 맨 뒤에 붙인다.

    python-pptx 에 공식 복제 기능이 없어 도형 XML 을 그대로 옮긴 뒤,
    그 도형들이 가리키는 관계를 다시 걸어 준다(rewire_rels 주석에 근거).
    """
    dst = prs.slides.add_slide(src.slide_layout)
    for shape in list(dst.shapes):
        shape._element.getparent().remove(shape._element)
    for shape in src.shapes:
        dst.shapes._spTree.append(copy.deepcopy(shape._element))
    rewire_rels(src, dst)
    return dst


def slide_ids(prs):
    return list(prs.slides._sldIdLst)


def drop_slide(prs, element):
    """슬라이드 하나를 문서에서 뺀다."""
    rel_id = element.get(RELS + "id")
    prs.part.drop_rel(rel_id)
    prs.slides._sldIdLst.remove(element)


def reorder(prs, order):
    """order 에 담긴 sldId 요소 순서대로 다시 배열한다."""
    lst = prs.slides._sldIdLst
    for element in list(lst):
        lst.remove(element)
    for element in order:
        lst.append(element)


# --------------------------------------------------------------------------
# 텍스트 채우기
# --------------------------------------------------------------------------

# "분석 및 진행 상황" 칸의 글머리 기호.
#
# 실제 보고서(8월_정기점검_보고서.pptx, slide5)를 풀어 확인한 값 그대로다.
#   제목 줄("질의 내용", "진행 상황")  : Arial 의 • , marL 88900  / indent -88900
#   그 아래 줄글                       : Wingdings 의 ü(체크), marL 357188 / indent -171450
# set_text 가 첫 문단을 복제하는 구조라, 손대지 않으면 모든 줄이 첫 문단의 • 를
# 물려받는다. 그래서 줄마다 따로 지정한다.
BULLET_HEAD = ("Arial", "•", 88900, -88900)
BULLET_ITEM = ("Wingdings", "ü", 357188, -171450)

# 제목으로 볼 줄. 모델이 콜론이나 공백을 붙여 오는 일이 있어 느슨하게 맞춘다.
ANALYSIS_HEADINGS = ("질의내용", "진행상황")


def _is_heading(line):
    key = line.strip().rstrip(":：").replace(" ", "")
    return key in ANALYSIS_HEADINGS


def analysis_bullet(line):
    """분석 칸의 한 줄에 쓸 글머리. set_text 의 bullets 인자로 넘긴다."""
    return BULLET_HEAD if _is_heading(line) else BULLET_ITEM


def apply_bullet(paragraph, spec):
    """문단의 글머리 기호를 지정한 것으로 바꾼다.

    a:pPr 의 자식 순서가 스키마로 정해져 있어(… buFont, buChar, tabLst, defRPr …)
    아무 데나 붙이면 PowerPoint 가 파일을 못 연다. 기존 글머리 요소를 걷어낸 뒤
    tabLst/defRPr 앞에 끼워 넣는다.
    """
    from pptx.oxml.ns import qn

    typeface, char, mar_l, indent = spec
    pPr = paragraph._p.get_or_add_pPr()
    pPr.set("marL", str(mar_l))
    pPr.set("indent", str(indent))

    for tag in ("a:buNone", "a:buChar", "a:buAutoNum", "a:buFont"):
        for node in pPr.findall(qn(tag)):
            pPr.remove(node)

    anchor = None
    for tag in ("a:tabLst", "a:defRPr", "a:extLst"):
        found = pPr.find(qn(tag))
        if found is not None:
            anchor = found
            break

    bu_font = pPr.makeelement(qn("a:buFont"), {"typeface": typeface})
    bu_char = pPr.makeelement(qn("a:buChar"), {"char": char})
    if anchor is None:
        pPr.append(bu_font)
        pPr.append(bu_char)
    else:
        anchor.addprevious(bu_font)
        anchor.addprevious(bu_char)


def set_text(frame, text, bullets=None):
    """텍스트를 갈아끼우되 첫 run 의 서식(글꼴·크기·색)을 그대로 쓴다.

    한 칸이 수십 개 run 으로 쪼개져 있어도 첫 run 만 남기고 지운 뒤 채운다.
    여러 줄이면 첫 문단을 복제해 같은 서식을 유지한다.

    bullets 를 주면 줄마다 불러 글머리 기호를 정한다(줄 -> spec 또는 None).
    """
    from pptx.text.text import _Paragraph

    text = "" if text is None else str(text)
    lines = text.split("\n")

    paragraphs = list(frame.paragraphs)
    first = paragraphs[0]

    # 첫 문단만 남긴다
    for extra in paragraphs[1:]:
        extra._p.getparent().remove(extra._p)

    def fill(paragraph, value):
        runs = list(paragraph.runs)
        if runs:
            runs[0].text = value
            for run in runs[1:]:
                run._r.getparent().remove(run._r)
        else:
            paragraph.text = value

    fill(first, lines[0])
    written = [first]
    for line in lines[1:]:
        clone = copy.deepcopy(first._p)
        first._p.getparent().append(clone)
        # 복제한 문단의 run 을 새 값으로
        paragraph = _Paragraph(clone, first._parent)
        fill(paragraph, line)
        written.append(paragraph)

    if bullets is not None:
        for paragraph, line in zip(written, lines):
            spec = bullets(line)
            if spec is not None:
                apply_bullet(paragraph, spec)


def cell_text(table, row, col, value, bullets=None):
    """표의 한 칸을 채운다. 범위를 벗어나면 조용히 넘어가지 않고 알린다."""
    if row >= len(table.rows) or col >= len(table.columns):
        raise IndexError(f"표 범위를 벗어남: ({row},{col}) / {len(table.rows)}x{len(table.columns)}")
    set_text(table.cell(row, col).text_frame, value, bullets)


def color_cell(table, row, col, rgb):
    """한 칸의 모든 run 글자색을 바꾼다. set_text 로 채운 뒤 호출한다."""
    frame = table.cell(row, col).text_frame
    for paragraph in frame.paragraphs:
        for run in paragraph.runs:
            run.font.color.rgb = rgb


def first_table(slide):
    for shape in slide.shapes:
        if shape.has_table:
            return shape.table
    raise LookupError("표가 없는 슬라이드")


def tables(slide):
    return [s.table for s in slide.shapes if s.has_table]


def replace_in_texts(slide, old, new):
    """슬라이드의 모든 텍스트에서 문자열을 바꾼다. 쪼개진 run 을 합쳐 비교한다."""
    for shape in slide.shapes:
        if not shape.has_text_frame:
            continue
        for paragraph in shape.text_frame.paragraphs:
            joined = "".join(r.text for r in paragraph.runs)
            if old in joined:
                runs = list(paragraph.runs)
                if runs:
                    runs[0].text = joined.replace(old, new)
                    for run in runs[1:]:
                        run._r.getparent().remove(run._r)


def set_page_no(slide, current, total):
    """제목의 "(1/6)" 같은 쪽 번호를 갱신한다."""
    import re
    for shape in slide.shapes:
        if not shape.has_text_frame:
            continue
        for paragraph in shape.text_frame.paragraphs:
            joined = "".join(r.text for r in paragraph.runs)
            if re.search(r"\(\s*\d+\s*/\s*\d+\s*\)", joined):
                fixed = re.sub(r"\(\s*\d+\s*/\s*\d+\s*\)", f"({current}/{total})", joined)
                runs = list(paragraph.runs)
                runs[0].text = fixed
                for run in runs[1:]:
                    run._r.getparent().remove(run._r)
                return


# --------------------------------------------------------------------------
# 표 행 늘리기 / 줄이기
# --------------------------------------------------------------------------

def resize_rows(table, keep_header, wanted):
    """데이터 행 수를 wanted 로 맞춘다.

    늘릴 때는 마지막 데이터 행을 복제한다 — 서식과 병합 상태를 그대로 물려받는다.
    """
    tbl = table._tbl
    rows = tbl.findall(
        "{http://schemas.openxmlformats.org/drawingml/2006/main}tr")
    have = len(rows) - keep_header
    if wanted == have:
        return
    if wanted < have:
        for element in rows[keep_header + wanted:]:
            tbl.remove(element)
        return
    template_row = rows[-1]
    for _ in range(wanted - have):
        tbl.append(copy.deepcopy(template_row))


# --------------------------------------------------------------------------
# 구획별 채우기
# --------------------------------------------------------------------------

def fill_cloud(slide, data, month_label):
    """01 클라우드 운영 현황."""
    table = first_table(slide)
    replace_in_texts(slide, table.cell(0, 2).text.strip(), f"{month_label} (누적)")

    # 행 2~7 = 여섯 구분, 행 8 = 합계
    for offset, row in enumerate(data["rows"]):
        r = 2 + offset
        cell_text(table, r, 4, row["container"])
        cell_text(table, r, 5, row["note"])
        cell_text(table, r, 8, row["delta"])

    total = data["total"]
    cell_text(table, 8, 2, total["cluster"])
    cell_text(table, 8, 3, total["host"])
    cell_text(table, 8, 4, total["container"])
    cell_text(table, 8, 8, total["delta"])


def fill_license(slide, values):
    """2-1 라이선스 현황 중 TAS App Service 행의 "실 운영 현황" 세 칸만 바꾼다.

    나머지 칸과 다른 제품 행은 양식 그대로 둔다.
    행 위치를 숫자로 박지 않고 제품명으로 찾는다 — 양식에 행이 추가돼도 버틴다.
    """
    for table in tables(slide):
        top = [table.cell(0, c).text.strip() for c in range(len(table.columns))]
        header = [table.cell(1, c).text.strip() for c in range(len(table.columns))]
        if "실 운영 현황" not in top:
            continue
        # "은행/중앙회/합계" 는 구독 계약 현황 아래에도 있다.
        # 반드시 "실 운영 현황" 이 시작하는 열부터 찾아야 구독 값을 덮어쓰지 않는다.
        start = top.index("실 운영 현황")
        try:
            bank = header.index("은행", start)
            central = header.index("중앙회", bank + 1)
            total = header.index("합계", central + 1)
        except ValueError:
            continue
        for r in range(len(table.rows)):
            names = " ".join(table.cell(r, c).text for c in range(3))
            if "TAS App Service" in names:
                cell_text(table, r, bank, values["bank"])
                cell_text(table, r, central, values["central"])
                cell_text(table, r, total, values["total"])
                return True
    return False


def fill_sr_summary(slide, items):
    """01 SR 진행현황 요약. 헤더 1행 + SR 수만큼."""
    table = first_table(slide)
    resize_rows(table, keep_header=1, wanted=len(items))

    for offset, sr in enumerate(items):
        r = 1 + offset
        cols = len(table.rows[r].cells)
        # 첫 행은 플랫폼·제품 칸이 살아 있고, 이어지는 행은 세로 병합으로 빠진다.
        base = cols - 5
        cell_text(table, r, base + 0, sr["no"])
        cell_text(table, r, base + 1, sr["openedOn"])
        cell_text(table, r, base + 2, sr["title"])
        cell_text(table, r, base + 3, sr["progress"])
        cell_text(table, r, base + 4, sr["done"])
        # 보고월 기준 미종료 SR 은 완료 여부를 빨간 글씨로 강조한다.
        if sr.get("open") == "1":
            color_cell(table, r, base + 4, RED)


def fill_sr_detail(slide, sr):
    """2-2 SR 상세 한 장."""
    table = first_table(slide)
    cell_text(table, 0, 1, sr["product"])
    cell_text(table, 0, 3, sr["no"])
    cell_text(table, 0, 5, sr["severity"])
    cell_text(table, 1, 1, sr["openedOn"])
    cell_text(table, 1, 3, sr["closedOn"])
    cell_text(table, 1, 5, sr["status"])
    cell_text(table, 2, 1, sr["title"])
    cell_text(table, 3, 1, sr["symptom"])
    # 제목 줄은 •, 그 아래 줄글은 체크(ü). 실제 보고서가 그렇게 돼 있다.
    cell_text(table, 4, 1, sr["analysis"], analysis_bullet)
    cell_text(table, 5, 1, sr["result"])


def set_section(slide, chip, title):
    """머리말의 구획 번호 칸과 제목 칸을 갈아끼운다.

    두 칸은 폭으로 가른다(CHIP_MAX_WIDTH 주석). 표를 이미 걷어낸 뒤에 부르므로
    글자가 들어가는 도형은 이 둘뿐이다.

    못 찾으면 **조용히 넘기지 않는다.** 제목을 못 바꾸면 사진 장에 "작업 진행 현황"
    이라고 적힌 보고서가 나가고, 그건 파일을 열어 보기 전까지 아무도 모른다.
    """
    chips = []
    titles = []
    for shape in slide.shapes:
        if not shape.has_text_frame or shape.width is None:
            continue
        (chips if shape.width <= CHIP_MAX_WIDTH else titles).append(shape)

    if len(chips) != 1 or len(titles) != 1:
        raise LookupError(
            f"사진 장의 머리말을 찾지 못했습니다 (구획 {len(chips)}개 / 제목 {len(titles)}개)")

    set_text(chips[0].text_frame, chip)
    set_text(titles[0].text_frame, title)


def fill_photos(slide, chip, title, items):
    """정기점검 사진 한 장.

    받은 좌표(인치)에 그대로 놓는다. **어디에 놓을지는 파이썬이 정하지 않는다** —
    lib/reportPhotoLayout.ts 가 정해 payload 로 넘긴다(반올림을 전부 TS 에 두는 것과
    같은 이유다. 규칙이 한 곳에 있고 그쪽에서 단위테스트로 잠긴다).

    폭·높이를 둘 다 주므로 사진은 상자에 맞춰 늘어난다. 종횡비를 지키지 않는 근거는
    lib/reportPhotoLayout.ts 머리말에 적었다 — 나란한 두 장의 크기가 달라지면 줄이
    안 맞아 한쪽이 떠 보인다. 실제 고객 보고서도 같은 상자에 맞춰 놓았다.
    """
    # 본문(표)을 걷어내 머리말만 남긴다. 복제 원본이 작업 슬라이드이기 때문이다.
    #
    # 머리말 아래의 작은 그룹(`• PaaS`)은 일부러 남겨 둔다. 사진이 top 1.5 에서
    # 시작해 그 줄(1.54~1.77)을 덮으므로 화면에는 보이지 않고, 그룹의 내용이 전부
    # 왼쪽에 몰려 있어 사진 밖으로 삐져나오는 조각도 없다(실제로 만들어 확인함).
    # 양식에서 덜 걷어낼수록 나중에 양식이 바뀔 때 어긋날 곳이 적다.
    for shape in list(slide.shapes):
        if shape.has_table:
            shape._element.getparent().remove(shape._element)

    set_section(slide, chip, title)

    for item in items:
        raw = base64.b64decode(item["data"])
        if not raw:
            # 빈 사진은 여기까지 오지 않는다(lib/reportPhotoLimits.ts 가 막는다).
            # 그래도 닿았다면 조용히 넘기지 않고 알린다 — 빈 자리가 남은 보고서가
            # 나가는 것보다 실패하는 편이 낫다.
            raise ValueError("사진 데이터가 비어 있습니다")
        fit_picture(slide, raw, item)


def fit_picture(slide, raw, box):
    """사진을 상자 안에 **비율 그대로** 넣는다. 가운데 정렬.

    처음에는 폭·높이를 둘 다 지정해 넣었다. 그러면 가로로 긴 사진이 세로 상자에
    맞춰 늘어나 사람이 찌그러져 보인다 — 보고서에 그대로 나갔다.

    python-pptx 는 폭만 주면 원본 비율로 높이를 계산한다. 그렇게 넣어 보고 높이가
    상자를 넘으면 높이 기준으로 다시 넣는다. 둘 중 **작은 쪽에 맞추는** 것이
    상자 밖으로 안 나가면서 비율을 지키는 유일한 방법이다.

    남는 자리는 가운데로 민다. 두 장이 나란히 설 때 위아래 기준선이 맞아야
    한쪽만 떠 보이지 않는다.
    """
    left, top = box["left"], box["top"]
    max_w, max_h = box["width"], box["height"]

    picture = slide.shapes.add_picture(io.BytesIO(raw), Inches(left), Inches(top), Inches(max_w))
    if picture.height > Inches(max_h):
        # 넘친다 — 높이 기준으로 다시 넣는다. 지우고 다시 넣는 편이 크기를 직접
        # 계산하는 것보다 확실하다(python-pptx 가 원본 비율을 알고 있다).
        picture._element.getparent().remove(picture._element)
        picture = slide.shapes.add_picture(io.BytesIO(raw), Inches(left), Inches(top), None, Inches(max_h))

    picture.left = Inches(left) + int((Inches(max_w) - picture.width) / 2)
    picture.top = Inches(top) + int((Inches(max_h) - picture.height) / 2)


def fill_work(slide, rows):
    """3-3 작업 진행 현황 한 장."""
    table = first_table(slide)
    resize_rows(table, keep_header=1, wanted=len(rows))
    for offset, row in enumerate(rows):
        r = 1 + offset
        cell_text(table, r, 0, row["center"])
        cell_text(table, r, 1, row["corp"])
        cell_text(table, r, 2, row["span"])
        cell_text(table, r, 3, row["support"])
        cell_text(table, r, 4, row["title"])
        cell_text(table, r, 5, row["issue"])
        cell_text(table, r, 6, row["note"])


# --------------------------------------------------------------------------

def chunk(items, size):
    return [items[i:i + size] for i in range(0, len(items), size)] or [[]]


def build(payload, template_path, out_path):
    prs = Presentation(template_path)
    ids = slide_ids(prs)
    slides = list(prs.slides)

    sr_items = payload["srs"]
    work_pages = chunk(payload["work"], WORK_ROWS_PER_SLIDE)
    # 사진은 없을 수 있다. 빈 목록이면 사진 슬라이드를 **한 장도** 만들지 않는다 —
    # 빈 사진틀이 남은 보고서를 고객에게 보내는 것이 가장 나쁘다.
    photo_pages = payload.get("photos") or []

    # 원본으로 쓸 슬라이드
    sr_proto = slides[IDX_SR_DETAIL]
    work_proto = slides[IDX_WORK]
    photo_proto = slides[IDX_PHOTO_PROTO]

    # 1) 고정 구획 채우기
    fill_cloud(slides[IDX_CLOUD], payload["cloud"], payload["monthLabel"])
    if payload.get("license"):
        if not fill_license(slides[IDX_LICENSE], payload["license"]):
            print("경고: 라이선스 표에서 TAS App Service 행을 찾지 못했습니다.", file=sys.stderr)
    fill_sr_summary(slides[IDX_SR_SUMMARY], sr_items)

    # 2) SR 상세 · 작업 슬라이드를 필요한 수만큼 새로 만든다
    made_sr = []
    for i, sr in enumerate(sr_items, 1):
        slide = clone_slide(prs, sr_proto)
        fill_sr_detail(slide, sr)
        set_page_no(slide, i, len(sr_items))
        made_sr.append(slide)

    made_work = []
    for i, rows in enumerate(work_pages, 1):
        slide = clone_slide(prs, work_proto)
        fill_work(slide, rows)
        set_page_no(slide, i, len(work_pages))
        made_work.append(slide)

    # 사진은 구획 04 라 작업(3-3) 뒤에 온다. 실제 고객 보고서도 그 자리였다.
    made_photo = []
    for page in photo_pages:
        slide = clone_slide(prs, photo_proto)
        fill_photos(slide, page["chip"], page["title"], page["items"])
        made_photo.append(slide)

    # 3) 원본 슬라이드들을 걷어내고 순서를 다시 잡는다
    new_ids = slide_ids(prs)
    made_ids = new_ids[len(ids):]
    keep_front = [ids[IDX_CLOUD], ids[IDX_LICENSE], ids[IDX_SR_SUMMARY]]
    made_sr_ids = made_ids[:len(made_sr)]
    made_work_ids = made_ids[len(made_sr):len(made_sr) + len(made_work)]
    made_photo_ids = made_ids[len(made_sr) + len(made_work):]

    for element in ids[IDX_SR_DETAIL:]:
        drop_slide(prs, element)

    reorder(prs, keep_front + made_sr_ids + made_work_ids + made_photo_ids)

    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    prs.save(out_path)
    return len(prs.slides._sldIdLst)


def main():
    if len(sys.argv) != 3:
        print("사용법: build_report.py <입력.json> <출력.pptx>", file=sys.stderr)
        return 1
    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    template = payload.get("template") or "templates/monthly-report.pptx"
    count = build(payload, template, sys.argv[2])
    print(json.dumps({"ok": True, "slides": count, "out": sys.argv[2]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
