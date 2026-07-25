"""Shared helpers for capturing Playwright failure artifacts.

On any failing route the smoke scripts save, into
``$PLAYWRIGHT_ARTIFACTS_DIR`` (default ``/tmp/browser/playwright-artifacts``):

  - ``<slug>.png``  — full-viewport screenshot at the moment of failure
  - ``<slug>.zip``  — Playwright trace (DOM + network + console + screenshots)
  - ``<slug>.webm`` — video of the session (when the context recorded one)

Set ``PLAYWRIGHT_ARTIFACTS=off`` to disable capture entirely (useful in CI when
disk is scarce). Set ``PLAYWRIGHT_ARTIFACTS_ON_PASS=1`` to keep artifacts for
passing routes too.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

ENABLED = os.environ.get("PLAYWRIGHT_ARTIFACTS", "on").lower() != "off"
KEEP_ON_PASS = os.environ.get("PLAYWRIGHT_ARTIFACTS_ON_PASS", "0") == "1"
ARTIFACTS_DIR = Path(
    os.environ.get("PLAYWRIGHT_ARTIFACTS_DIR", "/tmp/browser/playwright-artifacts")
)


def slugify(text: str) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "_", text).strip("_")
    return s or "root"


def artifact_dir(script_name: str) -> Path:
    d = ARTIFACTS_DIR / script_name
    if ENABLED:
        d.mkdir(parents=True, exist_ok=True)
    return d


def context_options(script_name: str, slug: str) -> dict:
    """Kwargs to pass to ``browser.new_context`` for video recording."""
    if not ENABLED:
        return {}
    d = artifact_dir(script_name) / "videos" / slug
    d.mkdir(parents=True, exist_ok=True)
    return {"record_video_dir": str(d), "record_video_size": {"width": 1280, "height": 900}}


async def start_trace(context) -> bool:
    if not ENABLED:
        return False
    try:
        await context.tracing.start(screenshots=True, snapshots=True, sources=True)
        return True
    except Exception:
        return False


async def start_trace_chunk(context) -> bool:
    if not ENABLED:
        return False
    try:
        await context.tracing.start_chunk()
        return True
    except Exception:
        return False


async def save_on_failure(
    script_name: str,
    slug: str,
    page,
    context,
    status: str,
    *,
    chunked: bool = False,
) -> dict:
    """Persist screenshot/trace/video for ``page``. Returns artifact paths."""
    if not ENABLED:
        return {}
    keep = status == "FAIL" or KEEP_ON_PASS
    out: dict[str, str] = {}
    d = artifact_dir(script_name)
    trace_path = d / f"{slug}.trace.zip"
    png_path = d / f"{slug}.png"
    try:
        if chunked:
            await context.tracing.stop_chunk(path=str(trace_path) if keep else None)
        else:
            await context.tracing.stop(path=str(trace_path) if keep else None)
        if keep and trace_path.exists():
            out["trace"] = str(trace_path)
    except Exception:
        pass
    if keep and page is not None:
        try:
            await page.screenshot(path=str(png_path))
            out["screenshot"] = str(png_path)
        except Exception:
            pass
    # Video: resolve after page/context is closed by caller.
    return out


async def finalize_video(script_name: str, slug: str, page, status: str) -> str | None:
    """Move the recorded video (if any) next to the other artifacts."""
    if not ENABLED:
        return None
    keep = status == "FAIL" or KEEP_ON_PASS
    try:
        video = page.video
        if video is None:
            return None
        src = await video.path()
        if not src:
            return None
        target = artifact_dir(script_name) / f"{slug}.webm"
        if keep:
            try:
                os.replace(src, target)
                return str(target)
            except OSError:
                return src
        else:
            try:
                os.remove(src)
            except OSError:
                pass
            return None
    except Exception:
        return None