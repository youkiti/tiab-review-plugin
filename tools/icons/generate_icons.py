#!/usr/bin/env python3
"""拡張機能アイコンの生成スクリプト

SR ツール群 3 拡張で共通の意匠「角丸スクエア + 縦グラデーション + 白の 2 文字略号」を生成する。
**このファイルは 3 リポジトリに同一内容で置く**（片方だけ直すと意匠がずれる）。

    sr-query-builder-plugin   水色  「QB」
    tiab-review-plugin        緑    「Ti」
    sr-data-extraction-plugin ピンク「DE」

使い方（リポジトリのルートで実行。プリセットはディレクトリ名から自動判定される）:

    pip install pillow
    python tools/icons/generate_icons.py

出力先は src/icons/icon16.png / icon48.png / icon128.png。

意匠の由来:
    もとは sr-query-builder-plugin の tools/icons/generate-icons.ps1（PowerShell + System.Drawing）。
    Windows でしか動かない・3 拡張のうち 1 つにしか無い、という 2 点を解消するため Pillow へ移植した。
    移植にあたり PowerShell 版の出力と突き合わせ、128px で平均差 0.6%（残差はほぼ輪郭 1px の
    アンチエイリアス差）まで一致させてある。

四隅は必ず透明にすること:
    tiab-review-plugin の旧アイコンは角丸の外側が不透明の黒（#010101）で塗られており、
    Chrome のツールバー・拡張機能一覧・ウェブストアで黒い縁として見えていた。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# --- シリーズ意匠（3 リポジトリ共通。変えると 3 拡張の見た目が揃わなくなる） ---
SUPERSAMPLE = 8  # スーパーサンプリング倍率
RADIUS_RATIO = 0.20  # 角丸半径 / 辺長
TEXT_WIDTH_RATIO = 0.62  # 字形の外接矩形の幅 / 辺長
TOP_FACTOR = 1.12  # 上端色 = 基準色 × 1.12
BOTTOM_FACTOR = 0.88  # 下端色 = 基準色 × 0.88
DEFAULT_SIZES = (16, 48, 128)

# 拡張ごとの略号と基準色（グラデーションの中間色にあたる）
PRESETS: dict[str, tuple[str, str]] = {
    "sr-query-builder-plugin": ("QB", "#54B7D1"),
    "tiab-review-plugin": ("Ti", "#8CC43F"),
    "sr-data-extraction-plugin": ("DE", "#E9318F"),
}

# 太字サンセリフの候補（上から順に探す）。フォントは同梱せず、環境にあるものを使う。
#
# PowerShell 版は Arial Bold（Windows 同梱）を使っていた。Linux で最も字形が近いのは FreeSans Bold
# （Helvetica 系）で、特に Q のテールの突き出し量が Arial とほぼ一致する。Liberation Sans は Arial と
# メトリック互換だが Q のテールが深く、'QB' の字形が 12% ほど縦長になるので後段に置く。
FONT_CANDIDATES = (
    "C:/Windows/Fonts/arialbd.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
)


def parse_color(text: str) -> tuple[int, int, int]:
    """#RRGGBB → (R, G, B)"""
    h = text.lstrip("#")
    if len(h) != 6:
        raise ValueError(f"色は #RRGGBB 形式で指定する: {text}")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def shade(color: tuple[int, int, int], factor: float) -> tuple[int, int, int]:
    """基準色の明度を factor 倍する（0〜255 でクランプ）"""
    return tuple(max(0, min(255, round(c * factor))) for c in color)  # type: ignore[return-value]


def find_font() -> Path:
    for path in FONT_CANDIDATES:
        if Path(path).is_file():
            return Path(path)
    raise FileNotFoundError(
        "太字サンセリフが見つからない。FONT_CANDIDATES にフォントのパスを追加すること"
    )


def detect_preset() -> str | None:
    """スクリプトの置き場所（リポジトリのディレクトリ名）からプリセットを判定する"""
    for parent in Path(__file__).resolve().parents:
        if parent.name in PRESETS:
            return parent.name
    return None


