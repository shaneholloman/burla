"""Builds the tarball nodes download from their head at boot.

Nodes never fetch code from GitHub: the head is the single source of node
code in every mode. The tar contains `node_service/`, `client/`, and
`main_service/` laid out exactly as `/opt/burla` expects. All three are
required because workers reinstall `/opt/burla/client`, whose wheel build
vendors main_service and node_service (see client/hatch_build.py).
"""

import io
import subprocess
import tarfile
from importlib.util import find_spec
from pathlib import Path

from main_service import CURRENT_BURLA_VERSION

SERVICE_DIRS = ("node_service", "client", "main_service")
# Extracted to /opt/burla/burla_source; the startup script logs its content.
STAMP_FILENAME = "burla_source"


def _checkout_root() -> Path | None:
    # In a source checkout this file is <root>/main_service/src/main_service/
    # node_source.py; installed from the wheel it sits in site-packages, where
    # no client project exists above it. The checkout wins when both apply,
    # matching how the head itself resolves main_service (see the client's
    # `_main_service_pythonpath`). Depth-guarded because flat `--target`
    # installs (worker environments) have no parents[3].
    parents = Path(__file__).resolve().parents
    if len(parents) > 3 and (parents[3] / "client" / "pyproject.toml").exists():
        return parents[3]
    return None


def _git(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args], cwd=root, capture_output=True, text=True, check=True
    )
    return result.stdout


def _checkout_members(root: Path) -> tuple[list[tuple[str, Path]], str]:
    listed = _git(
        root,
        *("ls-files", "--cached", "--others", "--exclude-standard"),
        *("--", *SERVICE_DIRS),
    ).splitlines()
    # The built dashboard assets are gitignored in the checkout but required
    # on nodes: workers rebuild the client wheel there, and its build hook
    # needs static/index.html (`make remote-dev` builds the frontend first).
    static = root / "main_service" / "src" / "main_service" / "static"
    static_files = [str(p.relative_to(root)) for p in static.rglob("*") if p.is_file()]
    paths = sorted(set(listed) | set(static_files))
    # --cached also lists files deleted from the working tree.
    members = [(path, root / path) for path in paths if (root / path).is_file()]

    sha = _git(root, "rev-parse", "--short", "HEAD").strip()
    dirty = _git(root, "status", "--porcelain", "--", *SERVICE_DIRS).strip()
    return members, f"{sha}+uncommitted" if dirty else sha


def _installed_members() -> tuple[list[tuple[str, Path]], str]:
    main_service_pkg = Path(__file__).resolve().parent
    burla_pkg = Path(find_spec("burla").origin).parent
    node_service_pkg = Path(find_spec("node_service").origin).parent
    # Project files (pyproject.toml etc.) are not part of any importable
    # package, so the wheel vendors them here (see client/hatch_build.py).
    project_files = main_service_pkg / "_node_source_files"
    members = [
        ("main_service/src/main_service", main_service_pkg),
        ("node_service/src/node_service", node_service_pkg),
        ("client/src/burla", burla_pkg),
        ("node_service/pyproject.toml", project_files / "node_service" / "pyproject.toml"),
        ("client/pyproject.toml", project_files / "client" / "pyproject.toml"),
        ("client/hatch_build.py", project_files / "client" / "hatch_build.py"),
    ]
    return members, f"burla=={CURRENT_BURLA_VERSION}"


def _skip_pycache(member: tarfile.TarInfo) -> tarfile.TarInfo | None:
    return None if "__pycache__" in member.name else member


def build_node_source_tarball() -> bytes:
    root = _checkout_root()
    members, stamp = _checkout_members(root) if root else _installed_members()

    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
        for arcname, path in members:
            tar.add(path, arcname=arcname, filter=_skip_pycache)
        stamp_bytes = f"{stamp}\n".encode()
        stamp_info = tarfile.TarInfo(STAMP_FILENAME)
        stamp_info.size = len(stamp_bytes)
        tar.addfile(stamp_info, io.BytesIO(stamp_bytes))
    return buffer.getvalue()
