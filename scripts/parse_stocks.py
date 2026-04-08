"""
Parse NSECM.xml (and optionally BSECM.xml) and extract every EQ-series equity row
into a compact JSON file consumed by the React app.

Output schema (one entry per stock):
    { "t": <TokenNo>, "s": <Symbol>, "x": <Exchange>, "ls": <LotSize>, "d": <Desc> }

Usage:
    python scripts/parse_stocks.py
"""

import xml.etree.ElementTree as ET
import json
import os
import sys

# Where to look for source XML files (first existing wins)
NSECM_PATHS = [
    r"D:\MTClient\MTClient\AppData\Contract\NSECM.xml",
    r"C:\Users\SMARTTOUCH\Downloads\NSECM.xml",
    r"C:\Users\SMARTTOUCH\Downloads\MTClient\NSECM.xml",
    r"D:\het-projs\stockalert\StockMarketAlertSystem\backend\data\NSECM.xml",
    "NSECM.xml",
]

BSECM_PATHS = [
    r"D:\MTClient\MTClient\AppData\Contract\BSECM.xml",
    r"C:\Users\SMARTTOUCH\Downloads\BSECM.xml",
    r"C:\Users\SMARTTOUCH\Downloads\MTClient\BSECM.xml",
    "BSECM.xml",
]

# Output file (relative to project root)
OUT_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "src",
    "stocks_nsecm.json",
)


def find_path(paths):
    for p in paths:
        if os.path.exists(p) and os.path.getsize(p) > 1024:
            return p
    return None


def parse_cm_xml(xml_path, tag_suffix, accepted_series=("EQ",)):
    """Stream-parse a cash-market XML and yield equity rows."""
    rows = []
    print(f"  Parsing {xml_path} ({os.path.getsize(xml_path) // (1024 * 1024)} MB)...")

    context = ET.iterparse(xml_path, events=("end",))
    seen = 0
    for event, elem in context:
        # Tags can be namespaced (e.g. "{ns}NSECM")
        local = elem.tag.split("}")[-1]
        if local == tag_suffix:
            data = {}
            for child in elem:
                tag = child.tag.split("}")[-1]
                data[tag] = (child.text or "").strip()

            series = data.get("Series", "")
            if series in accepted_series:
                rows.append(
                    {
                        "t": data.get("TokenNo"),
                        "s": data.get("Symbol"),
                        "x": data.get("Exchange") or tag_suffix,
                        "ls": int(data.get("LotSize") or 1),
                        "d": data.get("SymbolDesc") or data.get("SymbolDescription") or "",
                    }
                )
                seen += 1
                if seen % 500 == 0:
                    print(f"    extracted {seen} rows...")
            elem.clear()
    return rows


def main():
    all_rows = []

    nse_path = find_path(NSECM_PATHS)
    if nse_path:
        all_rows.extend(parse_cm_xml(nse_path, "NSECM"))
    else:
        print("  Warning: no NSECM.xml found in known paths.", file=sys.stderr)

    bse_path = find_path(BSECM_PATHS)
    if bse_path:
        # On BSE, the regular equity series is "A" / "B" / "T". Accept the common ones.
        all_rows.extend(parse_cm_xml(bse_path, "BSECM", accepted_series=("A", "B", "T")))
    else:
        print("  Note: no BSECM.xml found (skipping BSE stocks).", file=sys.stderr)

    # Sort for stable diffs
    all_rows.sort(key=lambda r: (r["x"] or "", r["s"] or ""))

    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(all_rows, f, separators=(",", ":"))

    print(f"\nWrote {len(all_rows)} equity rows -> {OUT_FILE}")


if __name__ == "__main__":
    main()
