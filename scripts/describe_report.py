# -*- coding: utf-8 -*-
"""만들어진 보고서를 재서 JSON 으로 찍는다. 읽기만 한다.

`scripts/build_report.py` 의 결과가 맞는지 확인하는 용도다. 사람이 열어 보고
"사진이 좀 벌어진 것 같다" 를 판단하는 대신 숫자를 본다 — 실제로 눈으로만 보다가
가운데가 1인치 벌어진 보고서와 지난달 바닥글이 달린 보고서를 배포했다.

    .venv/Scripts/python.exe scripts/describe_report.py 보고서.pptx

test/reportBuildPptx.test.ts 가 이걸 불러 결과를 검사한다. 출력 모양을 바꾸면
그 시험도 같이 고쳐야 한다.
"""
from __future__ import annotations

import json
import re
import sys

from pptx import Presentation

EMU_PER_INCH = 914400.0
PICTURE = 13   # MSO_SHAPE_TYPE.PICTURE

# 달·기준일이 박혀 있던 자리를 찾는 모양. build_report.py 의 두 패턴과 짝이다.
LABEL_PATTERN = re.compile(r"\d{4}\s*년\s*\d{1,2}\s*월|\d{4}\.\d{2}\.\d{2}\s*기준")


def inches(value: int) -> float:
    return round(value / EMU_PER_INCH, 3)


def labels_of(slide) -> list[str]:
    """이 장에 보이는 달·기준일 문구. 레이아웃에 있는 것까지 포함한다.

    바닥글은 슬라이드가 아니라 **레이아웃**에 있다. 슬라이드만 보면 못 찾는다 —
    그래서 지난달 라벨이 12장에 그대로 붙어 나갔다.
    """
    found = set()
    for shapes in (slide.shapes, slide.slide_layout.shapes):
        for shape in shapes:
            if not shape.has_text_frame:
                continue
            text = shape.text_frame.text.strip()
            if LABEL_PATTERN.search(text):
                found.add(text)
    return sorted(found)


def describe(path: str) -> dict:
    prs = Presentation(path)
    slides = []
    for slide in prs.slides:
        photos = [
            {
                "left": inches(shape.left),
                "top": inches(shape.top),
                "width": inches(shape.width),
                "height": inches(shape.height),
            }
            for shape in slide.shapes
            if shape.shape_type == PICTURE
        ]
        slides.append({"photos": photos, "labels": labels_of(slide)})
    return {
        "slideWidth": inches(prs.slide_width),
        "slideHeight": inches(prs.slide_height),
        "slides": slides,
    }


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("사용법: describe_report.py <보고서.pptx>", file=sys.stderr)
        return 1
    # Windows 기본 출력 인코딩이 cp949 라 한글 라벨이 깨져 나간다. 부르는 쪽은 UTF-8
    # 로 읽으므로 글자가 뭉개져도 **오류 없이** 엉뚱한 문자열이 전달된다 — 실제로
    # 시험이 "라벨을 못 찾았다" 로 헛돌았다. 여기서 UTF-8 로 못 박는다.
    sys.stdout.reconfigure(encoding="utf-8")
    json.dump(describe(argv[1]), sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