def vertical_gradient(n: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    """上端 top → 下端 bottom の縦方向グラデーション"""
    grad = Image.new("RGB", (1, n))
    px = grad.load()
    for y in range(n):
        t = y / (n - 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return grad.resize((n, n), Image.NEAREST)


def ink_bbox(font: ImageFont.FreeTypeFont, text: str) -> tuple[int, int, int, int]:
    """実際に描画される字形の外接矩形（サイドベアリングを含まない）を、描画原点基準で返す。

    `font.getbbox()` は左右のサイドベアリングを含む送り幅ベースの矩形を返すため、
    PowerShell 版の `GraphicsPath.GetBounds()`（＝字形そのものの外接矩形）とは一致しない。
    そのまま使うと文字が 5% ほど小さくなる。
    """
    pad = font.size
    canvas = Image.new("L", (font.size * 4 + pad * 2, font.size * 4 + pad * 2), 0)
    ImageDraw.Draw(canvas).text((pad, pad), text, font=font, fill=255)
    box = canvas.getbbox()
    return (box[0] - pad, box[1] - pad, box[2] - pad, box[3] - pad)


def fit_font(
    font_path: Path, text: str, target_width: float
) -> tuple[ImageFont.FreeTypeFont, tuple[int, int, int, int]]:
    """字形の外接矩形の幅が target_width になるフォントサイズを求める。

    PowerShell 版は文字をパス化して「外接矩形の幅 = 辺長の 62%」へ拡大縮小する。
    こちらはラスタライズなので、拡大縮小ではなくフォントサイズ自体を合わせる（再標本化を避ける）。
    """
    probe = 200
    font = ImageFont.truetype(str(font_path), probe)
    box = ink_bbox(font, text)
    size = max(1, round(probe * target_width / (box[2] - box[0])))

    # 丸めで 1px ずれることがあるので、目標幅を超えない最大サイズへ詰める
    while size > 1:
        font = ImageFont.truetype(str(font_path), size)
        box = ink_bbox(font, text)
        if box[2] - box[0] <= target_width:
            break
        size -= 1
    return font, box


def render(size: int, text: str, base: tuple[int, int, int], font_path: Path) -> Image.Image:
    """1 サイズぶんのアイコンを描く。小サイズでも輪郭が滑らかになるよう 8 倍で描いてから縮小する。"""
    n = size * SUPERSAMPLE

    # 背景: 角丸スクエア + 縦方向グラデーション。
    #
    # RGB は角丸の外側にも塗っておき、形はアルファだけで作る。透明部分の RGB を黒のまま残すと、
    # 縮小時の補間で黒がフチへにじみ出て輪郭が黒ずむ。
    mask = Image.new("L", (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, n - 1, n - 1), radius=n * RADIUS_RATIO, fill=255)
    icon = vertical_gradient(n, shade(base, TOP_FACTOR), shade(base, BOTTOM_FACTOR)).convert("RGBA")
    icon.putalpha(mask)

    # 文字: 白・太字。字形の外接矩形で中央に置く（光学的中央合わせ）
    font, box = fit_font(font_path, text, n * TEXT_WIDTH_RATIO)
    tw, th = box[2] - box[0], box[3] - box[1]
    layer = Image.new("RGBA", (n, n), (255, 255, 255, 0))
    ImageDraw.Draw(layer).text(
        ((n - tw) / 2 - box[0], (n - th) / 2 - box[1]), text, font=font, fill=(255, 255, 255, 255)
    )
    icon = Image.alpha_composite(icon, layer)

    # 目標サイズへ縮小。整数倍のスーパーサンプリングなので面積平均（BOX）が本来の解決方法。
    # LANCZOS / BICUBIC は負のローブでリンギングが出て、角丸の外側に薄いアルファが残る。
    return icon.resize((size, size), Image.BOX)


def main(argv: list[str] | None = None) -> int:
    default_preset = detect_preset()
    parser = argparse.ArgumentParser(description="拡張機能アイコンを生成する")
    parser.add_argument(
        "--preset",
        choices=sorted(PRESETS),
        default=default_preset,
        help="拡張ごとの略号と基準色。既定はスクリプトの置き場所から自動判定",
    )
    parser.add_argument("--out-dir", type=Path, default=Path("src/icons"), help="出力先ディレクトリ")
    parser.add_argument("--text", help="アイコンに描く 2 文字略号（プリセットを上書き）")
    parser.add_argument("--base-color", help="基準色 #RRGGBB（プリセットを上書き）")
    parser.add_argument("--sizes", type=int, nargs="+", default=list(DEFAULT_SIZES), help="生成するサイズ")
    args = parser.parse_args(argv)

    preset_text, preset_color = PRESETS.get(args.preset or "", (None, None))
    text = args.text or preset_text
    color = args.base_color or preset_color
    if not text or not color:
        parser.error("プリセットを自動判定できなかった。--preset か --text/--base-color を指定すること")

    base = parse_color(color)
    font_path = find_font()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    print(f"略号={text} 基準色={color} フォント={font_path}")
    for size in args.sizes:
        path = args.out_dir / f"icon{size}.png"
        render(size, text, base, font_path).save(path)
        print(f"生成: {path} ({size}x{size})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
