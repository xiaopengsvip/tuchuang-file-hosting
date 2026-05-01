#!/usr/bin/env python3
"""Local free media moderation scanner for tuchuang.

This script intentionally has a tiny JSON contract so the Node server can call it
without depending on a paid API. If NudeNet is installed in the configured Python
environment, it detects exposed sexual content in images/frames. Video support is
provided by the Node server through ffmpeg frame extraction.
"""
import json
import os
import sys

SEXUAL_CLASSES = {
    "FEMALE_GENITALIA_EXPOSED",
    "MALE_GENITALIA_EXPOSED",
    "FEMALE_BREAST_EXPOSED",
    "ANUS_EXPOSED",
    "BUTTOCKS_EXPOSED",
}


def main(paths):
    threshold = float(os.environ.get("NUDENET_THRESHOLD", "0.62"))
    try:
        from nudenet import NudeDetector  # type: ignore
    except Exception as exc:
        print(json.dumps({
            "available": False,
            "blocked": False,
            "categories": [],
            "provider": "nudenet",
            "error": f"nudenet_unavailable:{type(exc).__name__}",
        }, ensure_ascii=False))
        return 0

    detector = NudeDetector()
    blocked = False
    frames = []
    for p in paths:
        try:
            detections = detector.detect(p)
        except Exception as exc:
            frames.append({"path": p, "error": type(exc).__name__, "blocked": False, "score": 0})
            continue
        hits = []
        max_score = 0.0
        for item in detections or []:
            label = str(item.get("class") or item.get("label") or "")
            score = float(item.get("score") or 0)
            max_score = max(max_score, score)
            if label in SEXUAL_CLASSES and score >= threshold:
                hits.append({"class": label, "score": round(score, 4)})
        if hits:
            blocked = True
        frames.append({
            "path": p,
            "blocked": bool(hits),
            "score": round(max_score, 4),
            "hits": hits[:5],
        })

    print(json.dumps({
        "available": True,
        "blocked": blocked,
        "categories": ["sexual"] if blocked else [],
        "categoryLabels": ["色情低俗"] if blocked else [],
        "provider": "nudenet",
        "frames": frames[:80],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
