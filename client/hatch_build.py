import os
import shutil
import subprocess
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    def initialize(self, version: str, build_data: dict) -> None:
        root = Path(self.root)
        source = root.parent / "main_service" / "src" / "main_service"
        if not source.exists():
            source = root / "main_service"

        # Absent when only `client/` is available, which is how local-dev workers
        # install burla (they bind-mount the client dir alone and never run a
        # head). Forcing a missing path makes hatchling fail the whole build.
        if source.exists():
            static = source / "static"
            if not (static / "index.html").exists():
                frontend = source.parent.parent / "frontend"
                env = os.environ.copy()
                env["VITE_SYNCFUSION_LICENSE_KEY"] = ""
                subprocess.run(["npm", "ci"], cwd=frontend, env=env, check=True)
                subprocess.run(
                    ["npm", "run", "build"], cwd=frontend, env=env, check=True
                )
                for path in static.iterdir():
                    if path.name != "login.html.j2":
                        if path.is_dir():
                            shutil.rmtree(path)
                        else:
                            path.unlink()
                shutil.copytree(frontend / "dist", static, dirs_exist_ok=True)
            build_data["force_include"][str(source)] = "main_service"

        # Heads serve booting nodes their code (GET /v1/node-source), so an
        # installed head also needs node_service, plus the project files nodes
        # use to reinstall node_service + client from the served tree.
        node_project = root.parent / "node_service"
        if not (node_project / "src" / "node_service").exists():
            node_project = root / "node_service"  # sdist tree
        node_pkg = node_project / "src" / "node_service"
        if node_pkg.exists():
            if self.target_name == "sdist":
                # Project layout, and no remapping of this project's own
                # pyproject.toml / hatch_build.py: force_include relocates
                # files, and moving pyproject.toml out of the sdist root makes
                # the sdist unbuildable. Wheels built from the sdist re-enter
                # this hook and vendor everything from these paths.
                build_data["force_include"][str(node_pkg)] = (
                    "node_service/src/node_service"
                )
                build_data["force_include"][str(node_project / "pyproject.toml")] = (
                    "node_service/pyproject.toml"
                )
            else:
                vendored = "main_service/_node_source_files"
                build_data["force_include"].update(
                    {
                        str(node_pkg): "node_service",
                        str(node_project / "pyproject.toml"): (
                            f"{vendored}/node_service/pyproject.toml"
                        ),
                        str(root / "pyproject.toml"): (
                            f"{vendored}/client/pyproject.toml"
                        ),
                        str(root / "hatch_build.py"): (
                            f"{vendored}/client/hatch_build.py"
                        ),
                    }
                )
