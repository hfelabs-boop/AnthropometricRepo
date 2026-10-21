"""Builds a body.adversarial.shots.py job: python3 tests/human3d/body.adversarial.job.py <kind> <out.json> [args]
kinds: people (front, 3/4, side, back of N bodies), head (close-ups), hands, feet, pose <name> (bodies x poses)"""
import json
import sys

PEOPLE = {
    "man50": {"pop": "united-states/army/M", "pct": 50}, "woman50": {"pop": "united-states/army/F", "pct": 50},
    "woman5": {"pop": "united-states/army/F", "pct": 5}, "man95": {"pop": "united-states/army/M", "pct": 95},
    "man5": {"pop": "united-states/army/M", "pct": 5}, "woman95": {"pop": "united-states/army/F", "pct": 95},
    "heavy": {"sex": "M", "stature": 1780, "mass": 150}, "thin": {"sex": "M", "stature": 1780, "mass": 52},
    "heavyF": {"sex": "F", "stature": 1650, "mass": 130}, "thinF": {"sex": "F", "stature": 1700, "mass": 45},
    "tall": {"sex": "M", "stature": 2050, "mass": 120}, "short": {"sex": "F", "stature": 1450, "mass": 42},
    "neutral": {"sex": "both", "stature": 1700, "mass": 70},
}


def people(names, azs=(0, 35, 90, 180), W=1000, H=700, el=4):
    cells = []
    n = len(names)
    cw = W // len(azs)
    rh = H // n
    for i, k in enumerate(names):
        for j, az in enumerate(azs):
            c = {"view": {"rect": [j * cw, i * rh, cw, rh], "az": az, "el": el, "dist": 4.6 if n > 2 else 4.2, "target": [0, 0.9, 0]}}
            if j == 0:
                c["body"] = PEOPLE.get(k, k)
                c["pose"] = "neutral"
                c["label"] = k
            else:
                c["pose"] = None
            cells.append(c)
    return cells


if __name__ == "__main__":
    kind, out = sys.argv[1], sys.argv[2]
    names = sys.argv[3].split(",") if len(sys.argv) > 3 else ["man50", "woman50"]
    json.dump({"cells": people(names)}, open(out, "w"))


def sheet(names, azs, W=1000, H=1000, dist=None, el=4, tgt_y=None):
    """one body per row-less sheet: len(azs) columns, one body only (names[0])"""
    return None
